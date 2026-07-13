import {
  EncryptedOpfsDescriptorSchemaDto,
  EncryptedOpfsSuperblockSchemaDto,
  type EncryptedOpfsCommitDto,
  type EncryptedOpfsDescriptorDto,
  type EncryptedOpfsSuperblockDto,
} from '@/00-storage/00-dto/encrypted-opfs.dto';
import { NativeOpfsEncryptedOpfsBackingStore } from './backing-store/native-opfs-backing-store';
import { importEncryptedOpfsRootKey } from './crypto/object-crypto';
import {
  EncryptedOpfsCorruptionError,
  EncryptedOpfsUnsupportedFormatError,
} from './errors';
import { createEncryptedOpfsRuntime } from './file-system/runtime';
import { acquireEncryptedOpfsSessionLease } from './file-system/maintenance-lock';
import { DEFAULT_ENCRYPTED_OPFS_POLICY } from './file-system/policy';
import { validateEncryptedOpfsStableId } from './id';
import { decodeEncryptedOpfsObjectEnvelope } from './format/object-envelope';
import {
  decodeEncryptedOpfsObjectId,
  getEncryptedOpfsObjectShard,
} from './object-store/object-id';

export type EncryptedOpfsSuperblockSlotInspection =
  | {
      readonly slot: 0 | 1;
      readonly status: 'missing';
      readonly selected: false;
      readonly physicalPath: readonly string[];
    }
  | {
      readonly slot: 0 | 1;
      readonly status: 'valid';
      readonly selected: boolean;
      readonly physicalPath: readonly string[];
      readonly value: EncryptedOpfsSuperblockDto;
      readonly persistedDto: unknown;
    }
  | {
      readonly slot: 0 | 1;
      readonly status: 'invalid' | 'unsupported';
      readonly selected: false;
      readonly physicalPath: readonly string[];
      readonly errorMessage: string;
    };

export type EncryptedOpfsInspectionOverview = {
  readonly descriptor: EncryptedOpfsDescriptorDto;
  readonly persistedDescriptorDto: unknown;
  readonly superblockSlots: readonly EncryptedOpfsSuperblockSlotInspection[];
  readonly activeSuperblock: EncryptedOpfsSuperblockDto;
  readonly activeCommitObjectId: string;
  readonly activeCommit: EncryptedOpfsCommitDto;
  readonly activeCommitPersistedDto: unknown;
};

export type EncryptedOpfsPhysicalObjectEntry = {
  readonly objectId: string;
  readonly physicalPath: readonly string[];
};

export type EncryptedOpfsPhysicalObjectPage = {
  readonly entries: readonly EncryptedOpfsPhysicalObjectEntry[];
  readonly nextCursor: string | undefined;
  readonly ignoredPhysicalPaths: readonly string[];
};

export type EncryptedOpfsInspectedObject = {
  readonly objectId: string;
  readonly physicalPath: readonly string[];
  readonly physicalByteLength: number;
  readonly envelope: {
    readonly formatVersion: number;
    readonly nonceBytes: readonly number[];
    readonly ciphertextByteLength: number;
  };
  readonly record: {
    readonly kind: string;
    readonly recordVersion: number;
    readonly metadata: unknown;
    readonly binaryPayloadByteLength: number;
    readonly binaryPayloadPreviewBytes: readonly number[];
    readonly binaryPayloadPreviewTruncated: boolean;
  };
};

export interface EncryptedOpfsInspectionReader {
  readOverview(): Promise<EncryptedOpfsInspectionOverview>;

  listPhysicalObjects({ cursor, limit }: {
    cursor: string | undefined;
    limit: number;
  }): Promise<EncryptedOpfsPhysicalObjectPage>;

  inspectObject({ objectId, binaryPayloadPreviewByteLength }: {
    objectId: string;
    binaryPayloadPreviewByteLength: number;
  }): Promise<EncryptedOpfsInspectedObject | undefined>;

  dispose(): Promise<void>;
}

