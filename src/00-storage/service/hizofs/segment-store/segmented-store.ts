import { HizoFSSuperblockSchemaDto } from '@/00-storage/00-dto/hizofs.dto';
import type {
  HizoFSBackingStore,
  HizoFSRandomAccessFile,
} from '@/00-storage/service/hizofs/backing-store/backing-store';
import {
  bytesEqual,
  concatenateBytes,
} from '@/00-storage/service/hizofs/bytes';
import { HizoFSCorruptionError } from '@/00-storage/service/hizofs/errors';
import type { HizoFSRuntimeDiagnostics } from '@/00-storage/service/hizofs/file-system/diagnostics';
import { Semaphore } from '@/utils/concurrency';
import type { HizoFSRecordKind } from '@/00-storage/service/hizofs/format/record';
import { deriveHizoFSSegmentRecordKey } from '@/00-storage/service/hizofs/segment-store/segment-crypto';
import { HizoFSRelocationStore, type HizoFSRelocationSnapshot } from '@/00-storage/service/hizofs/segment-store/relocation-store';
import {
  decodeHizoFSSegmentIndex,
  encodeHizoFSSegmentIndex,
  type HizoFSSegmentIndexEntry,
} from '@/00-storage/service/hizofs/segment-store/segment-index';
import {
  decodeHizoFSHead,
  decodeHizoFSRecordFrame,
  decodeHizoFSRecordFrameReference,
  decodeHizoFSSegmentHeader,
  encodeHizoFSHead,
  encodeHizoFSRecordFrame,
  encodeHizoFSSegmentHeader,
  getHizoFSRecordFrameByteLength,
  HIZOFS_RECORD_FRAME_HEADER_BYTE_LENGTH,
  HIZOFS_SEGMENT_HEADER_BYTE_LENGTH,
  type HizoFSDecodedHead,
  type HizoFSSegmentType,
} from '@/00-storage/service/hizofs/segment-store/segment-format';
import {
  createHizoFSSegmentId,
  decodeHizoFSObjectReference,
  decodeHizoFSSegmentId,
  encodeHizoFSObjectReference,
  encodeHizoFSSegmentId,
  getHizoFSSegmentShard,
  type HizoFSObjectReference,
} from '@/00-storage/service/hizofs/segment-store/object-reference';
import {
  getHizoFSHeadPath,
  type HizoFSHeadScope,
} from '@/00-storage/service/hizofs/segment-store/head-scope';

const METADATA_SEGMENT_PAYLOAD_TARGET_BYTE_LENGTH = 1024 * 1024;
const DATA_SEGMENT_PAYLOAD_TARGET_BYTE_LENGTH = 16 * 1024 * 1024;
export const HIZOFS_MAX_COALESCED_RECORDS_PER_WRITE = 2;

export type HizoFSPhysicalObjectEntry = {
  readonly objectId: string;
  readonly physicalPath: readonly string[];
  readonly physicalByteLength: number;
};

export type HizoFSSegmentIndexDiagnostics = {
  readonly discoveredSegmentCount: number;
  readonly readableSegmentCount: number;
  readonly authenticatedIndexCount: number;
  readonly rebuiltMissingIndexCount: number;
  readonly rebuiltInvalidIndexCount: number;
};

export type HizoFSPhysicalObjectListing = {
  readonly entries: readonly HizoFSPhysicalObjectEntry[];
  readonly ignoredPhysicalPaths: readonly string[];
  readonly segmentIndexes: HizoFSSegmentIndexDiagnostics;
};

export type HizoFSWholeSegmentReclaimCandidate = {
  readonly representativeObjectId: string;
  readonly objectIds: readonly string[];
  readonly physicalPath: readonly string[];
  readonly expectedPhysicalByteLength: number;
};

export type HizoFSPartialSegmentCompactionCandidate = {
  readonly representativeObjectId: string;
  readonly liveObjectIds: readonly string[];
  readonly deadObjectIds: readonly string[];
  readonly physicalPath: readonly string[];
  readonly expectedPhysicalByteLength: number;
  readonly liveRecordByteLength: number;
  readonly deadRecordByteLength: number;
};

export type HizoFSWholeSegmentRemovalResult = 'removed' | 'missing' | 'changed';

export type HizoFSPhysicalRecord = {
  readonly objectId: string;
  readonly resolvedObjectId: string;
  readonly physicalPath: readonly string[];
  readonly physicalBytes: Uint8Array;
  readonly plaintext: Uint8Array;
  readonly kind: HizoFSRecordKind;
};

type SegmentReservation = {
  readonly writer: HizoFSActiveSegmentWriter;
  readonly reference: HizoFSObjectReference;
  readonly write: Promise<void>;
};

type SegmentBatchReservation = {
  readonly references: readonly HizoFSObjectReference[];
  readonly writes: readonly Promise<void>[];
};

export type HizoFSLazySegmentRecord = {
  readonly kind: HizoFSRecordKind;
  readonly plaintextByteLength: number;
  readonly rotationPayloadByteLength: number;
  readonly createPlaintext: () => Promise<Uint8Array>;
  readonly discardPlaintext: () => void;
};

type PipelinedSegmentRecordPlan = {
  readonly writer: HizoFSActiveSegmentWriter;
  readonly reference: HizoFSObjectReference;
  readonly record: HizoFSLazySegmentRecord;
};

type CommittedMetadataSegment = {
  readonly segmentId: Uint8Array;
  readonly durableTail: number;
  readonly sequence: number;
};

function segmentTypeForRecordKind({ kind }: {
  kind: HizoFSRecordKind;
}): 'metadata' | 'data' {
  switch (kind) {
  case 'file_chunk':
    return 'data';
  case 'superblock':
  case 'subvolume_descriptor':
  case 'subvolume_mount_index_page':
  case 'commit':
  case 'inode_index_page':
  case 'file_inode':
  case 'directory_inode':
  case 'symlink_inode':
  case 'directory_index_page':
  case 'file_extent_page':
    return 'metadata';
  default: {
    const _ex: never = kind;
    throw new Error(`Unhandled HizoFS record kind: ${String(_ex)}`);
  }
  }
}

function segmentDirectoryName({ segmentType }: {
  segmentType: HizoFSSegmentType;
}): string {
  switch (segmentType) {
  case 'metadata':
    return 'metadata';
  case 'data':
    return 'data';
  case 'relocation':
    return 'relocation';
  default: {
    const _ex: never = segmentType;
    throw new Error(`Unhandled HizoFS segment type: ${String(_ex)}`);
  }
  }
}

function getSegmentPath({ segmentType, segmentId }: {
  segmentType: HizoFSSegmentType;
  segmentId: Uint8Array;
}): readonly string[] {
  return [
    'segments',
    segmentDirectoryName({ segmentType }),
    getHizoFSSegmentShard({ segmentId }),
    `${encodeHizoFSSegmentId({ segmentId })}.seg`,
  ];
}

function getSegmentIndexPath({ segmentType, segmentId }: {
  segmentType: HizoFSSegmentType;
  segmentId: Uint8Array;
}): readonly string[] {
  const encodedSegmentId = encodeHizoFSSegmentId({ segmentId });
  return [
    'segment-indexes',
    segmentDirectoryName({ segmentType }),
    getHizoFSSegmentShard({ segmentId }),
    `${encodedSegmentId}.idx`,
  ];
}

function sameSegmentId({ left, right }: {
  left: Uint8Array;
  right: Uint8Array;
}): boolean {
  return bytesEqual({ left, right });
}

function physicalPathKey({ path }: { path: readonly string[] }): string {
  return path.join('/');
}

function compareCanonicalObjectIds({ left, right }: {
  left: string;
  right: string;
}): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

