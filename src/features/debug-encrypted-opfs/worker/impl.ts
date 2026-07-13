/* eslint-disable local-rules/enforce-dependency-directions -- This read-only debug worker intentionally traverses exact persisted EncryptedOpfs DTOs so audits are not distorted by domain mapping. */
import type {
  EncryptedOpfsCommitDto,
  EncryptedOpfsDirectoryEntryDto,
  EncryptedOpfsDirectoryIndexPageDto,
  EncryptedOpfsDirectoryInodeDto,
  EncryptedOpfsFileExtentPageDto,
  EncryptedOpfsFileInodeDto,
  EncryptedOpfsInodeIndexPageDto,
} from '@/00-storage/00-dto/encrypted-opfs.dto';
import type { EncryptedOpfsInspectionReader } from '@/00-storage/service/encrypted-opfs';
import {
  encryptedOpfsInspectionOverviewSchema,
  encryptedOpfsPhysicalObjectPageSchema,
  persistedDtoSchemasByRecordKind,
  type EncryptedOpfsInspectedObjectView,
  type EncryptedOpfsIntegrityScanResult,
  type EncryptedOpfsNamespaceResult,
  type IEncryptedOpfsInspectionWorker,
} from './types';

type InodeReference = {
  readonly nodeId: string;
  readonly inodeObjectId: string;
};

type LoadedObject = NonNullable<Awaited<ReturnType<EncryptedOpfsInspectionReader['inspectObject']>>>;