export async function createEncryptedOpfsInspectionReader({
  backingDirectory,
  fileSystemRootKey,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
}): Promise<EncryptedOpfsInspectionReader> {
  const backingStore = new NativeOpfsEncryptedOpfsBackingStore({ root: backingDirectory });
  const descriptorInspection = await readDescriptorForInspection({ backingStore });
  const descriptor = descriptorInspection.value;
  const maintenanceLease = await acquireEncryptedOpfsSessionLease({
    fileSystemId: descriptor.fileSystemId,
  });
  try {
    const rootKey = await importEncryptedOpfsRootKey({ rawRootKey: fileSystemRootKey });
    const runtime = createEncryptedOpfsRuntime({
      backingStore,
      rootKey,
      fileSystemId: descriptor.fileSystemId,
      policy: DEFAULT_ENCRYPTED_OPFS_POLICY,
      now: () => Date.now(),
    });
    let disposed = false;

    function assertOpen(): void {
      if (disposed) {
        throw new Error('EncryptedOpfs inspection reader is closed');
      }
    }

    return {
      async readOverview() {
        assertOpen();
        const activeState = await runtime.core.loadActiveState();
        const superblockSlots = await inspectSuperblockSlots({
          backingStore,
          runtime,
          fileSystemId: descriptor.fileSystemId,
          selectedSuperblock: activeState.superblock,
        });
        const activeCommitRecord = await runtime.objectStore.read({
          objectId: activeState.commitObjectId,
        });
        if (activeCommitRecord === undefined || activeCommitRecord.kind !== 'commit') {
          throw new EncryptedOpfsCorruptionError({
            message: 'EncryptedOpfs active commit record is missing or has the wrong kind',
            cause: undefined,
          });
        }
        return {
          descriptor,
          persistedDescriptorDto: descriptorInspection.persistedDto,
          superblockSlots,
          activeSuperblock: activeState.superblock,
          activeCommitObjectId: activeState.commitObjectId,
          activeCommit: activeState.commit,
          activeCommitPersistedDto: activeCommitRecord.metadata,
        };
      },

      async listPhysicalObjects({ cursor, limit }) {
        assertOpen();
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
          throw new Error('EncryptedOpfs inspection object page limit must be between 1 and 1000');
        }
        return await listPhysicalObjectPage({ backingStore, cursor, limit });
      },

      async inspectObject({ objectId, binaryPayloadPreviewByteLength }) {
        assertOpen();
        decodeEncryptedOpfsObjectId({ objectId });
        if (
          !Number.isSafeInteger(binaryPayloadPreviewByteLength)
          || binaryPayloadPreviewByteLength < 0
          || binaryPayloadPreviewByteLength > 64 * 1024
        ) {
          throw new Error('EncryptedOpfs inspection payload preview length is invalid');
        }
        const physicalPath = getObjectPhysicalPath({ objectId });
        const physical = await backingStore.read({ path: physicalPath });
        if (physical === undefined) {
          return undefined;
        }
        const envelope = decodeEncryptedOpfsObjectEnvelope({ physical });
        const record = await runtime.objectStore.read({ objectId });
        if (record === undefined) {
          throw new EncryptedOpfsCorruptionError({
            message: `EncryptedOpfs object disappeared while being inspected: ${objectId}`,
            cause: undefined,
          });
        }
        const preview = record.binaryPayload.subarray(0, binaryPayloadPreviewByteLength);
        return {
          objectId,
          physicalPath,
          physicalByteLength: physical.byteLength,
          envelope: {
            formatVersion: envelope.formatVersion,
            nonceBytes: Array.from(envelope.nonce),
            ciphertextByteLength: envelope.ciphertext.byteLength,
          },
          record: {
            kind: record.kind,
            recordVersion: record.recordVersion,
            metadata: record.metadata,
            binaryPayloadByteLength: record.binaryPayload.byteLength,
            binaryPayloadPreviewBytes: Array.from(preview),
            binaryPayloadPreviewTruncated: preview.byteLength < record.binaryPayload.byteLength,
          },
        };
      },

      async dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        await maintenanceLease.release();
      },
    };
  } catch (error) {
    await maintenanceLease.release();
    throw error;
  }
}

