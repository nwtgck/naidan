import {
  HizoFSDescriptorSchemaDto,
  HizoFSSuperblockSchemaDto,
  type HizoFSCommitDto,
  type HizoFSDescriptorDto,
  type HizoFSSuperblockDto,
} from '@/00-storage/00-dto/hizofs.dto';
import { NativeOpfsHizoFSBackingStore } from './backing-store/native-opfs-backing-store';
import {
  deriveHizoFSFileSystemId,
  importHizoFSRootKey,
} from './crypto/object-crypto';
import {
  HizoFSCorruptionError,
  HizoFSUnsupportedFormatError,
} from './errors';
import { createHizoFSRuntime } from './file-system/runtime';
import { loadHizoFSActiveStateFromStores } from './file-system/active-state';
import { acquireHizoFSResourceLease } from './file-system/maintenance-lock';
import { DEFAULT_HIZOFS_POLICY } from './file-system/policy';
import { HizoFSGarbageCollectionCheckpointStore, type HizoFSGarbageCollectionCheckpoint } from './garbage-collection-checkpoint';
import { decodeHizoFSRecord } from './format/record';
import { validateHizoFSObjectId } from './object-store/object-id';
import type { HizoFSObjectStore } from './object-store/object-store';
import {
  HIZOFS_HEAD_ENVELOPE_HEADER_BYTE_LENGTH,
  HIZOFS_RECORD_FRAME_HEADER_BYTE_LENGTH,
} from './segment-store/segment-format';
import { HIZOFS_AES_GCM_TAG_BYTE_LENGTH } from './segment-store/segment-crypto';
import {
  decodeHizoFSObjectReference,
  encodeHizoFSSegmentId,
} from './segment-store/object-reference';

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


export type HizoFSMaintenanceHealth = {
  readonly segmentIndexes: {
    readonly discoveredSegmentCount: number;
    readonly readableSegmentCount: number;
    readonly authenticatedIndexCount: number;
    readonly rebuiltMissingIndexCount: number;
    readonly rebuiltInvalidIndexCount: number;
  };
  readonly relocationMap:
    | {
        readonly status: 'valid';
        readonly sequence: number;
        readonly mappingCount: number;
      }
    | {
        readonly status: 'invalid';
        readonly errorMessage: string;
      };
  readonly garbageCollectionCheckpoint:
    | {
        readonly status: 'absent';
      }
    | {
        readonly status: 'valid';
        readonly checkpoint: HizoFSGarbageCollectionCheckpoint;
      }
    | {
        readonly status: 'invalid';
        readonly errorMessage: string;
      };
  readonly recoveryAssessment: {
    readonly status: 'healthy' | 'degraded' | 'manual_review_required';
    readonly reasons: readonly string[];
    readonly automaticRepairPerformed: false;
  };
};