export function createEncryptedOpfsInspectionWorker(): IEncryptedOpfsInspectionWorker {
  let reader: EncryptedOpfsInspectionReader | undefined;
  let operationGeneration = 0;

  function requireReader(): EncryptedOpfsInspectionReader {
    if (reader === undefined) {
      throw new Error('EncryptedOpfs inspection worker is not configured');
    }
    return reader;
  }

  function beginOperation(): { readonly generation: number } {
    operationGeneration += 1;
    return { generation: operationGeneration };
  }

  function assertOperationActive({ generation }: { generation: number }): void {
    if (generation !== operationGeneration) {
      throw new DOMException('EncryptedOpfs inspection operation was cancelled', 'AbortError');
    }
  }

  async function inspectValidatedObject({
    objectId,
    binaryPayloadPreviewByteLength,
  }: {
    objectId: string;
    binaryPayloadPreviewByteLength: number;
  }): Promise<EncryptedOpfsInspectedObjectView | undefined> {
    const object = await requireReader().inspectObject({
      objectId,
      binaryPayloadPreviewByteLength,
    });
    if (object === undefined) {
      return undefined;
    }
    const parsed = parsePersistedDto({ object });
    return {
      object: {
        ...object,
        physicalPath: [...object.physicalPath],
        envelope: {
          ...object.envelope,
          nonceBytes: [...object.envelope.nonceBytes],
        },
        record: {
          ...object.record,
          binaryPayloadPreviewBytes: [...object.record.binaryPayloadPreviewBytes],
        },
      },
      validation: parsed.validation,
      references: parsed.references,
    };
  }

  return {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the positional Comlink boundary declared by IEncryptedOpfsInspectionWorker.
    async configure(nextReader) {
      reader = nextReader;
    },

    async readOverview() {
      return encryptedOpfsInspectionOverviewSchema.parse(await requireReader().readOverview());
    },

    async listPhysicalObjects({ cursor, limit }) {
      return encryptedOpfsPhysicalObjectPageSchema.parse(
        await requireReader().listPhysicalObjects({ cursor, limit }),
      );
    },

    inspectObject: inspectValidatedObject,

    async readNamespace({ maximumEntryCount }) {
      if (!Number.isSafeInteger(maximumEntryCount) || maximumEntryCount < 1 || maximumEntryCount > 100_000) {
        throw new Error('EncryptedOpfs namespace inspection limit is invalid');
      }
      const operation = beginOperation();
      const overview = encryptedOpfsInspectionOverviewSchema.parse(await requireReader().readOverview());
      const issues: string[] = [];
      const inodeReferences = await collectInodeReferences({
        rootObjectId: overview.activeCommit.inodeIndexRootObjectId,
        operation,
        issues,
      });
      const inodeObjects = new Map<string, LoadedObject>();
      for (const reference of inodeReferences.values()) {
        assertOperationActive(operation);
        const object = await requireReader().inspectObject({
          objectId: reference.inodeObjectId,
          binaryPayloadPreviewByteLength: 0,
        });
        if (object === undefined) {
          issues.push(`Missing inode object ${reference.inodeObjectId} for node ${reference.nodeId}`);
          continue;
        }
        inodeObjects.set(reference.nodeId, object);
      }

      const entries: Array<EncryptedOpfsNamespaceResult['entries'][number]> = [];
      const visitedDirectories = new Set<string>();
      let truncated = false;

      async function visitNode({ nodeId, path, name }: {
        nodeId: string;
        path: string;
        name: string;
      }): Promise<void> {
        assertOperationActive(operation);
        if (entries.length >= maximumEntryCount) {
          truncated = true;
          return;
        }
        const reference = inodeReferences.get(nodeId);
        const object = inodeObjects.get(nodeId);
        if (reference === undefined || object === undefined) {
          issues.push(`Namespace node is absent from the inode index: ${nodeId}`);
          return;
        }
        switch (object.record.kind) {
        case 'file_inode': {
          const inode = persistedDtoSchemasByRecordKind.file_inode.parse(object.record.metadata);
          entries.push({
            path,
            name,
            kind: 'file',
            nodeId,
            inodeObjectId: reference.inodeObjectId,
            revision: inode.revision,
            size: inode.size,
            storage: inode.storage.type,
          });
          return;
        }
        case 'directory_inode': {
          const inode = persistedDtoSchemasByRecordKind.directory_inode.parse(object.record.metadata);
          entries.push({
            path,
            name,
            kind: 'directory',
            nodeId,
            inodeObjectId: reference.inodeObjectId,
            revision: inode.revision,
            size: undefined,
            storage: inode.storage.type,
          });
          if (visitedDirectories.has(nodeId)) {
            issues.push(`Directory cycle detected at ${path}`);
            return;
          }
          visitedDirectories.add(nodeId);
          const childEntries = await readDirectoryEntries({ inode, operation, issues });
          for (const child of childEntries) {
            if (truncated) break;
            const childPath = path === '/' ? `/${child.name}` : `${path}/${child.name}`;
            await visitNode({ nodeId: child.nodeId, path: childPath, name: child.name });
          }
          return;
        }
        case 'symlink_inode': {
          const inode = persistedDtoSchemasByRecordKind.symlink_inode.parse(object.record.metadata);
          entries.push({
            path,
            name,
            kind: 'symlink',
            nodeId,
            inodeObjectId: reference.inodeObjectId,
            revision: inode.revision,
            size: undefined,
            storage: `target:${inode.target}`,
          });
          return;
        }
        default:
          issues.push(`Inode index references non-inode record ${object.record.kind}: ${reference.inodeObjectId}`);
        }
      }

      await visitNode({
        nodeId: overview.activeCommit.rootDirectoryNodeId,
        path: '/',
        name: '/',
      });
      return { entries, truncated, issues };
    },

    async runIntegrityScan() {
      const operation = beginOperation();
      const overview = encryptedOpfsInspectionOverviewSchema.parse(await requireReader().readOverview());
      const issues: string[] = [];
      const recordKindCounts: Record<string, number> = {};
      const inspectedCache = new Map<string, EncryptedOpfsInspectedObjectView | undefined>();
      const globallyCounted = new Set<string>();
      let totalBinaryPayloadBytes = 0;

      async function scanRoots({ rootObjectIds, scope }: {
        rootObjectIds: readonly string[];
        scope: 'active' | 'fallback';
      }): Promise<Set<string>> {
        const reachable = new Set<string>();
        const pending = [...rootObjectIds];
        while (pending.length > 0) {
          assertOperationActive(operation);
          const objectId = pending.pop();
          if (objectId === undefined || reachable.has(objectId)) continue;
          reachable.add(objectId);

          let inspected = inspectedCache.get(objectId);
          if (!inspectedCache.has(objectId)) {
            inspected = await inspectValidatedObject({
              objectId,
              binaryPayloadPreviewByteLength: 0,
            });
            inspectedCache.set(objectId, inspected);
          }
          if (inspected === undefined) {
            issues.push(`${scope} reference is missing: ${objectId}`);
            continue;
          }

          if (!globallyCounted.has(objectId)) {
            globallyCounted.add(objectId);
            const kind = inspected.object.record.kind;
            recordKindCounts[kind] = (recordKindCounts[kind] ?? 0) + 1;
            totalBinaryPayloadBytes += inspected.object.record.binaryPayloadByteLength;
            switch (inspected.validation.status) {
            case 'valid':
              break;
            case 'invalid':
              issues.push(`${scope} ${objectId}: ${inspected.validation.errorMessage}`);
              break;
            default: {
              const _ex: never = inspected.validation;
              throw new Error(`Unhandled validation result: ${String(_ex)}`);
            }
            }
          }
          for (const reference of inspected.references) {
            pending.push(reference.objectId);
          }
        }
        return reachable;
      }

      const activeReachable = await scanRoots({
        rootObjectIds: [overview.activeCommitObjectId],
        scope: 'active',
      });
      const fallbackRootObjectIds = overview.superblockSlots.flatMap(slot => {
        switch (slot.status) {
        case 'valid':
          return slot.selected || slot.value.activeCommitObjectId === overview.activeCommitObjectId
            ? []
            : [slot.value.activeCommitObjectId];
        case 'missing':
        case 'invalid':
        case 'unsupported':
          return [];
        default: {
          const _ex: never = slot;
          return _ex;
        }
        }
      });
      const fallbackReachable = await scanRoots({
        rootObjectIds: fallbackRootObjectIds,
        scope: 'fallback',
      });
      const fallbackOnlyObjectIds = [...fallbackReachable]
        .filter(objectId => !activeReachable.has(objectId))
        .sort();
      const protectedReachable = new Set([...activeReachable, ...fallbackReachable]);

      const physicalObjectIds: string[] = [];
      const ignoredPhysicalPaths = new Set<string>();
      let cursor: string | undefined;
      do {
        assertOperationActive(operation);
        const page = encryptedOpfsPhysicalObjectPageSchema.parse(
          await requireReader().listPhysicalObjects({ cursor, limit: 500 }),
        );
        physicalObjectIds.push(...page.entries.map(entry => entry.objectId));
        for (const path of page.ignoredPhysicalPaths) ignoredPhysicalPaths.add(path);
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      return {
        activeCommitObjectId: overview.activeCommitObjectId,
        activeReachableObjectCount: activeReachable.size,
        fallbackReachableObjectCount: fallbackReachable.size,
        reachableObjectCount: protectedReachable.size,
        fallbackOnlyObjectIds,
        physicalObjectCount: physicalObjectIds.length,
        orphanObjectIds: physicalObjectIds
          .filter(objectId => !protectedReachable.has(objectId))
          .sort(),
        ignoredPhysicalPaths: [...ignoredPhysicalPaths].sort(),
        recordKindCounts,
        totalBinaryPayloadBytes,
        issues,
      } satisfies EncryptedOpfsIntegrityScanResult;
    },

    async cancelCurrentOperation() {
      operationGeneration += 1;
    },
  };

  async function collectInodeReferences({
    rootObjectId,
    operation,
    issues,
  }: {
    rootObjectId: string;
    operation: { readonly generation: number };
    issues: string[];
  }): Promise<Map<string, InodeReference>> {
    const result = new Map<string, InodeReference>();
    const pending = [rootObjectId];
    const visited = new Set<string>();
    while (pending.length > 0) {
      assertOperationActive(operation);
      const objectId = pending.pop();
      if (objectId === undefined || visited.has(objectId)) continue;
      visited.add(objectId);
      const object = await requireReader().inspectObject({
        objectId,
        binaryPayloadPreviewByteLength: 0,
      });
      if (object === undefined) {
        issues.push(`Missing inode index page: ${objectId}`);
        continue;
      }
      if (object.record.kind !== 'inode_index_page') {
        issues.push(`Expected inode index page, received ${object.record.kind}: ${objectId}`);
        continue;
      }
      const page = persistedDtoSchemasByRecordKind.inode_index_page.parse(object.record.metadata);
      switch (page.type) {
      case 'leaf':
        for (const entry of page.entries) {
          result.set(entry.nodeId, {
            nodeId: entry.nodeId,
            inodeObjectId: entry.inodeObjectId,
          });
        }
        break;
      case 'branch':
        for (const child of page.children) pending.push(child.childPageObjectId);
        break;
      default: {
        const _ex: never = page;
        throw new Error(`Unhandled inode index page: ${String(_ex)}`);
      }
      }
    }
    return result;
  }

  async function readDirectoryEntries({
    inode,
    operation,
    issues,
  }: {
    inode: EncryptedOpfsDirectoryInodeDto;
    operation: { readonly generation: number };
    issues: string[];
  }): Promise<readonly EncryptedOpfsDirectoryEntryDto[]> {
    switch (inode.storage.type) {
    case 'inline':
      return inode.storage.entries;
    case 'indexed': {
      const entries: EncryptedOpfsDirectoryEntryDto[] = [];
      const pending = [inode.storage.directoryIndexRootObjectId];
      const visited = new Set<string>();
      while (pending.length > 0) {
        assertOperationActive(operation);
        const objectId = pending.pop();
        if (objectId === undefined || visited.has(objectId)) continue;
        visited.add(objectId);
        const object = await requireReader().inspectObject({
          objectId,
          binaryPayloadPreviewByteLength: 0,
        });
        if (object === undefined) {
          issues.push(`Missing directory index page: ${objectId}`);
          continue;
        }
        if (object.record.kind !== 'directory_index_page') {
          issues.push(`Expected directory index page, received ${object.record.kind}: ${objectId}`);
          continue;
        }
        const page = persistedDtoSchemasByRecordKind.directory_index_page.parse(object.record.metadata);
        switch (page.type) {
        case 'leaf':
          entries.push(...page.entries);
          break;
        case 'branch':
          for (const child of page.children) pending.push(child.childPageObjectId);
          break;
        default: {
          const _ex: never = page;
          throw new Error(`Unhandled directory index page: ${String(_ex)}`);
        }
        }
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      return entries;
    }
    default: {
      const _ex: never = inode.storage;
      throw new Error(`Unhandled directory storage: ${String(_ex)}`);
    }
    }
  }
}

function parsePersistedDto({ object }: {
  object: LoadedObject;
}): {
  readonly validation: EncryptedOpfsInspectedObjectView['validation'];
  readonly references: EncryptedOpfsInspectedObjectView['references'];
} {
  try {
    const schema = getPersistedDtoSchema({ kind: object.record.kind });
    const persistedDto = schema.parse(object.record.metadata);
    return {
      validation: { status: 'valid', persistedDto },
      references: deriveReferences({ kind: object.record.kind, persistedDto }),
    };
  } catch (error) {
    return {
      validation: {
        status: 'invalid',
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      references: [],
    };
  }
}

function getPersistedDtoSchema({ kind }: { kind: string }) {
  switch (kind) {
  case 'commit': return persistedDtoSchemasByRecordKind.commit;
  case 'inode_index_page': return persistedDtoSchemasByRecordKind.inode_index_page;
  case 'file_inode': return persistedDtoSchemasByRecordKind.file_inode;
  case 'directory_inode': return persistedDtoSchemasByRecordKind.directory_inode;
  case 'symlink_inode': return persistedDtoSchemasByRecordKind.symlink_inode;
  case 'directory_index_page': return persistedDtoSchemasByRecordKind.directory_index_page;
  case 'file_extent_page': return persistedDtoSchemasByRecordKind.file_extent_page;
  case 'file_chunk': return persistedDtoSchemasByRecordKind.file_chunk;
  case 'superblock': return persistedDtoSchemasByRecordKind.superblock;
  default:
    throw new Error(`Unsupported EncryptedOpfs record kind: ${kind}`);
  }
}

function deriveReferences({ kind, persistedDto }: {
  kind: string;
  persistedDto: unknown;
}): EncryptedOpfsInspectedObjectView['references'] {
  switch (kind) {
  case 'commit': {
    const dto = persistedDto as EncryptedOpfsCommitDto;
    return [{ relation: 'inode index root', objectId: dto.inodeIndexRootObjectId }];
  }
  case 'inode_index_page': {
    const dto = persistedDto as EncryptedOpfsInodeIndexPageDto;
    switch (dto.type) {
    case 'leaf':
      return dto.entries.map(entry => ({ relation: `inode:${entry.nodeId}`, objectId: entry.inodeObjectId }));
    case 'branch':
      return dto.children.map(child => ({ relation: `child<=${child.upperBoundNodeId}`, objectId: child.childPageObjectId }));
    default: {
      const _ex: never = dto;
      throw new Error(`Unhandled inode index page: ${String(_ex)}`);
    }
    }
  }
  case 'file_inode': {
    const dto = persistedDto as EncryptedOpfsFileInodeDto;
    switch (dto.storage.type) {
    case 'inline': return [];
    case 'extents': return [{ relation: 'extent index root', objectId: dto.storage.extentIndexRootObjectId }];
    default: {
      const _ex: never = dto.storage;
      throw new Error(`Unhandled file storage: ${String(_ex)}`);
    }
    }
  }
  case 'directory_inode': {
    const dto = persistedDto as EncryptedOpfsDirectoryInodeDto;
    switch (dto.storage.type) {
    case 'inline': return [];
    case 'indexed': return [{ relation: 'directory index root', objectId: dto.storage.directoryIndexRootObjectId }];
    default: {
      const _ex: never = dto.storage;
      throw new Error(`Unhandled directory storage: ${String(_ex)}`);
    }
    }
  }
  case 'file_extent_page': {
    const dto = persistedDto as EncryptedOpfsFileExtentPageDto;
    switch (dto.type) {
    case 'leaf':
      return dto.extents.map(extent => ({ relation: `chunk:${String(extent.chunkIndex)}`, objectId: extent.chunkObjectId }));
    case 'branch':
      return dto.children.map(child => ({ relation: `child<=${String(child.upperBoundChunkIndex)}`, objectId: child.childPageObjectId }));
    default: {
      const _ex: never = dto;
      throw new Error(`Unhandled extent page: ${String(_ex)}`);
    }
    }
  }
  case 'directory_index_page': {
    const dto = persistedDto as EncryptedOpfsDirectoryIndexPageDto;
    switch (dto.type) {
    case 'leaf': return [];
    case 'branch':
      return dto.children.map(child => ({ relation: `child<=${child.upperBoundName}`, objectId: child.childPageObjectId }));
    default: {
      const _ex: never = dto;
      throw new Error(`Unhandled directory index page: ${String(_ex)}`);
    }
    }
  }
  case 'symlink_inode':
    return [];
  case 'file_chunk':
  case 'superblock':
    return [];
  default:
    return [];
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  deriveReferences,
  parsePersistedDto,
};