class HizoFSActiveSegmentWriter {
  private constructor({
    file,
    rootKey,
    fileSystemId,
    segmentType,
    segmentId,
    path,
    diagnostics,
    tail,
    payloadBytes,
  }: {
    file: HizoFSRandomAccessFile;
    rootKey: CryptoKey;
    fileSystemId: string;
    segmentType: HizoFSSegmentType;
    segmentId: Uint8Array;
    path: readonly string[];
    diagnostics: HizoFSRuntimeDiagnostics | undefined;
    tail: number;
    payloadBytes: number;
  }) {
    this.file = file;
    this.rootKey = rootKey;
    this.fileSystemId = fileSystemId;
    this.segmentType = segmentType;
    this.segmentId = segmentId;
    this.path = path;
    this.diagnostics = diagnostics;
    this.tail = tail;
    this.payloadBytes = payloadBytes;
    this.recordKey = deriveHizoFSSegmentRecordKey({
      rootKey,
      fileSystemId,
      homeSegmentId: segmentId,
    });
  }

  static async create({
    backingStore,
    rootKey,
    fileSystemId,
    segmentType,
    diagnostics,
  }: {
    backingStore: HizoFSBackingStore;
    rootKey: CryptoKey;
    fileSystemId: string;
    segmentType: 'metadata' | 'data';
    diagnostics: HizoFSRuntimeDiagnostics | undefined;
  }): Promise<HizoFSActiveSegmentWriter> {
    const segmentId = createHizoFSSegmentId();
    const path = getSegmentPath({ segmentType, segmentId });
    const file = await backingStore.openRandomAccessFile({
      path,
      mode: 'read_write',
      create: true,
    });
    try {
      if (await file.getSize() !== 0) {
        throw new Error('Fresh HizoFS segment ID unexpectedly already exists');
      }
      const header = await encodeHizoFSSegmentHeader({
        rootKey,
        fileSystemId,
        segmentType,
        segmentId,
      });
      await file.writeAt({ offset: 0, bytes: header });
      return new HizoFSActiveSegmentWriter({
        file,
        rootKey,
        fileSystemId,
        segmentType,
        segmentId,
        path,
        diagnostics,
        tail: HIZOFS_SEGMENT_HEADER_BYTE_LENGTH,
        payloadBytes: 0,
      });
    } catch (error) {
      await file.close();
      throw error;
    }
  }


  readonly segmentType: HizoFSSegmentType;
  readonly segmentId: Uint8Array;
  readonly path: readonly string[];
  private readonly file: HizoFSRandomAccessFile;
  private readonly rootKey: CryptoKey;
  private readonly fileSystemId: string;
  private readonly diagnostics: HizoFSRuntimeDiagnostics | undefined;
  private readonly recordKey: Promise<CryptoKey>;
  private tail: number;
  private payloadBytes: number;
  private readonly pendingWrites = new Set<Promise<void>>();
  private writeFailure: { readonly error: unknown } | undefined;
  private closed = false;

  getTail(): number {
    return this.tail;
  }

  canFit({ rotationPayloadByteLength, payloadTargetByteLength }: {
    rotationPayloadByteLength: number;
    payloadTargetByteLength: number;
  }): boolean {
    return this.payloadBytes === 0
      || this.payloadBytes + rotationPayloadByteLength <= payloadTargetByteLength;
  }

  reserve({ kind, plaintextByteLength, rotationPayloadByteLength }: {
    kind: HizoFSRecordKind;
    plaintextByteLength: number;
    rotationPayloadByteLength: number;
  }): HizoFSObjectReference {
    this.assertOpen();
    const storedLength = getHizoFSRecordFrameByteLength({ plaintextByteLength });
    const reference: HizoFSObjectReference = {
      homeSegmentId: this.segmentId.slice(),
      homeOffset: this.tail,
      storedLength,
      kind,
    };
    this.tail += storedLength;
    this.payloadBytes += rotationPayloadByteLength;
    return reference;
  }

  scheduleWrite({ reference, plaintext }: {
    reference: HizoFSObjectReference;
    plaintext: Uint8Array;
  }): Promise<void> {
    return this.scheduleBatchWrite({ records: [{ reference, plaintext }] });
  }

  encodeRecord({ reference, plaintext }: {
    reference: HizoFSObjectReference;
    plaintext: Uint8Array;
  }): Promise<Uint8Array> {
    this.assertReference({ reference });
    return (async () => {
      const encode = async () => encodeHizoFSRecordFrame({
        rootKey: this.rootKey,
        fileSystemId: this.fileSystemId,
        reference,
        plaintext,
        recordKey: await this.recordKey,
      });
      const encoded = this.diagnostics === undefined
        ? await encode()
        : await this.diagnostics.measureAsync({
          phase: 'object_encrypt',
          operation: encode,
        });
      return encoded.bytes;
    })();
  }

  scheduleBatchWrite({ records }: {
    records: readonly {
      readonly reference: HizoFSObjectReference;
      readonly plaintext: Uint8Array;
    }[];
  }): Promise<void> {
    return this.schedulePreparedBatchWrite({
      records: records.map(({ reference, plaintext }) => ({
        reference,
        encodedBytes: this.encodeRecord({ reference, plaintext }),
      })),
    });
  }

  schedulePreparedBatchWrite({ records }: {
    records: readonly {
      readonly reference: HizoFSObjectReference;
      readonly encodedBytes: Promise<Uint8Array>;
    }[];
  }): Promise<void> {
    this.assertOpen();
    this.assertContiguousReferences({
      references: records.map(({ reference }) => reference),
    });
    const first = records[0];
    if (first === undefined) {
      throw new Error('HizoFS segment writer batch unexpectedly became empty');
    }
    const write = (async () => {
      const encodedRecords = await Promise.all(
        records.map(async ({ reference, encodedBytes }) => {
          const bytes = await encodedBytes;
          if (bytes.byteLength !== reference.storedLength) {
            throw new Error(
              'HizoFS encoded record length does not match its reservation',
            );
          }
          return bytes;
        }),
      );
      const bytes = encodedRecords.length === 1
        ? encodedRecords[0]
        : concatenateBytes({ parts: encodedRecords });
      if (bytes === undefined) {
        throw new Error('HizoFS segment writer produced no encoded batch bytes');
      }
      await this.file.writeAt({
        offset: first.reference.homeOffset,
        bytes,
      });
    })();
    return this.trackWrite({ write });
  }

  private assertReference({ reference }: {
    reference: HizoFSObjectReference;
  }): void {
    this.assertOpen();
    if (!sameSegmentId({ left: reference.homeSegmentId, right: this.segmentId })) {
      throw new Error('HizoFS segment writer received a foreign object reference');
    }
  }

  private assertContiguousReferences({ references }: {
    references: readonly HizoFSObjectReference[];
  }): void {
    if (references.length === 0) {
      throw new Error('HizoFS segment writer batch must contain at least one record');
    }
    const first = references[0];
    if (first === undefined) {
      throw new Error('HizoFS segment writer batch unexpectedly became empty');
    }
    let expectedOffset = first.homeOffset;
    for (const reference of references) {
      this.assertReference({ reference });
      if (reference.homeOffset !== expectedOffset) {
        throw new Error('HizoFS segment writer batch references must be contiguous');
      }
      expectedOffset += reference.storedLength;
    }
  }

  private trackWrite({ write }: { write: Promise<void> }): Promise<void> {
    const tracked = write.catch((error: unknown) => {
      this.writeFailure ??= { error };
      throw error;
    }).finally(() => {
      this.pendingWrites.delete(tracked);
    });
    this.pendingWrites.add(tracked);
    return tracked;
  }

  async read({ reference }: {
    reference: HizoFSObjectReference;
  }): Promise<Uint8Array> {
    this.assertOpen();
    return this.file.readAt({
      offset: reference.homeOffset,
      byteLength: reference.storedLength,
    });
  }

