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
import { compareEncryptedOpfsStrings } from '@/00-storage/service/encrypted-opfs/file-system/ordering';
import {
  encryptedOpfsInspectionOverviewSchema,
  encryptedOpfsPhysicalObjectPageSchema,
  persistedDtoSchemasByRecordKind,
  type EncryptedOpfsInspectedObjectView,
  type EncryptedOpfsIntegrityScanResult,
  type EncryptedOpfsNamespaceResult,
  type EncryptedOpfsResolvedNodeView,
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
    binaryPreviewByteLength,
  }: {
    objectId: string;
    binaryPreviewByteLength: number;
  }): Promise<EncryptedOpfsInspectedObjectView | undefined> {
    const object = await requireReader().inspectObject({
      objectId,
      binaryPreviewByteLength,
    });
    if (object === undefined) {
      return undefined;
    }
    const parsed = parsePersistedDto({ object });
    return {
      object: cloneInspectedObject({ object }),
      validation: parsed.validation,
      references: parsed.references,
      rootDirectoryEntryPoint: parsed.rootDirectoryEntryPoint,
    };
  }

  /**
   * Resolves a node exactly as the selected commit does while retaining every
   * persisted lookup page as navigation provenance. The Workbench may enter
   * here through a shallow root shortcut, but no inode-index layer is collapsed
   * into an invented high-level filesystem model.
   */
  async function readResolvedNode({
    commitObjectId,
    nodeId,
    logicalPath,
    maximumDirectoryEntryCount,
  }: {
    commitObjectId: string;
    nodeId: string;
    logicalPath: string;
    maximumDirectoryEntryCount: number;
  }): Promise<EncryptedOpfsResolvedNodeView> {
    if (
      !Number.isSafeInteger(maximumDirectoryEntryCount)
      || maximumDirectoryEntryCount < 1
      || maximumDirectoryEntryCount > 100_000
    ) {
      throw new Error('EncryptedOpfs directory traversal limit is invalid');
    }
    const commitObject = await requireReader().inspectObject({
      objectId: commitObjectId,
      binaryPreviewByteLength: 0,
    });
    if (commitObject === undefined) {
      throw new Error(`EncryptedOpfs commit object is missing: ${commitObjectId}`);
    }
    if (commitObject.record.kind !== 'commit') {
      throw new Error(`Expected commit record, received ${commitObject.record.kind}: ${commitObjectId}`);
    }
    const commit = persistedDtoSchemasByRecordKind.commit.parse(commitObject.record.metadata);
    const lookup = await resolveInodeIndexLookup({
      rootObjectId: commit.inodeIndexRootObjectId,
      nodeId,
    });
    const inodeObject = await requireReader().inspectObject({
      objectId: lookup.inodeObjectId,
      binaryPreviewByteLength: 0,
    });
    if (inodeObject === undefined) {
      throw new Error(`EncryptedOpfs inode object is missing: ${lookup.inodeObjectId}`);
    }

    let inodeKind: EncryptedOpfsResolvedNodeView['inodeKind'];
    let inodePersistedDto: unknown;
    let directory: EncryptedOpfsResolvedNodeView['directory'];
    switch (inodeObject.record.kind) {
    case 'file_inode': {
      const inode = persistedDtoSchemasByRecordKind.file_inode.parse(inodeObject.record.metadata);
      if (inode.nodeId !== nodeId) {
        throw new Error(`EncryptedOpfs file inode nodeId does not match lookup: ${nodeId}`);
      }
      inodeKind = 'file';
      inodePersistedDto = inodeObject.record.metadata;
      directory = undefined;
      break;
    }
    case 'directory_inode': {
      const inode = persistedDtoSchemasByRecordKind.directory_inode.parse(inodeObject.record.metadata);
      if (inode.nodeId !== nodeId) {
        throw new Error(`EncryptedOpfs directory inode nodeId does not match lookup: ${nodeId}`);
      }
      inodeKind = 'directory';
      inodePersistedDto = inodeObject.record.metadata;
      directory = await readDirectoryEntriesForTraversal({
        inode,
        directoryInodeObjectId: lookup.inodeObjectId,
        maximumDirectoryEntryCount,
      });
      break;
    }
    case 'symlink_inode': {
      const inode = persistedDtoSchemasByRecordKind.symlink_inode.parse(inodeObject.record.metadata);
      if (inode.nodeId !== nodeId) {
        throw new Error(`EncryptedOpfs symlink inode nodeId does not match lookup: ${nodeId}`);
      }
      inodeKind = 'symlink';
      inodePersistedDto = inodeObject.record.metadata;
      directory = undefined;
      break;
    }
    case 'commit':
    case 'inode_index_page':
    case 'directory_index_page':
    case 'file_extent_page':
    case 'file_chunk':
    case 'superblock':
      throw new Error(`Inode index resolved a non-inode record: ${inodeObject.record.kind}`);
    default:
      throw new Error(`Unhandled EncryptedOpfs record kind: ${inodeObject.record.kind}`);
    }

    return {
      commitObjectId,
      commitRevision: commit.revision,
      rootDirectoryNodeId: commit.rootDirectoryNodeId,
      inodeIndexRootObjectId: commit.inodeIndexRootObjectId,
      nodeId,
      logicalPath,
      inodeIndexLookup: lookup.steps,
      inodeObjectId: lookup.inodeObjectId,
      inodeKind,
      inodePersistedDto,
      binaryPayloadByteLength: inodeObject.record.binaryPayloadByteLength,
      directory,
    };
  }

  async function resolveInodeIndexLookup({ rootObjectId, nodeId }: {
    rootObjectId: string;
    nodeId: string;
  }): Promise<{
    readonly inodeObjectId: string;
    readonly steps: EncryptedOpfsResolvedNodeView['inodeIndexLookup'];
  }> {
    const steps: Array<EncryptedOpfsResolvedNodeView['inodeIndexLookup'][number]> = [];
    const visited = new Set<string>();
    let pageObjectId = rootObjectId;
    while (true) {
      if (visited.has(pageObjectId)) {
        throw new Error('EncryptedOpfs inode index contains a page cycle');
      }
      visited.add(pageObjectId);
      const object = await requireReader().inspectObject({
        objectId: pageObjectId,
        binaryPreviewByteLength: 0,
      });
      if (object === undefined) {
        throw new Error(`EncryptedOpfs inode index page is missing: ${pageObjectId}`);
      }
      if (object.record.kind !== 'inode_index_page') {
        throw new Error(`Expected inode index page, received ${object.record.kind}: ${pageObjectId}`);
      }
      const page = persistedDtoSchemasByRecordKind.inode_index_page.parse(object.record.metadata);
      switch (page.type) {
      case 'leaf': {
        const entry = page.entries.find(candidate => compareEncryptedOpfsStrings({
          left: candidate.nodeId,
          right: nodeId,
        }) === 0);
        if (entry === undefined) {
          throw new Error(`EncryptedOpfs inode index does not contain node: ${nodeId}`);
        }
        steps.push({
          type: 'leaf',
          pageObjectId,
          inodeObjectId: entry.inodeObjectId,
        });
        return { inodeObjectId: entry.inodeObjectId, steps };
      }
      case 'branch': {
        const child = page.children.find(candidate => compareEncryptedOpfsStrings({
          left: nodeId,
          right: candidate.upperBoundNodeId,
        }) <= 0);
        if (child === undefined) {
          throw new Error(`EncryptedOpfs inode index branch does not cover node: ${nodeId}`);
        }
        steps.push({
          type: 'branch',
          pageObjectId,
          selectedChildPageObjectId: child.childPageObjectId,
          selectedUpperBoundNodeId: child.upperBoundNodeId,
        });
        pageObjectId = child.childPageObjectId;
        break;
      }
      default: {
        const _ex: never = page;
        throw new Error(`Unhandled inode index page: ${String(_ex)}`);
      }
      }
    }
  }

  async function readDirectoryEntriesForTraversal({
    inode,
    directoryInodeObjectId,
    maximumDirectoryEntryCount,
  }: {
    inode: EncryptedOpfsDirectoryInodeDto;
    directoryInodeObjectId: string;
    maximumDirectoryEntryCount: number;
  }): Promise<NonNullable<EncryptedOpfsResolvedNodeView['directory']>> {
    switch (inode.storage.type) {
    case 'inline': {
      const entries = inode.storage.entries.slice(0, maximumDirectoryEntryCount).map(entry => ({
        entry,
        source: {
          type: 'inline' as const,
          directoryInodeObjectId,
        },
      }));
      return {
        storageType: 'inline',
        directoryIndexRootObjectId: undefined,
        entries,
        truncated: entries.length < inode.storage.entries.length,
        issues: [],
      };
    }
    case 'indexed': {
      const entries: NonNullable<EncryptedOpfsResolvedNodeView['directory']>['entries'][number][] = [];
      const issues: string[] = [];
      const visited = new Set<string>();
      let truncated = false;
      const visitPage = async ({ pageObjectId }: { pageObjectId: string }): Promise<void> => {
        if (truncated) return;
        if (visited.has(pageObjectId)) {
          issues.push(`Directory index page cycle: ${pageObjectId}`);
          return;
        }
        visited.add(pageObjectId);
        const object = await requireReader().inspectObject({
          objectId: pageObjectId,
          binaryPreviewByteLength: 0,
        });
        if (object === undefined) {
          issues.push(`Missing directory index page: ${pageObjectId}`);
          return;
        }
        if (object.record.kind !== 'directory_index_page') {
          issues.push(`Expected directory index page, received ${object.record.kind}: ${pageObjectId}`);
          return;
        }
        const page = persistedDtoSchemasByRecordKind.directory_index_page.parse(object.record.metadata);
        switch (page.type) {
        case 'leaf':
          for (const entry of page.entries) {
            if (entries.length >= maximumDirectoryEntryCount) {
              truncated = true;
              break;
            }
            entries.push({
              entry,
              source: {
                type: 'indexed',
                directoryIndexPageObjectId: pageObjectId,
              },
            });
          }
          return;
        case 'branch':
          for (const child of page.children) {
            await visitPage({ pageObjectId: child.childPageObjectId });
            if (truncated) break;
          }
          return;
        default: {
          const _ex: never = page;
          throw new Error(`Unhandled directory index page: ${String(_ex)}`);
        }
        }
      };
      await visitPage({ pageObjectId: inode.storage.directoryIndexRootObjectId });
      return {
        storageType: 'indexed',
        directoryIndexRootObjectId: inode.storage.directoryIndexRootObjectId,
        entries,
        truncated,
        issues,
      };
    }
    default: {
      const _ex: never = inode.storage;
      throw new Error(`Unhandled directory storage: ${String(_ex)}`);
    }
    }
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

    readNode: readResolvedNode,

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
          binaryPreviewByteLength: 0,
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
              binaryPreviewByteLength: 0,
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
        binaryPreviewByteLength: 0,
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
          binaryPreviewByteLength: 0,
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

function cloneInspectedObject({ object }: { object: LoadedObject }): EncryptedOpfsInspectedObjectView['object'] {
  const cloneSlice = ({ slice }: {
    slice: LoadedObject['binary']['persistedObject']['bytes'];
  }) => ({
    ...slice,
    bytes: slice.bytes.slice(),
  });
  const cloneFields = ({ fields }: {
    fields: LoadedObject['binary']['persistedObject']['headerFields'];
  }) => fields.map(field => ({
    ...field,
    rawBytes: field.rawBytes.slice(),
  }));
  return {
    ...object,
    physicalPath: [...object.physicalPath],
    binary: {
      persistedObject: {
        ...object.binary.persistedObject,
        bytes: cloneSlice({ slice: object.binary.persistedObject.bytes }),
        headerFields: cloneFields({ fields: object.binary.persistedObject.headerFields }),
      },
      decryptedRecord: {
        ...object.binary.decryptedRecord,
        bytes: cloneSlice({ slice: object.binary.decryptedRecord.bytes }),
        headerFields: cloneFields({ fields: object.binary.decryptedRecord.headerFields }),
        metadataJson: {
          ...object.binary.decryptedRecord.metadataJson,
          bytes: cloneSlice({ slice: object.binary.decryptedRecord.metadataJson.bytes }),
        },
        binaryPayload: cloneSlice({ slice: object.binary.decryptedRecord.binaryPayload }),
      },
    },
    record: { ...object.record },
  };
}

function parsePersistedDto({ object }: {
  object: LoadedObject;
}): {
  readonly validation: EncryptedOpfsInspectedObjectView['validation'];
  readonly references: EncryptedOpfsInspectedObjectView['references'];
  readonly rootDirectoryEntryPoint: EncryptedOpfsInspectedObjectView['rootDirectoryEntryPoint'];
} {
  try {
    const schema = getPersistedDtoSchema({ kind: object.record.kind });
    const validation = schema.safeParse(object.record.metadata);
    if (!validation.success) {
      return {
        validation: {
          status: 'invalid',
          errorMessage: validation.error.message,
        },
        references: [],
        rootDirectoryEntryPoint: undefined,
      };
    }
    /**
     * Keep the record metadata itself as the Raw DTO view. Zod object parsing
     * may clone the value and strip unknown properties, which is appropriate
     * for normal consumption but would make a storage audit diverge from the
     * representation that was actually read from the encrypted record.
     * Parsed data is used only for validated reference traversal.
     */
    return {
      validation: { status: 'valid', persistedDto: object.record.metadata },
      references: deriveReferences({
        kind: object.record.kind,
        persistedDto: validation.data,
      }),
      rootDirectoryEntryPoint: object.record.kind === 'commit'
        ? {
          commitObjectId: object.objectId,
          revision: (validation.data as EncryptedOpfsCommitDto).revision,
          rootDirectoryNodeId: (validation.data as EncryptedOpfsCommitDto).rootDirectoryNodeId,
          inodeIndexRootObjectId: (validation.data as EncryptedOpfsCommitDto).inodeIndexRootObjectId,
        }
        : undefined,
    };
  } catch (error) {
    return {
      validation: {
        status: 'invalid',
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      references: [],
      rootDirectoryEntryPoint: undefined,
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