export type HizoFSInspectionOverview = {
  readonly activeMode: 'current' | 'fallback_read_only';
  readonly descriptor: HizoFSDescriptorDto;
  readonly fileSystemId: string;
  readonly persistedDescriptorDto: unknown;
  readonly descriptorValidationError: string | undefined;
  readonly superblockSlots: readonly HizoFSSuperblockSlotInspection[];
  readonly activeSuperblock: HizoFSSuperblockDto;
  readonly activeCommitObjectId: string;
  readonly activeCommit: HizoFSCommitDto;
  readonly activeCommitPersistedDto: unknown;
  readonly maintenance: HizoFSMaintenanceHealth;
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


function errorMessage({ error }: { error: unknown }): string {
  return error instanceof Error ? error.message : String(error);
}

async function inspectMaintenanceHealth({
  objectStore,
  garbageCollectionCheckpointStore,
  activeMode,
  superblockSlots,
}: {
  objectStore: HizoFSObjectStore;
  garbageCollectionCheckpointStore: HizoFSGarbageCollectionCheckpointStore;
  activeMode: 'current' | 'fallback_read_only';
  superblockSlots: readonly HizoFSSuperblockSlotInspection[];
}): Promise<HizoFSMaintenanceHealth> {
  const listing = await objectStore.listPhysicalObjects();
  const relocationMap = await objectStore.readRelocationSnapshot().then(snapshot => ({
    status: 'valid' as const,
    sequence: snapshot.sequence,
    mappingCount: snapshot.mappings.size,
  })).catch((error: unknown) => ({
    status: 'invalid' as const,
    errorMessage: errorMessage({ error }),
  }));
  const garbageCollectionCheckpoint = await garbageCollectionCheckpointStore.read()
    .then(checkpoint => checkpoint === undefined
      ? { status: 'absent' as const }
      : { status: 'valid' as const, checkpoint })
    .catch((error: unknown) => ({
      status: 'invalid' as const,
      errorMessage: errorMessage({ error }),
    }));

  const reasons: string[] = [];
  switch (activeMode) {
  case 'current':
    break;
  case 'fallback_read_only':
    reasons.push('active state uses the older read-only fallback generation');
    break;
  default: {
    const _ex: never = activeMode;
    throw new Error(`Unhandled HizoFS active mode: ${String(_ex)}`);
  }
  }
  for (const slot of superblockSlots) {
    if (slot.status === 'invalid' || slot.status === 'unsupported') {
      reasons.push(`superblock slot ${String(slot.slot)} is ${slot.status}`);
    }
  }
  const indexes = listing.segmentIndexes;
  if (indexes.readableSegmentCount !== indexes.discoveredSegmentCount) {
    reasons.push('one or more physical segments could not be independently indexed');
  }
  if (indexes.rebuiltInvalidIndexCount > 0) {
    reasons.push(`${String(indexes.rebuiltInvalidIndexCount)} invalid segment indexes required authenticated segment scanning`);
  }
  if (indexes.rebuiltMissingIndexCount > 0) {
    reasons.push(`${String(indexes.rebuiltMissingIndexCount)} segment indexes were absent and reconstructed in memory`);
  }
  let relocationMapRequiresManualReview: boolean;
  switch (relocationMap.status) {
  case 'valid':
    relocationMapRequiresManualReview = false;
    break;
  case 'invalid':
    reasons.push('no authenticated relocation-map slot is usable');
    relocationMapRequiresManualReview = true;
    break;
  default: {
    const _ex: never = relocationMap;
    throw new Error(`Unhandled HizoFS relocation-map status: ${String(_ex)}`);
  }
  }
  let checkpointRequiresManualReview: boolean;
  switch (garbageCollectionCheckpoint.status) {
  case 'absent':
  case 'valid':
    checkpointRequiresManualReview = false;
    break;
  case 'invalid':
    reasons.push('no authenticated garbage-collection checkpoint slot is usable');
    checkpointRequiresManualReview = true;
    break;
  default: {
    const _ex: never = garbageCollectionCheckpoint;
    throw new Error(`Unhandled HizoFS GC checkpoint status: ${String(_ex)}`);
  }
  }

  const manualReviewRequired = relocationMapRequiresManualReview
    || checkpointRequiresManualReview
    || indexes.readableSegmentCount !== indexes.discoveredSegmentCount;
  return {
    segmentIndexes: indexes,
    relocationMap,
    garbageCollectionCheckpoint,
    recoveryAssessment: {
      status: manualReviewRequired
        ? 'manual_review_required'
        : reasons.length === 0 ? 'healthy' : 'degraded',
      reasons,
      automaticRepairPerformed: false,
    },
  };
}

export async function createHizoFSInspectionReader({
  backingDirectory,
  fileSystemRootKey,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
}): Promise<HizoFSInspectionReader> {
  const backingStore = new NativeOpfsHizoFSBackingStore({
    root: backingDirectory,
    fileHandleCacheEntryLimit:
      DEFAULT_HIZOFS_POLICY.backingFileHandleCacheEntryLimit,
    fileSnapshotCacheEntryLimit:
      DEFAULT_HIZOFS_POLICY.backingFileSnapshotCacheEntryLimit,
    diagnostics: undefined,
  });
  const descriptorInspection = await readDescriptorForInspection({ backingStore });
  const descriptor = descriptorInspection.value;
  const rootKey = await importHizoFSRootKey({ rawRootKey: fileSystemRootKey });
  const fileSystemId = await deriveHizoFSFileSystemId({ rootKey });
  const maintenanceLease = await acquireHizoFSResourceLease({ fileSystemId });
  try {
    const runtime = createHizoFSRuntime({
      backingStore,
      rootKey,
      fileSystemId,
      policy: DEFAULT_HIZOFS_POLICY,
      now: () => Date.now(),
      diagnostics: undefined,
    });
    const garbageCollectionCheckpointStore = new HizoFSGarbageCollectionCheckpointStore({
      backingStore,
      rootKey,
      fileSystemId,
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
        // Workbench inspection must describe the persisted HizoFS structure,
        // not the live coordinator's cached generation. This intentionally
        // reloads both physical head slots so externally introduced corruption
        // and fallback selection remain visible while a normal session is open.
        const activeState = await loadHizoFSActiveStateFromStores({
          superblockStore: runtime.core.superblockStore,
          commitStore: runtime.commitStore,
          inodeIndex: runtime.inodeIndex,
          inodeStore: runtime.inodeStore,
          validatedRootCache: undefined,
        });
        const superblockSlots = await inspectSuperblockSlots({
          objectStore: runtime.objectStore,
          fileSystemId,
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
        const maintenance = await inspectMaintenanceHealth({
          objectStore: runtime.objectStore,
          garbageCollectionCheckpointStore,
          activeMode: activeState.mode,
          superblockSlots,
        });
        return {
          activeMode: activeState.mode,
          descriptor,
          fileSystemId,
          persistedDescriptorDto: descriptorInspection.persistedDto,
          descriptorValidationError: descriptorInspection.validationError,
          superblockSlots,
          activeSuperblock: activeState.superblock,
          activeCommitObjectId: activeState.commitObjectId,
          activeCommit: activeState.commit,
          activeCommitPersistedDto: activeCommitRecord.metadata,
          maintenance,
        };
      },

      async listPhysicalObjects({ cursor, limit }) {
        assertOpen();
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
          throw new Error('HizoFS inspection object page limit must be between 1 and 1000');
        }
        return await listPhysicalObjectPage({
          objectStore: runtime.objectStore,
          cursor,
          limit,
        });
      },

      async inspectObject({ objectId, binaryPreviewByteLength }) {
        assertOpen();
        validateHizoFSObjectId({ objectId });
        assertBinaryPreviewByteLength({ binaryPreviewByteLength });
        const physicalRecord = await runtime.objectStore.inspectPhysicalRecord({ objectId });
        if (physicalRecord === undefined) {
          return undefined;
        }
        try {
          const inspected = inspectSegmentedRecordBinary({
            objectId,
            physical: physicalRecord.physicalBytes,
            plaintext: physicalRecord.plaintext,
            binaryPreviewByteLength,
          });
          return {
            objectId,
            physicalPath: physicalRecord.physicalPath,
            physicalByteLength: physicalRecord.physicalBytes.byteLength,
            binary: inspected.binary,
            record: {
              kind: inspected.record.kind,
              recordVersion: inspected.record.recordVersion,
              metadata: inspected.record.metadata,
              binaryPayloadByteLength: inspected.record.binaryPayload.byteLength,
            },
          };
        } finally {
          physicalRecord.plaintext.fill(0);
        }
      },

      async inspectSuperblockSlot({ slot, binaryPreviewByteLength }) {
        assertOpen();
        assertBinaryPreviewByteLength({ binaryPreviewByteLength });
        const activeState = await runtime.core.loadActiveState();
        return await inspectSuperblockSlot({
          objectStore: runtime.objectStore,
          fileSystemId,
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
        const results = await Promise.allSettled([
          runtime.close(),
          maintenanceLease.release(),
        ]);
        const errors = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map(result => result.reason);
        if (errors.length > 0) {
          throw new AggregateError(errors, 'Failed to dispose HizoFS inspection reader');
        }
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
function inspectSegmentedRecordBinary({
  objectId,
  physical,
  plaintext,
  binaryPreviewByteLength,
}: {
  objectId: string;
  physical: Uint8Array;
  plaintext: Uint8Array;
  binaryPreviewByteLength: number;
}): {
  readonly record: ReturnType<typeof decodeHizoFSRecord>;
  readonly binary: HizoFSBinaryRecordInspection;
} {
  const reference = decodeHizoFSObjectReference({ value: objectId });
  const view = new DataView(physical.buffer, physical.byteOffset, physical.byteLength);
  return inspectAuthenticatedRecordBinary({
    physical,
    plaintext,
    binaryPreviewByteLength,
    persistedHeaderFields: [
      createDecodedBinaryField({
        name: 'magic',
        source: physical,
        offset: 0,
        byteLength: 8,
        encoding: 'ascii',
        interpretation: '"HZREC001"',
      }),
      createDecodedBinaryField({
        name: 'formatVersion',
        source: physical,
        offset: 8,
        byteLength: 2,
        encoding: 'uint16_be',
        interpretation: String(view.getUint16(8, false)),
      }),
      createDecodedBinaryField({
        name: 'headerByteLength',
        source: physical,
        offset: 10,
        byteLength: 2,
        encoding: 'uint16_be',
        interpretation: `${String(view.getUint16(10, false))} bytes`,
      }),
      createDecodedBinaryField({
        name: 'frameByteLength',
        source: physical,
        offset: 16,
        byteLength: 8,
        encoding: 'uint64_be',
        interpretation: `${String(reference.storedLength)} bytes`,
      }),
      createDecodedBinaryField({
        name: 'plaintextByteLength',
        source: physical,
        offset: 24,
        byteLength: 8,
        encoding: 'uint64_be',
        interpretation: `${String(plaintext.byteLength)} bytes`,
      }),
      createDecodedBinaryField({
        name: 'homeSegmentId',
        source: physical,
        offset: 32,
        byteLength: 16,
        encoding: 'bytes',
        interpretation: encodeHizoFSSegmentId({ segmentId: reference.homeSegmentId }),
      }),
      createDecodedBinaryField({
        name: 'homeOffset',
        source: physical,
        offset: 48,
        byteLength: 8,
        encoding: 'uint64_be',
        interpretation: String(reference.homeOffset),
      }),
      createDecodedBinaryField({
        name: 'nonce',
        source: physical,
        offset: 56,
        byteLength: 12,
        encoding: 'bytes',
        interpretation: '12-byte AES-GCM nonce',
      }),
      createDecodedBinaryField({
        name: 'recordKind',
        source: physical,
        offset: 68,
        byteLength: 1,
        encoding: 'uint8',
        interpretation: reference.kind,
      }),
    ],
    ciphertextOffset: HIZOFS_RECORD_FRAME_HEADER_BYTE_LENGTH,
    ciphertextByteLength: plaintext.byteLength + HIZOFS_AES_GCM_TAG_BYTE_LENGTH,
  });
}

function inspectHeadRecordBinary({
  physical,
  plaintext,
  binaryPreviewByteLength,
}: {
  physical: Uint8Array;
  plaintext: Uint8Array;
  binaryPreviewByteLength: number;
}): {
  readonly record: ReturnType<typeof decodeHizoFSRecord>;
  readonly binary: HizoFSBinaryRecordInspection;
} {
  const view = new DataView(physical.buffer, physical.byteOffset, physical.byteLength);
  return inspectAuthenticatedRecordBinary({
    physical,
    plaintext,
    binaryPreviewByteLength,
    persistedHeaderFields: [
      createDecodedBinaryField({
        name: 'magic',
        source: physical,
        offset: 0,
        byteLength: 8,
        encoding: 'ascii',
        interpretation: '"HZHED001"',
      }),
      createDecodedBinaryField({
        name: 'formatVersion',
        source: physical,
        offset: 8,
        byteLength: 2,
        encoding: 'uint16_be',
        interpretation: String(view.getUint16(8, false)),
      }),
      createDecodedBinaryField({
        name: 'headerByteLength',
        source: physical,
        offset: 10,
        byteLength: 2,
        encoding: 'uint16_be',
        interpretation: `${String(view.getUint16(10, false))} bytes`,
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
        byteLength: 4,
        encoding: 'uint32_be',
        interpretation: `${String(view.getUint32(24, false))} bytes including authentication tag`,
      }),
    ],
    ciphertextOffset: HIZOFS_HEAD_ENVELOPE_HEADER_BYTE_LENGTH,
    ciphertextByteLength: physical.byteLength - HIZOFS_HEAD_ENVELOPE_HEADER_BYTE_LENGTH,
  });
}

function inspectAuthenticatedRecordBinary({
  physical,
  plaintext,
  binaryPreviewByteLength,
  persistedHeaderFields,
  ciphertextOffset,
  ciphertextByteLength,
}: {
  physical: Uint8Array;
  plaintext: Uint8Array;
  binaryPreviewByteLength: number;
  persistedHeaderFields: readonly HizoFSDecodedBinaryField[];
  ciphertextOffset: number;
  ciphertextByteLength: number;
}): {
  readonly record: ReturnType<typeof decodeHizoFSRecord>;
  readonly binary: HizoFSBinaryRecordInspection;
} {
  assertBinaryPreviewByteLength({ binaryPreviewByteLength });
  const record = decodeHizoFSRecord({ plaintext });
  const plaintextView = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  const metadataByteLength = plaintextView.getUint32(4, false);
  const binaryPayloadByteLength = Number(plaintextView.getBigUint64(8, false));
  const metadataOffset = 16;
  const binaryPayloadOffset = metadataOffset + metadataByteLength;
  const metadataBytes = plaintext.slice(metadataOffset, binaryPayloadOffset);
  const metadataUtf8Text = new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes);
  const minimumPersistedPreview = persistedHeaderFields.reduce(
    (maximum, field) => Math.max(maximum, field.offset + field.byteLength),
    0,
  );

  return {
    record,
    binary: {
      persistedObject: {
        bytes: createBinarySlice({
          source: physical,
          offset: 0,
          regionByteLength: physical.byteLength,
          previewByteLength: Math.max(minimumPersistedPreview, binaryPreviewByteLength),
        }),
        headerFields: persistedHeaderFields,
        ciphertextOffset,
        ciphertextByteLength,
      },
      decryptedRecord: {
        bytes: createBinarySlice({
          source: plaintext,
          offset: 0,
          regionByteLength: plaintext.byteLength,
          previewByteLength: Math.max(16, binaryPreviewByteLength),
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
  objectStore,
  fileSystemId,
  selectedSuperblock,
  binaryPreviewByteLength,
}: {
  objectStore: HizoFSObjectStore;
  fileSystemId: string;
  selectedSuperblock: HizoFSSuperblockDto;
  binaryPreviewByteLength: number;
}): Promise<readonly HizoFSSuperblockSlotInspection[]> {
  const inspections: HizoFSSuperblockSlotInspection[] = [];
  for (const slot of [0, 1] as const) {
    inspections.push(await inspectSuperblockSlot({
      objectStore,
      fileSystemId,
      selectedSuperblock,
      slot,
      binaryPreviewByteLength,
    }));
  }
  return inspections;
}

async function inspectSuperblockSlot({
  objectStore,
  fileSystemId,
  selectedSuperblock,
  slot,
  binaryPreviewByteLength,
}: {
  objectStore: HizoFSObjectStore;
  fileSystemId: string;
  selectedSuperblock: HizoFSSuperblockDto;
  slot: 0 | 1;
  binaryPreviewByteLength: number;
}): Promise<HizoFSSuperblockSlotInspection> {
  const fallbackPhysicalPath = [`head-${String(slot)}.hfs`] as const;
  let head: Awaited<ReturnType<HizoFSObjectStore['inspectHead']>>;
  try {
    head = await objectStore.inspectHead({ slot });
  } catch (error) {
    const physicalHead = await objectStore.inspectHeadPhysical({ slot });
    if (physicalHead === undefined) {
      return {
        slot,
        status: 'missing',
        selected: false,
        physicalPath: fallbackPhysicalPath,
      };
    }
    return {
      slot,
      status: error instanceof HizoFSUnsupportedFormatError ? 'unsupported' : 'invalid',
      selected: false,
      physicalPath: physicalHead.physicalPath,
      physicalBytes: createBinarySlice({
        source: physicalHead.physicalBytes,
        offset: 0,
        regionByteLength: physicalHead.physicalBytes.byteLength,
        previewByteLength: Math.min(
          Math.max(32, binaryPreviewByteLength),
          physicalHead.physicalBytes.byteLength,
        ),
      }),
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
  if (head === undefined) {
    return {
      slot,
      status: 'missing',
      selected: false,
      physicalPath: fallbackPhysicalPath,
    };
  }
  const physicalPath = head.physicalPath;
  const physical = head.physicalBytes;
  try {
    const inspected = inspectHeadRecordBinary({
      physical,
      plaintext: head.recordBytes,
      binaryPreviewByteLength,
    });
    const { record } = head;
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
        message: 'HizoFS superblock fileSystemId does not match the root-key-derived file system ID',
        cause: undefined,
      });
    }
    const selected = value.sequence === selectedSuperblock.sequence
      && value.activeCommitObjectId === selectedSuperblock.activeCommitObjectId;
    head.recordBytes.fill(0);
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
    head.recordBytes.fill(0);
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
  readonly validationError: string | undefined;
}> {
  const bytes = await backingStore.read({ path: ['descriptor.json'] });
  if (bytes === undefined) {
    const value: HizoFSDescriptorDto = {
      format: 'hizofs',
      formatVersion: 1,
    };
    return { value, persistedDto: undefined, validationError: undefined };
  }
  let persistedDto: unknown;
  try {
    persistedDto = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error('HizoFS descriptor is invalid UTF-8 JSON', { cause: error });
  }
  const parsed = HizoFSDescriptorSchemaDto.safeParse(persistedDto);
  return {
    value: parsed.success
      ? parsed.data
      : { format: 'hizofs', formatVersion: 1 },
    persistedDto,
    validationError: parsed.success ? undefined : parsed.error.message,
  };
}

/**
 * Segment records are direct logical references rather than physical file
 * names. The inspection cursor therefore uses the canonical object-reference
 * ordering and treats the segment listing as an authenticated snapshot.
 */
async function listPhysicalObjectPage({ objectStore, cursor, limit }: {
  objectStore: HizoFSObjectStore;
  cursor: string | undefined;
  limit: number;
}): Promise<HizoFSPhysicalObjectPage> {
  const parsedCursor = cursor === undefined
    ? undefined
    : parsePhysicalObjectCursor({ cursor });
  const listing = await objectStore.listPhysicalObjects();
  const candidates = listing.entries
    .filter(entry => (
      parsedCursor === undefined
      || comparePhysicalObjectNames({
        left: entry.objectId,
        right: parsedCursor.objectId,
      }) > 0
    ))
    .slice(0, limit + 1);
  const hasNextPage = candidates.length > limit;
  const entries = hasNextPage ? candidates.slice(0, limit) : candidates;
  const lastEntry = entries.at(-1);
  return {
    entries,
    nextCursor: hasNextPage && lastEntry !== undefined
      ? createPhysicalObjectCursor({ entry: lastEntry })
      : undefined,
    ignoredPhysicalPaths: listing.ignoredPhysicalPaths,
  };
}

/**
 * Physical pagination must use exactly the same locale-independent ordering
 * when sorting entries and applying a cursor. `localeCompare()` can order the
 * Base64URL alphabet differently from JavaScript's relational operators.
 */
function comparePhysicalObjectNames({ left, right }: {
  left: string;
  right: string;
}): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function createPhysicalObjectCursor({ entry }: {
  entry: HizoFSPhysicalObjectEntry;
}): string {
  return entry.objectId;
}

function parsePhysicalObjectCursor({ cursor }: { cursor: string }): {
  readonly objectId: string;
} {
  validateHizoFSObjectId({ objectId: cursor });
  return { objectId: cursor };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