  async flush(): Promise<number> {
    this.assertOpen();
    await this.waitForPendingWrites();
    const durableTail = this.tail;
    try {
      await this.file.flush();
      return durableTail;
    } catch (error) {
      this.writeFailure ??= { error };
      throw error;
    }
  }

  isUsable(): boolean {
    return !this.closed && this.writeFailure === undefined;
  }

  async close({ flush }: { flush: boolean }): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    let pendingError: unknown;
    try {
      try {
        await this.waitForPendingWrites();
      } catch (error) {
        pendingError = error;
      }
      if (pendingError === undefined && flush) await this.file.flush();
    } finally {
      await this.file.close();
    }
    if (pendingError !== undefined) throw pendingError;
  }

  private async waitForPendingWrites(): Promise<void> {
    if (this.pendingWrites.size > 0) {
      await Promise.allSettled([...this.pendingWrites]);
    }
    if (this.writeFailure !== undefined) throw this.writeFailure.error;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('HizoFS segment writer is closed');
  }
}

export class HizoFSSegmentedStore {
  constructor({ backingStore, rootKey, fileSystemId, diagnostics }: {
    backingStore: HizoFSBackingStore;
    rootKey: CryptoKey;
    fileSystemId: string;
    diagnostics: HizoFSRuntimeDiagnostics | undefined;
  }) {
    this.backingStore = backingStore;
    this.rootKey = rootKey;
    this.fileSystemId = fileSystemId;
    this.diagnostics = diagnostics;
    this.relocationStore = new HizoFSRelocationStore({ backingStore, rootKey, fileSystemId });
  }

  private readonly backingStore: HizoFSBackingStore;
  private readonly rootKey: CryptoKey;
  private readonly fileSystemId: string;
  private readonly diagnostics: HizoFSRuntimeDiagnostics | undefined;
  private readonly relocationStore: HizoFSRelocationStore;
  private activeMetadataWriter: HizoFSActiveSegmentWriter | undefined;
  private activeDataWriter: HizoFSActiveSegmentWriter | undefined;
  private readonly persistentHeadFiles = new Map<string, HizoFSRandomAccessFile>();
  private headHandleRetention: 'ephemeral' | 'persistent' = 'ephemeral';
  private committedMetadataSegment: CommittedMetadataSegment | undefined;
  private reservationChain: Promise<void> = Promise.resolve();
  private readonly validatedSegmentKeys = new Set<string>();
  private readonly recordKeyPromises = new Map<string, Promise<CryptoKey>>();
  private closed = false;

  async createRecord({ kind, plaintext, rotationPayloadByteLength }: {
    kind: HizoFSRecordKind;
    plaintext: Uint8Array;
    rotationPayloadByteLength: number;
  }): Promise<string> {
    this.assertOpen();
    const reservation = await this.reserveAndScheduleWrite({
      kind,
      plaintext,
      rotationPayloadByteLength,
    });
    await reservation.write;
    return encodeHizoFSObjectReference({ reference: reservation.reference });
  }

  async createRecords({ records }: {
    records: readonly {
      readonly kind: HizoFSRecordKind;
      readonly plaintext: Uint8Array;
      readonly rotationPayloadByteLength: number;
    }[];
  }): Promise<readonly string[]> {
    this.assertOpen();
    if (records.length === 0) return [];
    if (records.length > HIZOFS_MAX_COALESCED_RECORDS_PER_WRITE) {
      throw new Error(
        `HizoFS record batches may contain at most ${String(HIZOFS_MAX_COALESCED_RECORDS_PER_WRITE)} records`,
      );
    }
    const first = records[0];
    if (first === undefined) return [];
    const segmentType = segmentTypeForRecordKind({ kind: first.kind });
    for (const record of records) {
      if (segmentTypeForRecordKind({ kind: record.kind }) !== segmentType) {
        throw new Error(
          'HizoFS record batches must use one physical segment type',
        );
      }
    }
    const reservation = await this.reserveAndScheduleBatchWrite({
      records,
      segmentType,
    });
    await Promise.all(reservation.writes);
    return reservation.references.map(reference =>
      encodeHizoFSObjectReference({ reference })
    );
  }

  async createRecordsPipelined({
    records,
    maximumPlaintextRecordsInFlight,
    maximumRecordsPerPhysicalWrite,
  }: {
    records: readonly HizoFSLazySegmentRecord[];
    maximumPlaintextRecordsInFlight: number;
    maximumRecordsPerPhysicalWrite: number;
  }): Promise<readonly string[]> {
    this.assertOpen();
    if (records.length === 0) return [];
    for (const [fieldName, value] of [
      ['maximumPlaintextRecordsInFlight', maximumPlaintextRecordsInFlight],
      ['maximumRecordsPerPhysicalWrite', maximumRecordsPerPhysicalWrite],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`HizoFS ${fieldName} must be a positive safe integer`);
      }
    }
    if (maximumRecordsPerPhysicalWrite > HIZOFS_MAX_COALESCED_RECORDS_PER_WRITE) {
      throw new Error(
        `HizoFS record batches may contain at most ${String(HIZOFS_MAX_COALESCED_RECORDS_PER_WRITE)} records`,
      );
    }
    const first = records[0];
    if (first === undefined) return [];
    const segmentType = segmentTypeForRecordKind({ kind: first.kind });
    for (const record of records) {
      if (!Number.isSafeInteger(record.plaintextByteLength) || record.plaintextByteLength < 0) {
        throw new Error(
          'HizoFS lazy record plaintext length must be a non-negative safe integer',
        );
      }
      if (
        !Number.isSafeInteger(record.rotationPayloadByteLength)
        || record.rotationPayloadByteLength < 0
      ) {
        throw new Error(
          'HizoFS lazy record rotation length must be a non-negative safe integer',
        );
      }
      if (segmentTypeForRecordKind({ kind: record.kind }) !== segmentType) {
        throw new Error('HizoFS record pipelines must use one physical segment type');
      }
    }
    const managedRecords = records.map(record => {
      let discarded = false;
      return {
        ...record,
        discardPlaintext: (): void => {
          if (discarded) return;
          discarded = true;
          record.discardPlaintext();
        },
      } satisfies HizoFSLazySegmentRecord;
    });

