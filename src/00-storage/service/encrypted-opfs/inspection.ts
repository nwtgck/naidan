import {
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
import { readEncryptedOpfsDescriptor } from './format/descriptor-store';
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
  readonly superblockSlots: readonly EncryptedOpfsSuperblockSlotInspection[];
  readonly activeSuperblock: EncryptedOpfsSuperblockDto;
  readonly activeCommitObjectId: string;
  readonly activeCommit: EncryptedOpfsCommitDto;
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
  const descriptor = await readEncryptedOpfsDescriptor({ backingStore });
  if (descriptor === undefined) {
    throw new Error('EncryptedOpfs descriptor is missing');
  }
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
        return {
          descriptor,
          superblockSlots,
          activeSuperblock: activeState.superblock,
          activeCommitObjectId: activeState.commitObjectId,
          activeCommit: activeState.commit,
        };
      },

      async listPhysicalObjects({ cursor, limit }) {
        assertOpen();
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
          throw new Error('EncryptedOpfs inspection object page limit must be between 1 and 1000');
        }
        const { entries, ignoredPhysicalPaths } = await listPhysicalObjects({ backingStore });
        const startIndex = cursor === undefined
          ? 0
          : entries.findIndex(entry => entry.objectId > cursor);
        const resolvedStartIndex = startIndex < 0 ? entries.length : startIndex;
        const pageEntries = entries.slice(resolvedStartIndex, resolvedStartIndex + limit);
        const lastEntry = pageEntries.at(-1);
        return {
          entries: pageEntries,
          nextCursor: resolvedStartIndex + pageEntries.length < entries.length
            ? lastEntry?.objectId
            : undefined,
          ignoredPhysicalPaths,
        };
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
      inspections.push({ slot, status: 'valid', selected, physicalPath, value });
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

async function listPhysicalObjects({ backingStore }: {
  backingStore: NativeOpfsEncryptedOpfsBackingStore;
}): Promise<{
  readonly entries: readonly EncryptedOpfsPhysicalObjectEntry[];
  readonly ignoredPhysicalPaths: readonly string[];
}> {
  const entries: EncryptedOpfsPhysicalObjectEntry[] = [];
  const ignoredPhysicalPaths: string[] = [];
  for await (const shardEntry of backingStore.list({ path: ['objects'] })) {
    const shardPath = `objects/${shardEntry.name}`;
    if (shardEntry.kind !== 'directory' || !/^[0-9a-f]{2}$/u.test(shardEntry.name)) {
      ignoredPhysicalPaths.push(shardPath);
      continue;
    }
    for await (const objectEntry of backingStore.list({ path: ['objects', shardEntry.name] })) {
      const objectPath = `${shardPath}/${objectEntry.name}`;
      if (objectEntry.kind !== 'file' || !objectEntry.name.endsWith('.eopfs')) {
        ignoredPhysicalPaths.push(objectPath);
        continue;
      }
      const objectId = objectEntry.name.slice(0, -'.eopfs'.length);
      try {
        decodeEncryptedOpfsObjectId({ objectId });
        if (getEncryptedOpfsObjectShard({ objectId }) !== shardEntry.name) {
          ignoredPhysicalPaths.push(objectPath);
          continue;
        }
      } catch {
        ignoredPhysicalPaths.push(objectPath);
        continue;
      }
      entries.push({
        objectId,
        physicalPath: ['objects', shardEntry.name, objectEntry.name],
      });
    }
  }
  entries.sort((left, right) => left.objectId.localeCompare(right.objectId));
  ignoredPhysicalPaths.sort();
  return { entries, ignoredPhysicalPaths };
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
