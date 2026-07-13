import {
  EncryptedOpfsDescriptorSchemaDto,
  EncryptedOpfsSuperblockSchemaDto,
  type EncryptedOpfsCommitDto,
  type EncryptedOpfsDescriptorDto,
  type EncryptedOpfsSuperblockDto,
} from '@/00-storage/00-dto/encrypted-opfs.dto';
import { NativeOpfsEncryptedOpfsBackingStore } from './backing-store/native-opfs-backing-store';
import {
  decryptEncryptedOpfsObject,
  importEncryptedOpfsRootKey,
} from './crypto/object-crypto';
import {
  EncryptedOpfsCorruptionError,
  EncryptedOpfsUnsupportedFormatError,
} from './errors';
import { createEncryptedOpfsRuntime } from './file-system/runtime';
import { acquireEncryptedOpfsSessionLease } from './file-system/maintenance-lock';
import { DEFAULT_ENCRYPTED_OPFS_POLICY } from './file-system/policy';
import { validateEncryptedOpfsStableId } from './id';
import { decodeEncryptedOpfsObjectEnvelope } from './format/object-envelope';
import { decodeEncryptedOpfsRecord } from './format/record';
import {
  decodeEncryptedOpfsObjectId,
  getEncryptedOpfsObjectShard,
} from './object-store/object-id';

export type EncryptedOpfsBinarySlice = {
  readonly offset: number;
  readonly regionByteLength: number;
  readonly bytes: Uint8Array;
  readonly truncatedAfter: boolean;
};

export type EncryptedOpfsDecodedBinaryField = {
  readonly name: string;
  readonly offset: number;
  readonly byteLength: number;
  readonly rawBytes: Uint8Array;
  readonly encoding: 'ascii' | 'bytes' | 'uint8' | 'uint16_be' | 'uint32_be' | 'uint64_be';
  readonly interpretation: string;
};

export type EncryptedOpfsBinaryRecordInspection = {
  readonly persistedObject: {
    readonly bytes: EncryptedOpfsBinarySlice;
    readonly headerFields: readonly EncryptedOpfsDecodedBinaryField[];
    readonly ciphertextOffset: number;
    readonly ciphertextByteLength: number;
  };
  readonly decryptedRecord: {
    readonly bytes: EncryptedOpfsBinarySlice;
    readonly headerFields: readonly EncryptedOpfsDecodedBinaryField[];
    readonly metadataJson: {
      readonly bytes: EncryptedOpfsBinarySlice;
      readonly utf8Text: string | undefined;
    };
    readonly binaryPayload: EncryptedOpfsBinarySlice;
  };
};

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
      readonly binary: EncryptedOpfsBinaryRecordInspection;
    }
  | {
      readonly slot: 0 | 1;
      readonly status: 'invalid' | 'unsupported';
      readonly selected: false;
      readonly physicalPath: readonly string[];
      readonly physicalBytes: EncryptedOpfsBinarySlice;
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
  readonly binary: EncryptedOpfsBinaryRecordInspection;
  readonly record: {
    readonly kind: string;
    readonly recordVersion: number;
    readonly metadata: unknown;
    readonly binaryPayloadByteLength: number;
  };
};

export interface EncryptedOpfsInspectionReader {
  readOverview(): Promise<EncryptedOpfsInspectionOverview>;

  listPhysicalObjects({ cursor, limit }: {
    cursor: string | undefined;
    limit: number;
  }): Promise<EncryptedOpfsPhysicalObjectPage>;

  inspectObject({ objectId, binaryPreviewByteLength }: {
    objectId: string;
    binaryPreviewByteLength: number;
  }): Promise<EncryptedOpfsInspectedObject | undefined>;

  inspectSuperblockSlot({ slot, binaryPreviewByteLength }: {
    slot: 0 | 1;
    binaryPreviewByteLength: number;
  }): Promise<EncryptedOpfsSuperblockSlotInspection>;

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
          rootKey,
          fileSystemId: descriptor.fileSystemId,
          selectedSuperblock: activeState.superblock,
          binaryPreviewByteLength: 0,
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

      async inspectObject({ objectId, binaryPreviewByteLength }) {
        assertOpen();
        decodeEncryptedOpfsObjectId({ objectId });
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
    throw new Error('EncryptedOpfs inspection binary preview length is invalid');
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
  readonly record: ReturnType<typeof decodeEncryptedOpfsRecord>;
  readonly binary: EncryptedOpfsBinaryRecordInspection;
}> {
  assertBinaryPreviewByteLength({ binaryPreviewByteLength });
  const envelope = decodeEncryptedOpfsObjectEnvelope({ physical });
  let plaintext: Uint8Array;
  try {
    plaintext = await decryptEncryptedOpfsObject({
      rootKey,
      fileSystemId,
      objectIdentity,
      area,
      nonce: envelope.nonce,
      ciphertext: envelope.ciphertext,
    });
  } catch (error) {
    throw new EncryptedOpfsCorruptionError({
      message: `EncryptedOpfs ${area} authentication failed`,
      cause: error,
    });
  }
  const record = decodeEncryptedOpfsRecord({ plaintext });
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
            interpretation: '"ENCOPFS\\0"',
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
}): EncryptedOpfsBinarySlice {
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
  encoding: EncryptedOpfsDecodedBinaryField['encoding'];
  interpretation: string;
}): EncryptedOpfsDecodedBinaryField {
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
  backingStore: NativeOpfsEncryptedOpfsBackingStore;
  rootKey: CryptoKey;
  fileSystemId: string;
  selectedSuperblock: EncryptedOpfsSuperblockDto;
  binaryPreviewByteLength: number;
}): Promise<readonly EncryptedOpfsSuperblockSlotInspection[]> {
  const inspections: EncryptedOpfsSuperblockSlotInspection[] = [];
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
  backingStore: NativeOpfsEncryptedOpfsBackingStore;
  rootKey: CryptoKey;
  fileSystemId: string;
  selectedSuperblock: EncryptedOpfsSuperblockDto;
  slot: 0 | 1;
  binaryPreviewByteLength: number;
}): Promise<EncryptedOpfsSuperblockSlotInspection> {
  const physicalPath = [`superblock-${String(slot)}.eopfs`] as const;
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
      status: error instanceof EncryptedOpfsUnsupportedFormatError ? 'unsupported' : 'invalid',
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
