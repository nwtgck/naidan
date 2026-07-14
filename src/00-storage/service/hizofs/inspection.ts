import {
  HizoFSDescriptorSchemaDto,
  HizoFSSuperblockSchemaDto,
  type HizoFSCommitDto,
  type HizoFSDescriptorDto,
  type HizoFSSuperblockDto,
} from '@/00-storage/00-dto/hizofs.dto';
import { NativeOpfsHizoFSBackingStore } from './backing-store/native-opfs-backing-store';
import {
  decryptHizoFSObject,
  importHizoFSRootKey,
} from './crypto/object-crypto';
import {
  HizoFSCorruptionError,
  HizoFSUnsupportedFormatError,
} from './errors';
import { createHizoFSRuntime } from './file-system/runtime';
import { acquireHizoFSSessionLease } from './file-system/maintenance-lock';
import { DEFAULT_HIZOFS_POLICY } from './file-system/policy';
import { validateHizoFSStableId } from './id';
import { decodeHizoFSObjectEnvelope } from './format/object-envelope';
import { decodeHizoFSRecord } from './format/record';
import {
  decodeHizoFSObjectId,
  getHizoFSObjectShard,
} from './object-store/object-id';

export type HizoFSBinarySlice = {
  readonly offset: number;
  readonly regionByteLength: number;
  readonly bytes: Uint8Array;
  readonly truncatedAfter: boolean;
};

export type HizoFSDecodedBinaryField = {
  readonly name: string;
  readonly offset: number;
  readonly byteLength: number;
  readonly rawBytes: Uint8Array;
  readonly encoding: 'ascii' | 'bytes' | 'uint8' | 'uint16_be' | 'uint32_be' | 'uint64_be';
  readonly interpretation: string;
};

export type HizoFSBinaryRecordInspection = {
  readonly persistedObject: {
    readonly bytes: HizoFSBinarySlice;
    readonly headerFields: readonly HizoFSDecodedBinaryField[];
    readonly ciphertextOffset: number;
    readonly ciphertextByteLength: number;
  };
  readonly decryptedRecord: {
    readonly bytes: HizoFSBinarySlice;
    readonly headerFields: readonly HizoFSDecodedBinaryField[];
    readonly metadataJson: {
      readonly bytes: HizoFSBinarySlice;
      readonly utf8Text: string | undefined;
    };
    readonly binaryPayload: HizoFSBinarySlice;
  };
};

export type HizoFSSuperblockSlotInspection =
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
      readonly value: HizoFSSuperblockDto;
      readonly persistedDto: unknown;
      readonly binary: HizoFSBinaryRecordInspection;
    }
  | {
      readonly slot: 0 | 1;
      readonly status: 'invalid' | 'unsupported';
      readonly selected: false;
      readonly physicalPath: readonly string[];
      readonly physicalBytes: HizoFSBinarySlice;
      readonly errorMessage: string;
    };

export type HizoFSInspectionOverview = {
  readonly descriptor: HizoFSDescriptorDto;
  readonly persistedDescriptorDto: unknown;
  readonly superblockSlots: readonly HizoFSSuperblockSlotInspection[];
  readonly activeSuperblock: HizoFSSuperblockDto;
  readonly activeCommitObjectId: string;
  readonly activeCommit: HizoFSCommitDto;
  readonly activeCommitPersistedDto: unknown;
};

export type HizoFSPhysicalObjectEntry = {
  readonly objectId: string;
  readonly physicalPath: readonly string[];
};

export type HizoFSPhysicalObjectPage = {
  readonly entries: readonly HizoFSPhysicalObjectEntry[];
  readonly nextCursor: string | undefined;
  readonly ignoredPhysicalPaths: readonly string[];
};

export type HizoFSInspectedObject = {
  readonly objectId: string;
  readonly physicalPath: readonly string[];
  readonly physicalByteLength: number;
  readonly binary: HizoFSBinaryRecordInspection;
  readonly record: {
    readonly kind: string;
    readonly recordVersion: number;
    readonly metadata: unknown;
    readonly binaryPayloadByteLength: number;
  };
};

export interface HizoFSInspectionReader {
  readOverview(): Promise<HizoFSInspectionOverview>;