    const objectIds: string[] = [];
    let nextRecordIndex = 0;
    try {
      while (nextRecordIndex < managedRecords.length) {
        const reservation = await this.reservePipelinedRecordGroup({
          records: managedRecords,
          startIndex: nextRecordIndex,
          segmentType,
        });
        const groupObjectIds = await this.writePipelinedRecordGroup({
          plans: reservation.plans,
          maximumPlaintextRecordsInFlight,
          maximumRecordsPerPhysicalWrite,
        });
        objectIds.push(...groupObjectIds);
        nextRecordIndex = reservation.endIndex;
      }
      return objectIds;
    } finally {
      for (const record of managedRecords) record.discardPlaintext();
    }
  }


  async readRecord({ objectId }: {
    objectId: string;
  }): Promise<{
    readonly plaintext: Uint8Array;
    readonly physicalByteLength: number;
    readonly kind: HizoFSRecordKind;
  } | undefined> {
    const record = await this.readPhysicalRecord({ objectId });
    if (record === undefined) return undefined;
    return {
      plaintext: record.plaintext,
      physicalByteLength: record.physicalBytes.byteLength,
      kind: record.kind,
    };
  }

  async readPhysicalRecord({ objectId }: {
    objectId: string;
  }): Promise<HizoFSPhysicalRecord | undefined> {
    this.assertOpen();
    const resolvedObjectId = await this.relocationStore.resolve({ objectId });
    const logicalReference = decodeHizoFSObjectReference({ value: objectId });
    const reference = decodeHizoFSObjectReference({ value: resolvedObjectId });
    if (logicalReference.kind !== reference.kind) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS relocated object kind differs from its logical reference',
        cause: undefined,
      });
    }
    const segmentType = segmentTypeForRecordKind({ kind: reference.kind });
    const physicalPath = getSegmentPath({
      segmentType,
      segmentId: reference.homeSegmentId,
    });
    const activeWriter = this.getActiveWriter({ segmentType });
    let physical: Uint8Array | undefined;
    if (
      activeWriter !== undefined
      && sameSegmentId({ left: activeWriter.segmentId, right: reference.homeSegmentId })
    ) {
      physical = await activeWriter.read({ reference });
    } else {
      await this.ensureSegmentValidated({
        segmentType,
        segmentId: reference.homeSegmentId,
        path: physicalPath,
      });
      physical = await this.backingStore.readRange({
        path: physicalPath,
        offset: reference.homeOffset,
        byteLength: reference.storedLength,
      });
    }
    if (physical === undefined) return undefined;
    const decode = async () => decodeHizoFSRecordFrame({
      rootKey: this.rootKey,
      fileSystemId: this.fileSystemId,
      expectedReference: reference,
      bytes: physical,
      recordKey: await this.getRecordKey({ segmentId: reference.homeSegmentId }),
    });
    const plaintext = this.diagnostics === undefined
      ? await decode()
      : await this.diagnostics.measureAsync({ phase: 'object_decrypt', operation: decode });
    return {
      objectId,
      resolvedObjectId,
      physicalPath,
      physicalBytes: physical,
      plaintext,
      kind: reference.kind,
    };
  }

  async writeHead({ scope, slot, sequence, recordBytes }: {
    scope: HizoFSHeadScope;
    slot: 0 | 1;
    sequence: number;
    recordBytes: Uint8Array;
  }): Promise<number> {
    this.assertOpen();
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error('HizoFS head sequence must be a non-negative safe integer');
    }
    return this.runWithReservationLock({
      operation: async () => {
        this.assertOpen();
        const metadataWriter = this.activeMetadataWriter
          ?? (this.committedMetadataSegment === undefined
            ? await this.ensureWriter({ segmentType: 'metadata' })
            : undefined);
        if (this.activeDataWriter !== undefined) {
          await this.activeDataWriter.flush();
        }
        let metadataDurableTail: number;
        let metadataSegmentId: Uint8Array;
        if (metadataWriter === undefined) {
          const committed = this.committedMetadataSegment;
          if (committed === undefined) {
            throw new Error('HizoFS head publication has no metadata anchor');
          }
          metadataSegmentId = committed.segmentId;
          metadataDurableTail = committed.durableTail;
        } else {
          metadataSegmentId = metadataWriter.segmentId;
          metadataDurableTail = await metadataWriter.flush();
        }
        const physical = await encodeHizoFSHead({
          rootKey: this.rootKey,
          fileSystemId: this.fileSystemId,
          scope,
          slot,
          activeMetadataSegmentId: metadataSegmentId,
          activeMetadataDurableTail: metadataDurableTail,
          recordBytes,
        });
        await this.replaceHead({ scope, slot, physical });
        this.observeCommittedMetadataSegment({
          sequence,
          segmentId: metadataSegmentId,
          durableTail: metadataDurableTail,
        });
        return physical.byteLength;
      },
    });
  }

  async flushPendingRecords(): Promise<void> {
    this.assertOpen();
    await this.runWithReservationLock({
      operation: async () => {
        if (this.activeDataWriter !== undefined) {
          await this.activeDataWriter.flush();
        }
        if (this.activeMetadataWriter !== undefined) {
          await this.activeMetadataWriter.flush();
        }
      },
    });
  }

  async setHeadHandleRetention({ retention }: {
    retention: 'ephemeral' | 'persistent';
  }): Promise<void> {
    this.assertOpen();
    switch (retention) {
    case 'ephemeral':
    case 'persistent':
      break;
    default: {
      const _ex: never = retention;
      throw new Error(`Unhandled HizoFS head-handle retention: ${_ex}`);
    }
    }
    if (this.headHandleRetention === retention) return;
    this.headHandleRetention = retention;
    switch (retention) {
    case 'ephemeral':
      await this.closePersistentHeadFiles();
      return;
    case 'persistent':
      return;
    default: {
      const _ex: never = retention;
      throw new Error(`Unhandled HizoFS head-handle retention: ${_ex}`);
    }
    }
  }

  async readHeadPhysical({ scope, slot }: {
    scope: HizoFSHeadScope;
    slot: 0 | 1;
  }): Promise<{
    readonly physicalBytes: Uint8Array;
    readonly physicalPath: readonly string[];
  } | undefined> {
    this.assertOpen();
    const physicalPath = getHizoFSHeadPath({ scope, slot });
    const physicalBytes = await this.backingStore.read({ path: physicalPath });
    if (physicalBytes === undefined) return undefined;
    return { physicalBytes, physicalPath };
  }

  async readHead({ scope, slot }: {
    scope: HizoFSHeadScope;
    slot: 0 | 1;
  }): Promise<(HizoFSDecodedHead & {
    readonly physicalByteLength: number;
    readonly physicalBytes: Uint8Array;
    readonly physicalPath: readonly string[];
  }) | undefined> {
    this.assertOpen();
    const physicalPath = getHizoFSHeadPath({ scope, slot });
    const physical = await this.backingStore.read({ path: physicalPath });
    if (physical === undefined) return undefined;
    const decoded = await decodeHizoFSHead({
      rootKey: this.rootKey,
      fileSystemId: this.fileSystemId,
      scope,
      slot,
      bytes: physical,
    });
    switch (decoded.record.kind) {
    case 'superblock': {
      const superblock = HizoFSSuperblockSchemaDto.parse(decoded.record.metadata);
      this.observeCommittedMetadataSegment({
        sequence: superblock.sequence,
        segmentId: decoded.activeMetadataSegmentId,
        durableTail: decoded.activeMetadataDurableTail,
      });
      break;
    }
    case 'subvolume_descriptor':
    case 'subvolume_mount_index_page':
    case 'commit':
    case 'inode_index_page':
    case 'file_inode':
    case 'directory_inode':
    case 'symlink_inode':
    case 'directory_index_page':
    case 'file_extent_page':
    case 'file_chunk':
      break;
    default: {
      const _ex: never = decoded.record.kind;
      throw new Error(`Unhandled HizoFS record kind: ${String(_ex)}`);
    }
    }
    return {
      ...decoded,
      physicalByteLength: physical.byteLength,
      physicalBytes: physical,
      physicalPath,
    };
  }

  resolveObjectId({ objectId }: { objectId: string }): Promise<string> {
    this.assertOpen();
    return this.relocationStore.resolve({ objectId });
  }

  publishRelocations({ mappings }: {
    mappings: ReadonlyMap<string, string>;
  }): Promise<HizoFSRelocationSnapshot> {
    this.assertOpen();
    return this.relocationStore.publish({ mappings });
  }

  readRelocationSnapshot(): Promise<HizoFSRelocationSnapshot> {
    this.assertOpen();
    return this.relocationStore.load();
  }

  async listPhysicalObjects({ persistMissingSegmentIndexes = false }: {
    persistMissingSegmentIndexes?: boolean;
  } = {}): Promise<HizoFSPhysicalObjectListing> {
    this.assertOpen();
    const entries: HizoFSPhysicalObjectEntry[] = [];
    const ignoredPhysicalPaths: string[] = [];
    let discoveredSegmentCount = 0;
    let readableSegmentCount = 0;
    let authenticatedIndexCount = 0;
    let rebuiltMissingIndexCount = 0;
    let rebuiltInvalidIndexCount = 0;
    for (const segmentType of ['metadata', 'data'] as const) {
      const typePath = ['segments', segmentDirectoryName({ segmentType })] as const;
      let shards: readonly {
        readonly name: string;
        readonly kind: 'file' | 'directory';
      }[];
      try {
        const found: {
          readonly name: string;
          readonly kind: 'file' | 'directory';
        }[] = [];
        for await (const entry of this.backingStore.list({ path: typePath })) {
          found.push(entry);
        }
        shards = found;
      } catch {
        continue;
      }
      for (const shardEntry of shards) {
        const shardPath = [...typePath, shardEntry.name];
        if (shardEntry.kind !== 'directory' || !/^[0-9a-f]{2}$/u.test(shardEntry.name)) {
          ignoredPhysicalPaths.push(physicalPathKey({ path: shardPath }));
          continue;
        }
        for await (const fileEntry of this.backingStore.list({ path: shardPath })) {
          const physicalPath = [...shardPath, fileEntry.name];
          if (fileEntry.kind !== 'file' || !fileEntry.name.endsWith('.seg')) {
            ignoredPhysicalPaths.push(physicalPathKey({ path: physicalPath }));
            continue;
          }
          const encodedSegmentId = fileEntry.name.slice(0, -'.seg'.length);
          let segmentId: Uint8Array;
          try {
            segmentId = decodeHizoFSSegmentId({ value: encodedSegmentId });
            if (getHizoFSSegmentShard({ segmentId }) !== shardEntry.name) {
              throw new Error('segment shard mismatch');
            }
          } catch {
            ignoredPhysicalPaths.push(physicalPathKey({ path: physicalPath }));
            continue;
          }
          const physicalByteLength = await this.backingStore.getFileSize({ path: physicalPath });
          if (physicalByteLength === undefined) continue;
          discoveredSegmentCount += 1;
          try {
            const indexed = await this.readOrRebuildSegmentIndex({
              segmentType,
              segmentId,
              physicalPath,
              physicalByteLength,
              persistMissingSegmentIndex:
                persistMissingSegmentIndexes && !this.isActiveSegment({ segmentType, segmentId }),
              ignoredPhysicalPaths,
            });
            readableSegmentCount += 1;
            switch (indexed.source) {
            case 'authenticated':
              authenticatedIndexCount += 1;
              break;
            case 'rebuilt_missing':
              rebuiltMissingIndexCount += 1;
              break;
            case 'rebuilt_invalid':
              rebuiltInvalidIndexCount += 1;
              break;
            default: {
              const _ex: never = indexed.source;
              throw new Error(`Unhandled HizoFS segment-index source: ${String(_ex)}`);
            }
            }
            for (const indexedEntry of indexed.entries) {
              if (segmentTypeForRecordKind({ kind: indexedEntry.kind }) !== segmentType) {
                throw new HizoFSCorruptionError({
                  message: 'HizoFS segment-index record kind does not match its segment type',
                  cause: undefined,
                });
              }
              entries.push({
                objectId: encodeHizoFSObjectReference({
                  reference: {
                    kind: indexedEntry.kind,
                    homeSegmentId: segmentId,
                    homeOffset: indexedEntry.homeOffset,
                    storedLength: indexedEntry.storedLength,
                  },
                }),
                physicalPath,
                physicalByteLength,
              });
            }
          } catch {
            ignoredPhysicalPaths.push(physicalPathKey({ path: physicalPath }));
          }
        }
      }
    }
    entries.sort((left, right) => compareCanonicalObjectIds({
      left: left.objectId,
      right: right.objectId,
    }));
    ignoredPhysicalPaths.sort();
    return {
      entries,
      ignoredPhysicalPaths,
      segmentIndexes: {
        discoveredSegmentCount,
        readableSegmentCount,
        authenticatedIndexCount,
        rebuiltMissingIndexCount,
        rebuiltInvalidIndexCount,
      },
    };
  }

  async selectPartialSegmentCompactionCandidates({
    reachableObjectIds,
    minimumDeadRecordByteLength,
    maximumLiveRecordByteLength,
    maximumLiveRecordCount,
    maximumCandidateCount,
  }: {
    reachableObjectIds: readonly string[];
    minimumDeadRecordByteLength: number;
    maximumLiveRecordByteLength: number;
    maximumLiveRecordCount: number;
    maximumCandidateCount: number;
  }): Promise<readonly HizoFSPartialSegmentCompactionCandidate[]> {
    for (const [field, value] of [
      ['minimum dead record byte length', minimumDeadRecordByteLength],
      ['maximum live record byte length', maximumLiveRecordByteLength],
      ['maximum live record count', maximumLiveRecordCount],
      ['maximum candidate count', maximumCandidateCount],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`HizoFS compaction ${field} must be a non-negative safe integer`);
      }
    }
    const reachable = new Set(reachableObjectIds);
    const listing = await this.listPhysicalObjects({ persistMissingSegmentIndexes: true });
    const byPath = new Map<string, HizoFSPhysicalObjectEntry[]>();
    for (const entry of listing.entries) {
      const group = byPath.get(physicalPathKey({ path: entry.physicalPath })) ?? [];
      group.push(entry);
      byPath.set(physicalPathKey({ path: entry.physicalPath }), group);
    }
    const candidates: HizoFSPartialSegmentCompactionCandidate[] = [];
    for (const group of byPath.values()) {
      const sorted = [...group].sort((left, right) => compareCanonicalObjectIds({
        left: left.objectId,
        right: right.objectId,
      }));
      const representative = sorted[0];
      if (representative === undefined) continue;
      const live = sorted.filter(entry => reachable.has(entry.objectId));
      const dead = sorted.filter(entry => !reachable.has(entry.objectId));
      if (live.length === 0 || dead.length === 0) continue;
      const liveRecordByteLength = live.reduce((total, entry) => (
        total + decodeHizoFSObjectReference({ value: entry.objectId }).storedLength
      ), 0);
      const deadRecordByteLength = dead.reduce((total, entry) => (
        total + decodeHizoFSObjectReference({ value: entry.objectId }).storedLength
      ), 0);
      if (deadRecordByteLength < minimumDeadRecordByteLength
        || liveRecordByteLength > maximumLiveRecordByteLength
        || live.length > maximumLiveRecordCount) continue;
      candidates.push({
        representativeObjectId: representative.objectId,
        liveObjectIds: live.map(entry => entry.objectId),
        deadObjectIds: dead.map(entry => entry.objectId),
        physicalPath: representative.physicalPath,
        expectedPhysicalByteLength: representative.physicalByteLength,
        liveRecordByteLength,
        deadRecordByteLength,
      });
    }
    candidates.sort((left, right) => {
      if (left.deadRecordByteLength !== right.deadRecordByteLength) {
        return right.deadRecordByteLength - left.deadRecordByteLength;
      }
      return compareCanonicalObjectIds({
        left: left.representativeObjectId,
        right: right.representativeObjectId,
      });
    });
    return candidates.slice(0, maximumCandidateCount);
  }

  async selectWholeSegmentReclaimCandidates({ unreachableObjectIds }: {
    unreachableObjectIds: readonly string[];
  }): Promise<readonly HizoFSWholeSegmentReclaimCandidate[]> {
    const unreachable = new Set(unreachableObjectIds);
    const listing = await this.listPhysicalObjects({ persistMissingSegmentIndexes: true });
    const byPath = new Map<string, HizoFSPhysicalObjectEntry[]>();
    for (const entry of listing.entries) {
      const key = physicalPathKey({ path: entry.physicalPath });
      const group = byPath.get(key) ?? [];
      group.push(entry);
      byPath.set(key, group);
    }
    const reclaimable: HizoFSWholeSegmentReclaimCandidate[] = [];
    for (const group of byPath.values()) {
      if (group.length > 0 && group.every(entry => unreachable.has(entry.objectId))) {
        const sorted = [...group].sort((left, right) => compareCanonicalObjectIds({
          left: left.objectId,
          right: right.objectId,
        }));
        const representative = sorted[0];
        if (representative === undefined) continue;
        const expectedPhysicalByteLength = representative.physicalByteLength;
        if (!sorted.every(entry => entry.physicalByteLength === expectedPhysicalByteLength)) {
          throw new HizoFSCorruptionError({
            message: 'HizoFS physical-object listing disagrees on one segment length',
            cause: undefined,
          });
        }
        reclaimable.push({
          representativeObjectId: representative.objectId,
          objectIds: sorted.map(entry => entry.objectId),
          physicalPath: representative.physicalPath,
          expectedPhysicalByteLength,
        });
      }
    }
    reclaimable.sort((left, right) => (
      compareCanonicalObjectIds({
        left: left.representativeObjectId,
        right: right.representativeObjectId,
      })
    ));
    return reclaimable;
  }

  async removeWholeSegmentIfUnchanged({
    objectId,
    expectedPhysicalByteLength,
  }: {
    objectId: string;
    expectedPhysicalByteLength: number;
  }): Promise<HizoFSWholeSegmentRemovalResult> {
    this.assertOpen();
    if (!Number.isSafeInteger(expectedPhysicalByteLength) || expectedPhysicalByteLength < 0) {
      throw new Error('Expected HizoFS segment length must be a non-negative safe integer');
    }
    const reference = decodeHizoFSObjectReference({ value: objectId });
    const segmentType = segmentTypeForRecordKind({ kind: reference.kind });
    const path = getSegmentPath({ segmentType, segmentId: reference.homeSegmentId });
    const actualPhysicalByteLength = await this.backingStore.getFileSize({ path });
    if (actualPhysicalByteLength === undefined) return 'missing';
    if (actualPhysicalByteLength !== expectedPhysicalByteLength) return 'changed';
    const indexPath = getSegmentIndexPath({ segmentType, segmentId: reference.homeSegmentId });
    try {
      await this.backingStore.remove({ path: indexPath, recursive: false });
    } catch {
      // The index is derived and reconstructible. A missing or concurrently
      // removed index must not prevent reclaiming the authenticated segment.
    }
    await this.backingStore.remove({ path, recursive: false });
    this.validatedSegmentKeys.delete(
      this.getSegmentValidationKey({ segmentType, segmentId: reference.homeSegmentId }),
    );
    this.recordKeyPromises.delete(encodeHizoFSSegmentId({ segmentId: reference.homeSegmentId }));
    return 'removed';
  }

  private isActiveSegment({ segmentType, segmentId }: {
    segmentType: 'metadata' | 'data';
    segmentId: Uint8Array;
  }): boolean {
    const writer = this.getActiveWriter({ segmentType });
    return writer !== undefined && sameSegmentId({ left: writer.segmentId, right: segmentId });
  }

  private async readOrRebuildSegmentIndex({
    segmentType,
    segmentId,
    physicalPath,
    physicalByteLength,
    persistMissingSegmentIndex,
    ignoredPhysicalPaths,
  }: {
    segmentType: 'metadata' | 'data';
    segmentId: Uint8Array;
    physicalPath: readonly string[];
    physicalByteLength: number;
    persistMissingSegmentIndex: boolean;
    ignoredPhysicalPaths: string[];
  }): Promise<{
    readonly entries: readonly HizoFSSegmentIndexEntry[];
    readonly source: 'authenticated' | 'rebuilt_missing' | 'rebuilt_invalid';
  }> {
    if (physicalByteLength < HIZOFS_SEGMENT_HEADER_BYTE_LENGTH) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS segment is shorter than its header',
        cause: undefined,
      });
    }
    const segmentHeader = await this.backingStore.readRange({
      path: physicalPath,
      offset: 0,
      byteLength: HIZOFS_SEGMENT_HEADER_BYTE_LENGTH,
    });
    if (segmentHeader === undefined) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS segment disappeared while reading its header',
        cause: undefined,
      });
    }
    await decodeHizoFSSegmentHeader({
      rootKey: this.rootKey,
      fileSystemId: this.fileSystemId,
      expectedSegmentId: segmentId,
      bytes: segmentHeader,
    });

    const indexPath = getSegmentIndexPath({ segmentType, segmentId });
    const persisted = await this.backingStore.read({ path: indexPath });
    let persistedIndexWasInvalid = false;
    if (persisted !== undefined) {
      try {
        const decoded = await decodeHizoFSSegmentIndex({
          rootKey: this.rootKey,
          fileSystemId: this.fileSystemId,
          expectedSegmentType: segmentType,
          expectedSegmentId: segmentId,
          expectedSegmentByteLength: physicalByteLength,
          bytes: persisted,
        });
        return { entries: decoded.entries, source: 'authenticated' };
      } catch {
        persistedIndexWasInvalid = true;
        ignoredPhysicalPaths.push(physicalPathKey({ path: indexPath }));
      }
    }

    const rebuilt: HizoFSSegmentIndexEntry[] = [];
    let offset = HIZOFS_SEGMENT_HEADER_BYTE_LENGTH;
    while (offset < physicalByteLength) {
      if (offset + HIZOFS_RECORD_FRAME_HEADER_BYTE_LENGTH > physicalByteLength) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS segment has a truncated trailing record header',
          cause: undefined,
        });
      }
      const frameHeader = await this.backingStore.readRange({
        path: physicalPath,
        offset,
        byteLength: HIZOFS_RECORD_FRAME_HEADER_BYTE_LENGTH,
      });
      if (frameHeader === undefined) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS segment disappeared while rebuilding its index',
          cause: undefined,
        });
      }
      const reference = decodeHizoFSRecordFrameReference({ headerBytes: frameHeader });
      if (
        !sameSegmentId({ left: reference.homeSegmentId, right: segmentId })
        || reference.homeOffset !== offset
        || segmentTypeForRecordKind({ kind: reference.kind }) !== segmentType
      ) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS segment record reference does not match its physical position',
          cause: undefined,
        });
      }
      const nextOffset = offset + reference.storedLength;
      if (!Number.isSafeInteger(nextOffset) || nextOffset > physicalByteLength) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS segment record exceeds the physical segment length',
          cause: undefined,
        });
      }
      rebuilt.push({
        kind: reference.kind,
        homeOffset: reference.homeOffset,
        storedLength: reference.storedLength,
      });
      offset = nextOffset;
    }
    if (persistMissingSegmentIndex) {
      const encoded = await encodeHizoFSSegmentIndex({
        rootKey: this.rootKey,
        fileSystemId: this.fileSystemId,
        index: {
          segmentType,
          segmentId,
          segmentByteLength: physicalByteLength,
          entries: rebuilt,
        },
      });
      await this.backingStore.write({ path: indexPath, bytes: encoded });
    }
    return {
      entries: rebuilt,
      source: persistedIndexWasInvalid ? 'rebuilt_invalid' : 'rebuilt_missing',
    };
  }

  releaseActiveWriters(): Promise<void> {
    this.assertOpen();
    return this.runWithReservationLock({
      operation: async () => {
        await this.closeActiveWriters({ flush: false });
        await this.closePersistentHeadFiles();
      },
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.runWithReservationLock({
      operation: async () => {
        await this.closeActiveWriters({ flush: false });
        await this.closePersistentHeadFiles();
      },
    });
    this.recordKeyPromises.clear();
  }

  getPhysicalPath({ objectId }: { objectId: string }): readonly string[] {
    const reference = decodeHizoFSObjectReference({ value: objectId });
    return getSegmentPath({
      segmentType: segmentTypeForRecordKind({ kind: reference.kind }),
      segmentId: reference.homeSegmentId,
    });
  }

  private reservePipelinedRecordGroup({
    records,
    startIndex,
    segmentType,
  }: {
    records: readonly HizoFSLazySegmentRecord[];
    startIndex: number;
    segmentType: 'metadata' | 'data';
  }): Promise<{
    readonly plans: readonly PipelinedSegmentRecordPlan[];
    readonly endIndex: number;
  }> {
    return this.runWithReservationLock({
      operation: async () => {
        const payloadTargetByteLength = (() => {
          switch (segmentType) {
          case 'data':
            return DATA_SEGMENT_PAYLOAD_TARGET_BYTE_LENGTH;
          case 'metadata':
            return METADATA_SEGMENT_PAYLOAD_TARGET_BYTE_LENGTH;
          default: {
            const _ex: never = segmentType;
            throw new Error(
              `Unhandled HizoFS segment type: ${String(_ex)}`,
            );
          }
          }
        })();
        let writer = await this.ensureWriter({ segmentType });
        const firstRecord = records[startIndex];
        if (firstRecord === undefined) {
          return { plans: [], endIndex: startIndex };
        }
        if (!writer.canFit({
          rotationPayloadByteLength: firstRecord.rotationPayloadByteLength,
          payloadTargetByteLength,
        })) {
          await writer.close({ flush: true });
          this.setActiveWriter({ segmentType, writer: undefined });
          writer = await this.ensureWriter({ segmentType });
        }

        const plans: PipelinedSegmentRecordPlan[] = [];
        let index = startIndex;
        while (index < records.length) {
          const record = records[index];
          if (record === undefined) break;
          if (!writer.canFit({
            rotationPayloadByteLength: record.rotationPayloadByteLength,
            payloadTargetByteLength,
          })) {
            break;
          }
          const reference = writer.reserve({
            kind: record.kind,
            plaintextByteLength: record.plaintextByteLength,
            rotationPayloadByteLength: record.rotationPayloadByteLength,
          });
          plans.push({ writer, reference, record });
          index += 1;
        }
        if (plans.length === 0) {
          throw new Error('HizoFS record pipeline could not reserve its first record');
        }
        return { plans, endIndex: index };
      },
    });
  }

  private async writePipelinedRecordGroup({
    plans,
    maximumPlaintextRecordsInFlight,
    maximumRecordsPerPhysicalWrite,
  }: {
    plans: readonly PipelinedSegmentRecordPlan[];
    maximumPlaintextRecordsInFlight: number;
    maximumRecordsPerPhysicalWrite: number;
  }): Promise<readonly string[]> {
    if (plans.length === 0) return [];
    const semaphore = new Semaphore({
      maxConcurrency: maximumPlaintextRecordsInFlight,
    });
    let pipelineFailure: unknown | undefined;
    const encodedRecords = plans.map(plan => semaphore.run({
      task: async () => {
        if (pipelineFailure !== undefined) throw pipelineFailure;
        let plaintext: Uint8Array | undefined;
        try {
          plaintext = await plan.record.createPlaintext();
          if (plaintext.byteLength !== plan.record.plaintextByteLength) {
            throw new Error(
              'HizoFS lazy record plaintext length does not match its reservation',
            );
          }
          return await plan.writer.encodeRecord({
            reference: plan.reference,
            plaintext,
          });
        } catch (error) {
          pipelineFailure ??= error;
          throw error;
        } finally {
          plaintext?.fill(0);
          plan.record.discardPlaintext();
        }
      },
    }));

    const writes: Promise<void>[] = [];
    for (
      let batchStart = 0;
      batchStart < plans.length;
      batchStart += maximumRecordsPerPhysicalWrite
    ) {
      const batchPlans = plans.slice(
        batchStart,
        batchStart + maximumRecordsPerPhysicalWrite,
      );
      const writer = batchPlans[0]?.writer;
      if (writer === undefined) {
        throw new Error('HizoFS record pipeline produced an empty write batch');
      }
      writes.push(writer.schedulePreparedBatchWrite({
        records: batchPlans.map((plan, batchIndex) => {
          const encodedBytes = encodedRecords[batchStart + batchIndex];
          if (encodedBytes === undefined) {
            throw new Error('HizoFS record pipeline omitted encoded bytes');
          }
          return { reference: plan.reference, encodedBytes };
        }),
      }));
    }

    const results = await Promise.allSettled(writes);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure !== undefined) throw failure.reason;
    return plans.map(({ reference }) =>
      encodeHizoFSObjectReference({ reference })
    );
  }

  private reserveAndScheduleWrite({
    kind,
    plaintext,
    rotationPayloadByteLength,
  }: {
    kind: HizoFSRecordKind;
    plaintext: Uint8Array;
    rotationPayloadByteLength: number;
  }): Promise<SegmentReservation> {
    return this.runWithReservationLock({
      operation: async () => {
        this.assertOpen();
        const segmentType = segmentTypeForRecordKind({ kind });
        const payloadTargetByteLength = (() => {
          switch (segmentType) {
          case 'data':
            return DATA_SEGMENT_PAYLOAD_TARGET_BYTE_LENGTH;
          case 'metadata':
            return METADATA_SEGMENT_PAYLOAD_TARGET_BYTE_LENGTH;
          default: {
            const _ex: never = segmentType;
            throw new Error(`Unhandled active HizoFS segment type: ${String(_ex)}`);
          }
          }
        })();
        let writer = await this.ensureWriter({ segmentType });
        if (!writer.canFit({
          rotationPayloadByteLength,
          payloadTargetByteLength,
        })) {
          await writer.close({ flush: true });
          this.setActiveWriter({ segmentType, writer: undefined });
          writer = await this.ensureWriter({ segmentType });
        }
        const reference = writer.reserve({
          kind,
          plaintextByteLength: plaintext.byteLength,
          rotationPayloadByteLength,
        });
        return {
          writer,
          reference,
          write: writer.scheduleWrite({ reference, plaintext }),
        };
      },
    });
  }

  private reserveAndScheduleBatchWrite({
    records,
    segmentType,
  }: {
    records: readonly {
      readonly kind: HizoFSRecordKind;
      readonly plaintext: Uint8Array;
      readonly rotationPayloadByteLength: number;
    }[];
    segmentType: 'metadata' | 'data';
  }): Promise<SegmentBatchReservation> {
    return this.runWithReservationLock({
      operation: async () => {
        this.assertOpen();
        const payloadTargetByteLength = (() => {
          switch (segmentType) {
          case 'data':
            return DATA_SEGMENT_PAYLOAD_TARGET_BYTE_LENGTH;
          case 'metadata':
            return METADATA_SEGMENT_PAYLOAD_TARGET_BYTE_LENGTH;
          default: {
            const _ex: never = segmentType;
            throw new Error(
              `Unhandled active HizoFS segment type: ${String(_ex)}`,
            );
          }
          }
        })();
        let writer = await this.ensureWriter({ segmentType });
        let pendingRecords: {
          readonly reference: HizoFSObjectReference;
          readonly plaintext: Uint8Array;
        }[] = [];
        const references: HizoFSObjectReference[] = [];
        const writes: Promise<void>[] = [];
        const schedulePending = (): void => {
          if (pendingRecords.length === 0) return;
          writes.push(writer.scheduleBatchWrite({ records: pendingRecords }));
          pendingRecords = [];
        };

        for (const record of records) {
          if (!writer.canFit({
            rotationPayloadByteLength: record.rotationPayloadByteLength,
            payloadTargetByteLength,
          })) {
            schedulePending();
            await writer.close({ flush: true });
            this.setActiveWriter({ segmentType, writer: undefined });
            writer = await this.ensureWriter({ segmentType });
          }
          const reference = writer.reserve({
            kind: record.kind,
            plaintextByteLength: record.plaintext.byteLength,
            rotationPayloadByteLength: record.rotationPayloadByteLength,
          });
          references.push(reference);
          pendingRecords.push({
            reference,
            plaintext: record.plaintext,
          });
        }
        schedulePending();
        return { references, writes };
      },
    });
  }

  private async runWithReservationLock<T>({ operation }: {
    operation: () => Promise<T>;
  }): Promise<T> {
    const previous = this.reservationChain;
    const completion = Promise.withResolvers<void>();
    const tail = previous.then(() => completion.promise);
    this.reservationChain = tail;
    await previous;
    try {
      return await operation();
    } finally {
      completion.resolve();
      if (this.reservationChain === tail) {
        this.reservationChain = Promise.resolve();
      }
    }
  }

  private async ensureWriter({ segmentType }: {
    segmentType: 'metadata' | 'data';
  }): Promise<HizoFSActiveSegmentWriter> {
    const existing = this.getActiveWriter({ segmentType });
    if (existing !== undefined) {
      if (existing.isUsable()) return existing;
      await existing.close({ flush: false });
      this.setActiveWriter({ segmentType, writer: undefined });
    }
    // Each runtime owns fresh random segment IDs, so retaining its handles does
    // not let independent tabs allocate the same tail. Reopened runtimes create
    // new active segments instead of appending to a segment named by the head.
    const writer = await HizoFSActiveSegmentWriter.create({
      backingStore: this.backingStore,
      rootKey: this.rootKey,
      fileSystemId: this.fileSystemId,
      segmentType,
      diagnostics: this.diagnostics,
    });
    this.setActiveWriter({ segmentType, writer });
    this.validatedSegmentKeys.add(
      this.getSegmentValidationKey({ segmentType, segmentId: writer.segmentId }),
    );
    return writer;
  }

  private async replaceHead({ scope, slot, physical }: {
    scope: HizoFSHeadScope;
    slot: 0 | 1;
    physical: Uint8Array;
  }): Promise<void> {
    const path = getHizoFSHeadPath({ scope, slot });
    const pathKey = physicalPathKey({ path });
    const persistent = this.headHandleRetention === 'persistent';
    const file = persistent
      ? await this.ensurePersistentHeadFile({ path, pathKey })
      : await this.backingStore.openRandomAccessFile({
        path,
        mode: 'read_write',
        create: true,
      });
    let closed = persistent;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await file.close();
    };
    try {
      const previousSize = await file.getSize();
      await file.writeAt({ offset: 0, bytes: physical });
      if (previousSize > physical.byteLength) {
        await file.truncate({ size: physical.byteLength });
      }
      await file.flush();
      if (!persistent) await close();
    } catch (error) {
      if (persistent && this.persistentHeadFiles.get(pathKey) === file) {
        this.persistentHeadFiles.delete(pathKey);
        try {
          await file.close();
        } catch {
          // Preserve the original publication error before independent readback.
        }
      }
      try {
        await close();
      } catch {
        // Preserve the original publication error before independent readback.
      }
      try {
        const persisted = await this.backingStore.read({ path });
        if (persisted !== undefined && bytesEqual({ left: persisted, right: physical })) return;
      } catch {
        // Preserve the original publication error when completion is uncertain.
      }
      throw error;
    } finally {
      if (!closed) await close();
    }
  }

  private async ensurePersistentHeadFile({
    path,
    pathKey,
  }: {
    path: readonly string[];
    pathKey: string;
  }): Promise<HizoFSRandomAccessFile> {
    const existing = this.persistentHeadFiles.get(pathKey);
    if (existing !== undefined) return existing;
    const file = await this.backingStore.openRandomAccessFile({
      path,
      mode: 'read_write',
      create: true,
    });
    this.persistentHeadFiles.set(pathKey, file);
    return file;
  }

  private async closePersistentHeadFiles(): Promise<void> {
    const files = [...this.persistentHeadFiles.values()];
    this.persistentHeadFiles.clear();
    const results = await Promise.allSettled(files.map(async file => file.close()));
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to close HizoFS head files');
    }
  }

  private observeCommittedMetadataSegment({ sequence, segmentId, durableTail }: {
    sequence: number;
    segmentId: Uint8Array;
    durableTail: number;
  }): void {
    const current = this.committedMetadataSegment;
    if (current !== undefined && current.sequence > sequence) return;
    this.committedMetadataSegment = {
      sequence,
      segmentId: segmentId.slice(),
      durableTail,
    };
  }

  private getActiveWriter({ segmentType }: {
    segmentType: HizoFSSegmentType;
  }): HizoFSActiveSegmentWriter | undefined {
    switch (segmentType) {
    case 'metadata':
      return this.activeMetadataWriter;
    case 'data':
      return this.activeDataWriter;
    case 'relocation':
      return undefined;
    default: {
      const _ex: never = segmentType;
      throw new Error(`Unhandled HizoFS segment type: ${String(_ex)}`);
    }
    }
  }

  private setActiveWriter({ segmentType, writer }: {
    segmentType: 'metadata' | 'data';
    writer: HizoFSActiveSegmentWriter | undefined;
  }): void {
    switch (segmentType) {
    case 'metadata':
      this.activeMetadataWriter = writer;
      return;
    case 'data':
      this.activeDataWriter = writer;
      return;
    default: {
      const _ex: never = segmentType;
      throw new Error(`Unhandled HizoFS active segment type: ${String(_ex)}`);
    }
    }
  }

  private async closeActiveWriters({ flush }: {
    flush: boolean;
  }): Promise<void> {
    const writers = [this.activeMetadataWriter, this.activeDataWriter]
      .filter((writer): writer is HizoFSActiveSegmentWriter => writer !== undefined);
    this.activeMetadataWriter = undefined;
    this.activeDataWriter = undefined;
    const results = await Promise.allSettled(
      writers.map(async writer => writer.close({ flush })),
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to close HizoFS segment writers');
    }
  }

  private async ensureSegmentValidated({ segmentType, segmentId, path }: {
    segmentType: HizoFSSegmentType;
    segmentId: Uint8Array;
    path: readonly string[];
  }): Promise<void> {
    const key = this.getSegmentValidationKey({ segmentType, segmentId });
    if (this.validatedSegmentKeys.has(key)) return;
    const header = await this.backingStore.readRange({
      path,
      offset: 0,
      byteLength: HIZOFS_SEGMENT_HEADER_BYTE_LENGTH,
    });
    if (header === undefined) return;
    const decoded = await decodeHizoFSSegmentHeader({
      rootKey: this.rootKey,
      fileSystemId: this.fileSystemId,
      expectedSegmentId: segmentId,
      bytes: header,
    });
    if (decoded.segmentType !== segmentType) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS segment type does not match the referenced record kind',
        cause: undefined,
      });
    }
    this.validatedSegmentKeys.add(key);
  }

  private getRecordKey({ segmentId }: { segmentId: Uint8Array }): Promise<CryptoKey> {
    const key = encodeHizoFSSegmentId({ segmentId });
    const existing = this.recordKeyPromises.get(key);
    if (existing !== undefined) {
      this.recordKeyPromises.delete(key);
      this.recordKeyPromises.set(key, existing);
      return existing;
    }
    const derived = deriveHizoFSSegmentRecordKey({
      rootKey: this.rootKey,
      fileSystemId: this.fileSystemId,
      homeSegmentId: segmentId,
    });
    this.recordKeyPromises.set(key, derived);
    while (this.recordKeyPromises.size > 1024) {
      const oldest = this.recordKeyPromises.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.recordKeyPromises.delete(oldest);
    }
    return derived;
  }

  private getSegmentValidationKey({ segmentType, segmentId }: {
    segmentType: HizoFSSegmentType;
    segmentId: Uint8Array;
  }): string {
    return `${segmentType}/${encodeHizoFSSegmentId({ segmentId })}`;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('HizoFS segmented store is closed');
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  DATA_SEGMENT_PAYLOAD_TARGET_BYTE_LENGTH,
  METADATA_SEGMENT_PAYLOAD_TARGET_BYTE_LENGTH,
  getHizoFSHeadPath,
  getSegmentPath,
};