async function inspectSuperblockSlots({
  backingStore,
  runtime,
  fileSystemId,
  selectedSuperblock,
}: {
  backingStore: NativeOpfsEncryptedOpfsBackingStore;
  runtime: ReturnType<typeof createEncryptedOpfsRuntime>;
  fileSystemId: string;
  selectedSuperblock: EncryptedOpfsSuperblockDto;
}): Promise<readonly EncryptedOpfsSuperblockSlotInspection[]> {
  const inspections: EncryptedOpfsSuperblockSlotInspection[] = [];
  for (const slot of [0, 1] as const) {
    const physicalPath = [`superblock-${String(slot)}.eopfs`] as const;
    const physical = await backingStore.read({ path: physicalPath });
    if (physical === undefined) {
      inspections.push({ slot, status: 'missing', selected: false, physicalPath });
      continue;
    }
    try {
      const record = await runtime.objectStore.readSuperblock({ slot });
      if (record === undefined) {
        inspections.push({ slot, status: 'missing', selected: false, physicalPath });
        continue;
      }
      switch (record.kind) {
      case 'superblock':
        break;
      case 'commit':
      case 'inode_index_page':
      case 'file_inode':
      case 'directory_inode':
      case 'symlink_inode':
      case 'directory_index_page':
      case 'file_extent_page':
      case 'file_chunk':
        throw new EncryptedOpfsUnsupportedFormatError({
          message: `EncryptedOpfs superblock slot ${String(slot)} has an unsupported record kind`,
        });
      default: {
        const _ex: never = record.kind;
        throw new Error(`Unhandled EncryptedOpfs record kind: ${String(_ex)}`);
      }
      }
      if (record.recordVersion !== 1) {
        throw new EncryptedOpfsUnsupportedFormatError({
          message: `EncryptedOpfs superblock record version is unsupported: ${String(record.recordVersion)}`,
        });
      }
      if (record.binaryPayload.byteLength !== 0) {
        throw new EncryptedOpfsCorruptionError({
          message: 'EncryptedOpfs superblock contains an unexpected binary payload',
          cause: undefined,
        });
      }
      const value = EncryptedOpfsSuperblockSchemaDto.parse(record.metadata);
      if (value.fileSystemId !== fileSystemId) {
        throw new EncryptedOpfsCorruptionError({
          message: 'EncryptedOpfs superblock fileSystemId does not match its descriptor',
          cause: undefined,
        });
      }
      const selected = value.sequence === selectedSuperblock.sequence
        && value.activeCommitObjectId === selectedSuperblock.activeCommitObjectId;
      inspections.push({
        slot,
        status: 'valid',
        selected,
        physicalPath,
        value,
        persistedDto: record.metadata,
      });
    } catch (error) {
      inspections.push({
        slot,
        status: error instanceof EncryptedOpfsUnsupportedFormatError ? 'unsupported' : 'invalid',
        selected: false,
        physicalPath,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return inspections;
}


/**
 * Reads the descriptor once and keeps both the exact JSON value and its
 * validated typed representation. Raw inspection must not display the Zod
 * output because object parsing may strip unknown persisted properties.
 */
async function readDescriptorForInspection({ backingStore }: {
  backingStore: NativeOpfsEncryptedOpfsBackingStore;
}): Promise<{
  readonly value: EncryptedOpfsDescriptorDto;
  readonly persistedDto: unknown;
}> {
  const bytes = await backingStore.read({ path: ['descriptor.json'] });
  if (bytes === undefined) {
    throw new Error('EncryptedOpfs descriptor is missing');
  }
  let persistedDto: unknown;
  try {
    persistedDto = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error('EncryptedOpfs descriptor is invalid UTF-8 JSON', { cause: error });
  }
  const value = EncryptedOpfsDescriptorSchemaDto.parse(persistedDto);
  validateEncryptedOpfsStableId({
    value: value.fileSystemId,
    fieldName: 'EncryptedOpfs fileSystemId',
  });
  return { value, persistedDto };
}

/**
 * Enumerates physical objects by shard and stops once one page is complete.
 * Splitting only the UI into pages while re-reading and sorting every object on
 * each request would still scale as a full-store scan. The opaque cursor keeps
 * both the shard and last object ID so later pages can resume from the physical
 * layout without materializing the entire object store.
 */
async function listPhysicalObjectPage({ backingStore, cursor, limit }: {
  backingStore: NativeOpfsEncryptedOpfsBackingStore;
  cursor: string | undefined;
  limit: number;
}): Promise<EncryptedOpfsPhysicalObjectPage> {
  const parsedCursor = cursor === undefined ? undefined : parsePhysicalObjectCursor({ cursor });
  const ignoredPhysicalPaths: string[] = [];
  const shardEntries = [];
  for await (const entry of backingStore.list({ path: ['objects'] })) {
    const physicalPath = `objects/${entry.name}`;
    if (entry.kind !== 'directory' || !/^[0-9a-f]{2}$/u.test(entry.name)) {
      ignoredPhysicalPaths.push(physicalPath);
      continue;
    }
    shardEntries.push(entry.name);
  }
  shardEntries.sort();

  const candidates: EncryptedOpfsPhysicalObjectEntry[] = [];
  for (const shard of shardEntries) {
    if (parsedCursor !== undefined && shard < parsedCursor.shard) {
      continue;
    }
    const objectEntries = [];
    for await (const entry of backingStore.list({ path: ['objects', shard] })) {
      objectEntries.push(entry);
    }
    objectEntries.sort((left, right) => comparePhysicalObjectNames({
      left: left.name,
      right: right.name,
    }));

    for (const objectEntry of objectEntries) {
      const objectPath = `objects/${shard}/${objectEntry.name}`;
      if (objectEntry.kind !== 'file' || !objectEntry.name.endsWith('.eopfs')) {
        ignoredPhysicalPaths.push(objectPath);
        continue;
      }
      const objectId = objectEntry.name.slice(0, -'.eopfs'.length);
      try {
        decodeEncryptedOpfsObjectId({ objectId });
        if (getEncryptedOpfsObjectShard({ objectId }) !== shard) {
          ignoredPhysicalPaths.push(objectPath);
          continue;
        }
      } catch {
        ignoredPhysicalPaths.push(objectPath);
        continue;
      }
      if (
        parsedCursor !== undefined
        && shard === parsedCursor.shard
        && comparePhysicalObjectNames({
          left: objectId,
          right: parsedCursor.objectId,
        }) <= 0
      ) {
        continue;
      }
      candidates.push({
        objectId,
        physicalPath: ['objects', shard, objectEntry.name],
      });
      if (candidates.length > limit) {
        break;
      }
    }
    if (candidates.length > limit) {
      break;
    }
  }

  ignoredPhysicalPaths.sort();
  const hasNextPage = candidates.length > limit;
  const entries = hasNextPage ? candidates.slice(0, limit) : candidates;
  const lastEntry = entries.at(-1);
  return {
    entries,
    nextCursor: hasNextPage && lastEntry !== undefined
      ? createPhysicalObjectCursor({ entry: lastEntry })
      : undefined,
    ignoredPhysicalPaths,
  };
}


/**
 * Physical pagination must use exactly the same locale-independent ordering
 * when sorting entries and applying a cursor. `localeCompare()` can order the
 * Base64URL alphabet differently from JavaScript's relational operators,
 * which can repeat or skip an object at a page boundary.
 */
function comparePhysicalObjectNames({ left, right }: {
  left: string;
  right: string;
}): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function createPhysicalObjectCursor({ entry }: {
  entry: EncryptedOpfsPhysicalObjectEntry;
}): string {
  const shard = entry.physicalPath[1];
  if (shard === undefined) {
    throw new Error('EncryptedOpfs physical object entry is missing its shard path');
  }
  return `${shard}/${entry.objectId}`;
}

function parsePhysicalObjectCursor({ cursor }: { cursor: string }): {
  readonly shard: string;
  readonly objectId: string;
} {
  const separator = cursor.indexOf('/');
  const shard = cursor.slice(0, separator);
  const objectId = cursor.slice(separator + 1);
  if (separator !== 2 || !/^[0-9a-f]{2}$/u.test(shard)) {
    throw new Error('EncryptedOpfs physical object cursor is invalid');
  }
  decodeEncryptedOpfsObjectId({ objectId });
  if (getEncryptedOpfsObjectShard({ objectId }) !== shard) {
    throw new Error('EncryptedOpfs physical object cursor shard does not match its object ID');
  }
  return { shard, objectId };
}

function getObjectPhysicalPath({ objectId }: {
  objectId: string;
}): readonly string[] {
  return [
    'objects',
    getEncryptedOpfsObjectShard({ objectId }),
    `${objectId}.eopfs`,
  ];
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