  listPhysicalObjects({ cursor, limit }: {
    cursor: string | undefined;
    limit: number;
  }): Promise<HizoFSPhysicalObjectPage>;

  inspectObject({ objectId, binaryPreviewByteLength }: {
    objectId: string;
    binaryPreviewByteLength: number;
  }): Promise<HizoFSInspectedObject | undefined>;

  inspectSuperblockSlot({ slot, binaryPreviewByteLength }: {
    slot: 0 | 1;
    binaryPreviewByteLength: number;
  }): Promise<HizoFSSuperblockSlotInspection>;

  dispose(): Promise<void>;
}

export async function createHizoFSInspectionReader({
  backingDirectory,
  fileSystemRootKey,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
}): Promise<HizoFSInspectionReader> {
  const backingStore = new NativeOpfsHizoFSBackingStore({ root: backingDirectory });
  const descriptorInspection = await readDescriptorForInspection({ backingStore });
  const descriptor = descriptorInspection.value;
  const maintenanceLease = await acquireHizoFSSessionLease({
    fileSystemId: descriptor.fileSystemId,
  });
  try {
    const rootKey = await importHizoFSRootKey({ rawRootKey: fileSystemRootKey });
    const runtime = createHizoFSRuntime({
      backingStore,
      rootKey,
      fileSystemId: descriptor.fileSystemId,
      policy: DEFAULT_HIZOFS_POLICY,
      now: () => Date.now(),
    });
    let disposed = false;

    function assertOpen(): void {
      if (disposed) {
        throw new Error('HizoFS inspection reader is closed');
      }
    }

    return {
      async readOverview() {
        assertOpen();
        const activeState = await runtime.core.loadActiveState();
        const superblockSlots = await inspectSuperblockSlots({
          backingStore,
          rootKey,
          fileSystemId: descriptor.fileSystemId,
          selectedSuperblock: activeState.superblock,
          binaryPreviewByteLength: 0,
        });
        const activeCommitRecord = await runtime.objectStore.read({
          objectId: activeState.commitObjectId,
        });
        if (activeCommitRecord === undefined || activeCommitRecord.kind !== 'commit') {
          throw new HizoFSCorruptionError({
            message: 'HizoFS active commit record is missing or has the wrong kind',
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
          throw new Error('HizoFS inspection object page limit must be between 1 and 1000');
        }
        return await listPhysicalObjectPage({ backingStore, cursor, limit });
      },

      async inspectObject({ objectId, binaryPreviewByteLength }) {
        assertOpen();
        decodeHizoFSObjectId({ objectId });
        assertBinaryPreviewByteLength({ binaryPreviewByteLength });
        const physicalPath = getObjectPhysicalPath({ objectId });
        const physical = await backingStore.read({ path: physicalPath });
        if (physical === undefined) {
          return undefined;
        }
        const inspected = await inspectEncryptedRecordBinary({
          physical,
          rootKey,
          fileSystemId: descriptor.fileSystemId,
          objectIdentity: objectId,
          area: 'object',
          binaryPreviewByteLength,
        });
        return {
          objectId,
          physicalPath,
          physicalByteLength: physical.byteLength,
          binary: inspected.binary,
          record: {
            kind: inspected.record.kind,
            recordVersion: inspected.record.recordVersion,
            metadata: inspected.record.metadata,
            binaryPayloadByteLength: inspected.record.binaryPayload.byteLength,
          },
        };
      },

      async inspectSuperblockSlot({ slot, binaryPreviewByteLength }) {
        assertOpen();
        assertBinaryPreviewByteLength({ binaryPreviewByteLength });
        const activeState = await runtime.core.loadActiveState();
        return await inspectSuperblockSlot({
          backingStore,
          rootKey,
          fileSystemId: descriptor.fileSystemId,
          selectedSuperblock: activeState.superblock,
          slot,
          binaryPreviewByteLength,
        });
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


function assertBinaryPreviewByteLength({ binaryPreviewByteLength }: {
  binaryPreviewByteLength: number;
}): void {
  if (
    !Number.isSafeInteger(binaryPreviewByteLength)
    || binaryPreviewByteLength < 0
    || binaryPreviewByteLength > 64 * 1024
  ) {
    throw new Error('HizoFS inspection binary preview length is invalid');
  }
}

/**
 * Binary data remains byte-oriented across the inspection boundary.
 *
 * Persisted and decrypted bytes are never converted into JSON-shaped number
 * arrays because that would hide offsets, widths, endianness, and framing and
 * could make an inspection convenience look like the stored format. Only the
 * metadata range that is actually encoded as UTF-8 JSON is exposed separately
 * as a DTO by the worker and Workbench.
 */
async function inspectEncryptedRecordBinary({
  physical,
  rootKey,
  fileSystemId,
  objectIdentity,
  area,
  binaryPreviewByteLength,
}: {
  physical: Uint8Array;
  rootKey: CryptoKey;
  fileSystemId: string;
  objectIdentity: string;
  area: 'object' | 'superblock';
  binaryPreviewByteLength: number;
}): Promise<{
  readonly record: ReturnType<typeof decodeHizoFSRecord>;
  readonly binary: HizoFSBinaryRecordInspection;
}> {
  assertBinaryPreviewByteLength({ binaryPreviewByteLength });
  const envelope = decodeHizoFSObjectEnvelope({ physical });
  let plaintext: Uint8Array;
  try {
    plaintext = await decryptHizoFSObject({
      rootKey,
      fileSystemId,
      objectIdentity,
      area,
      nonce: envelope.nonce,
      ciphertext: envelope.ciphertext,
    });
  } catch (error) {
    throw new HizoFSCorruptionError({
      message: `HizoFS ${area} authentication failed`,
      cause: error,
    });
  }
  const record = decodeHizoFSRecord({ plaintext });
  const physicalView = new DataView(physical.buffer, physical.byteOffset, physical.byteLength);
  const plaintextView = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  const metadataByteLength = plaintextView.getUint32(4, false);
  const binaryPayloadByteLength = Number(plaintextView.getBigUint64(8, false));
  const metadataOffset = 16;
  const binaryPayloadOffset = metadataOffset + metadataByteLength;
  const metadataBytes = plaintext.slice(metadataOffset, binaryPayloadOffset);
  const metadataUtf8Text = new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes);
  const persistedPreviewByteLength = Math.max(32, binaryPreviewByteLength);
  const decryptedPreviewByteLength = Math.max(16, binaryPreviewByteLength);

  return {
    record,
    binary: {
      persistedObject: {
        bytes: createBinarySlice({
          source: physical,
          offset: 0,
          regionByteLength: physical.byteLength,
          previewByteLength: persistedPreviewByteLength,
        }),
        headerFields: [
          createDecodedBinaryField({
            name: 'magic',
            source: physical,
            offset: 0,
            byteLength: 8,
            encoding: 'ascii',
            interpretation: '"HIZOFS\\0\\0"',
          }),
          createDecodedBinaryField({
            name: 'formatVersion',
            source: physical,
            offset: 8,
            byteLength: 2,
            encoding: 'uint16_be',
            interpretation: String(envelope.formatVersion),
          }),
          createDecodedBinaryField({
            name: 'headerByteLength',
            source: physical,
            offset: 10,
            byteLength: 2,
            encoding: 'uint16_be',
            interpretation: `${String(physicalView.getUint16(10, false))} bytes`,
          }),
          createDecodedBinaryField({
            name: 'nonce',
            source: physical,
            offset: 12,
            byteLength: 12,
            encoding: 'bytes',
            interpretation: '12-byte AES-GCM nonce',
          }),
          createDecodedBinaryField({
            name: 'ciphertextByteLength',
            source: physical,
            offset: 24,
            byteLength: 8,
            encoding: 'uint64_be',
            interpretation: `${String(envelope.ciphertext.byteLength)} bytes including authentication tag`,
          }),
        ],
        ciphertextOffset: 32,
        ciphertextByteLength: envelope.ciphertext.byteLength,
      },
      decryptedRecord: {
        bytes: createBinarySlice({
          source: plaintext,
          offset: 0,
          regionByteLength: plaintext.byteLength,
          previewByteLength: decryptedPreviewByteLength,
        }),
        headerFields: [
          createDecodedBinaryField({
            name: 'recordKind',
            source: plaintext,
            offset: 0,
            byteLength: 1,
            encoding: 'uint8',
            interpretation: `${String(plaintext[0])} (${record.kind})`,
          }),
          createDecodedBinaryField({
            name: 'payloadEncoding',
            source: plaintext,
            offset: 1,
            byteLength: 1,
            encoding: 'uint8',
            interpretation: `${String(plaintext[1])} (identity)`,
          }),
          createDecodedBinaryField({
            name: 'recordVersion',
            source: plaintext,
            offset: 2,
            byteLength: 2,
            encoding: 'uint16_be',
            interpretation: String(record.recordVersion),
          }),
          createDecodedBinaryField({
            name: 'metadataJsonByteLength',
            source: plaintext,
            offset: 4,
            byteLength: 4,
            encoding: 'uint32_be',
            interpretation: `${String(metadataByteLength)} bytes`,
          }),
          createDecodedBinaryField({
            name: 'binaryPayloadByteLength',
            source: plaintext,
            offset: 8,
            byteLength: 8,
            encoding: 'uint64_be',
            interpretation: `${String(binaryPayloadByteLength)} bytes`,
          }),
        ],
        metadataJson: {
          bytes: createBinarySlice({
            source: plaintext,
            offset: metadataOffset,
            regionByteLength: metadataByteLength,
            previewByteLength: binaryPreviewByteLength,
          }),
          utf8Text: binaryPreviewByteLength >= metadataByteLength
            ? metadataUtf8Text
            : undefined,
        },
        binaryPayload: createBinarySlice({
          source: plaintext,
          offset: binaryPayloadOffset,
          regionByteLength: binaryPayloadByteLength,
          previewByteLength: binaryPreviewByteLength,
        }),
      },
    },
  };
}

function createBinarySlice({
  source,
  offset,
  regionByteLength,
  previewByteLength,
}: {
  source: Uint8Array;
  offset: number;
  regionByteLength: number;
  previewByteLength: number;
}): HizoFSBinarySlice {
  const actualPreviewByteLength = Math.min(regionByteLength, previewByteLength);
  return {
    offset,
    regionByteLength,
    bytes: source.slice(offset, offset + actualPreviewByteLength),
    truncatedAfter: actualPreviewByteLength < regionByteLength,
  };
}

function createDecodedBinaryField({
  name,
  source,
  offset,
  byteLength,
  encoding,
  interpretation,
}: {
  name: string;
  source: Uint8Array;
  offset: number;
  byteLength: number;
  encoding: HizoFSDecodedBinaryField['encoding'];
  interpretation: string;
}): HizoFSDecodedBinaryField {
  return {
    name,
    offset,
    byteLength,
    rawBytes: source.slice(offset, offset + byteLength),
    encoding,
    interpretation,
  };
}

async function inspectSuperblockSlots({
  backingStore,
  rootKey,
  fileSystemId,
  selectedSuperblock,
  binaryPreviewByteLength,
}: {
  backingStore: NativeOpfsHizoFSBackingStore;
  rootKey: CryptoKey;
  fileSystemId: string;
  selectedSuperblock: HizoFSSuperblockDto;
  binaryPreviewByteLength: number;
}): Promise<readonly HizoFSSuperblockSlotInspection[]> {
  const inspections: HizoFSSuperblockSlotInspection[] = [];
  for (const slot of [0, 1] as const) {
    inspections.push(await inspectSuperblockSlot({
      backingStore,
      rootKey,
      fileSystemId,
      selectedSuperblock,
      slot,
      binaryPreviewByteLength,
    }));
  }
  return inspections;
}

async function inspectSuperblockSlot({
  backingStore,
  rootKey,
  fileSystemId,
  selectedSuperblock,
  slot,
  binaryPreviewByteLength,
}: {
  backingStore: NativeOpfsHizoFSBackingStore;
  rootKey: CryptoKey;
  fileSystemId: string;
  selectedSuperblock: HizoFSSuperblockDto;
  slot: 0 | 1;
  binaryPreviewByteLength: number;
}): Promise<HizoFSSuperblockSlotInspection> {
  const physicalPath = [`superblock-${String(slot)}.enc`] as const;
  const physical = await backingStore.read({ path: physicalPath });
  if (physical === undefined) {
    return { slot, status: 'missing', selected: false, physicalPath };
  }
  try {
    const inspected = await inspectEncryptedRecordBinary({
      physical,
      rootKey,
      fileSystemId,
      objectIdentity: `superblock-${String(slot)}`,
      area: 'superblock',
      binaryPreviewByteLength,
    });
    const { record } = inspected;
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
      throw new HizoFSUnsupportedFormatError({
        message: `HizoFS superblock slot ${String(slot)} has an unsupported record kind`,
      });
    default: {
      const _ex: never = record.kind;
      throw new Error(`Unhandled HizoFS record kind: ${String(_ex)}`);
    }
    }
    if (record.recordVersion !== 1) {
      throw new HizoFSUnsupportedFormatError({
        message: `HizoFS superblock record version is unsupported: ${String(record.recordVersion)}`,
      });
    }
    if (record.binaryPayload.byteLength !== 0) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS superblock contains an unexpected binary payload',
        cause: undefined,
      });
    }
    const value = HizoFSSuperblockSchemaDto.parse(record.metadata);
    if (value.fileSystemId !== fileSystemId) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS superblock fileSystemId does not match its descriptor',
        cause: undefined,
      });
    }
    const selected = value.sequence === selectedSuperblock.sequence
      && value.activeCommitObjectId === selectedSuperblock.activeCommitObjectId;
    return {
      slot,
      status: 'valid',
      selected,
      physicalPath,
      value,
      persistedDto: record.metadata,
      binary: inspected.binary,
    };
  } catch (error) {
    return {
      slot,
      status: error instanceof HizoFSUnsupportedFormatError ? 'unsupported' : 'invalid',
      selected: false,
      physicalPath,
      physicalBytes: createBinarySlice({
        source: physical,
        offset: 0,
        regionByteLength: physical.byteLength,
        previewByteLength: Math.min(Math.max(32, binaryPreviewByteLength), physical.byteLength),
      }),
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}


/**
 * Reads the descriptor once and keeps both the exact JSON value and its
 * validated typed representation. Raw inspection must not display the Zod
 * output because object parsing may strip unknown persisted properties.
 */
async function readDescriptorForInspection({ backingStore }: {
  backingStore: NativeOpfsHizoFSBackingStore;
}): Promise<{
  readonly value: HizoFSDescriptorDto;
  readonly persistedDto: unknown;
}> {
  const bytes = await backingStore.read({ path: ['descriptor.json'] });
  if (bytes === undefined) {
    throw new Error('HizoFS descriptor is missing');
  }
  let persistedDto: unknown;
  try {
    persistedDto = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error('HizoFS descriptor is invalid UTF-8 JSON', { cause: error });
  }
  const value = HizoFSDescriptorSchemaDto.parse(persistedDto);
  validateHizoFSStableId({
    value: value.fileSystemId,
    fieldName: 'HizoFS fileSystemId',
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
  backingStore: NativeOpfsHizoFSBackingStore;
  cursor: string | undefined;
  limit: number;
}): Promise<HizoFSPhysicalObjectPage> {
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

  const candidates: HizoFSPhysicalObjectEntry[] = [];
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
      if (objectEntry.kind !== 'file' || !objectEntry.name.endsWith('.enc')) {
        ignoredPhysicalPaths.push(objectPath);
        continue;
      }
      const objectId = objectEntry.name.slice(0, -'.enc'.length);
      try {
        decodeHizoFSObjectId({ objectId });
        if (getHizoFSObjectShard({ objectId }) !== shard) {
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
  entry: HizoFSPhysicalObjectEntry;
}): string {
  const shard = entry.physicalPath[1];
  if (shard === undefined) {
    throw new Error('HizoFS physical object entry is missing its shard path');
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
    throw new Error('HizoFS physical object cursor is invalid');
  }
  decodeHizoFSObjectId({ objectId });
  if (getHizoFSObjectShard({ objectId }) !== shard) {
    throw new Error('HizoFS physical object cursor shard does not match its object ID');
  }
  return { shard, objectId };
}

function getObjectPhysicalPath({ objectId }: {
  objectId: string;
}): readonly string[] {
  return [
    'objects',
    getHizoFSObjectShard({ objectId }),
    `${objectId}.enc`,
  ];
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
