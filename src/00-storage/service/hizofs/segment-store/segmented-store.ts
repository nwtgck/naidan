import { HizoFSSuperblockSchemaDto } from '@/00-storage/00-dto/hizofs.dto';
import type {
  HizoFSBackingStore,
  HizoFSRandomAccessFile,
} from '@/00-storage/service/hizofs/backing-store/backing-store';
import { bytesEqual } from '@/00-storage/service/hizofs/bytes';
import { HizoFSCorruptionError } from '@/00-storage/service/hizofs/errors';
import type { HizoFSRuntimeDiagnostics } from '@/00-storage/service/hizofs/file-system/diagnostics';
import type { HizoFSRecordKind } from '@/00-storage/service/hizofs/format/record';
import { deriveHizoFSSegmentRecordKey } from '@/00-storage/service/hizofs/segment-store/segment-crypto';
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

const METADATA_SEGMENT_PAYLOAD_TARGET_BYTE_LENGTH = 1024 * 1024;
const DATA_SEGMENT_PAYLOAD_TARGET_BYTE_LENGTH = 16 * 1024 * 1024;

export type HizoFSPhysicalObjectEntry = {
  readonly objectId: string;
  readonly physicalPath: readonly string[];
  readonly physicalByteLength: number;
};

export type HizoFSPhysicalObjectListing = {
  readonly entries: readonly HizoFSPhysicalObjectEntry[];
  readonly ignoredPhysicalPaths: readonly string[];
};

export type HizoFSWholeSegmentReclaimCandidate = {
  readonly representativeObjectId: string;
  readonly objectIds: readonly string[];
  readonly physicalPath: readonly string[];
  readonly expectedPhysicalByteLength: number;
};

export type HizoFSWholeSegmentRemovalResult = 'removed' | 'missing' | 'changed';

export type HizoFSPhysicalRecord = {
  readonly objectId: string;
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

function getHeadPath({ slot }: { slot: 0 | 1 }): readonly string[] {
  return [`head-${String(slot)}.hfs`];
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
    segmentType: HizoFSSegmentType;
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
    this.assertOpen();
    if (!sameSegmentId({ left: reference.homeSegmentId, right: this.segmentId })) {
      throw new Error('HizoFS segment writer received a foreign object reference');
    }
    const write = (async () => {
      const encode = async () => encodeHizoFSRecordFrame({
        rootKey: this.rootKey,
        fileSystemId: this.fileSystemId,
        reference,
        plaintext,
        recordKey: await this.recordKey,
      });
      const encoded = this.diagnostics === undefined
        ? await encode()
        : await this.diagnostics.measureAsync({ phase: 'object_encrypt', operation: encode });
      await this.file.writeAt({
        offset: reference.homeOffset,
        bytes: encoded.bytes,
      });
    })();
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
  }

  private readonly backingStore: HizoFSBackingStore;
  private readonly rootKey: CryptoKey;
  private readonly fileSystemId: string;
  private readonly diagnostics: HizoFSRuntimeDiagnostics | undefined;
  private activeMetadataWriter: HizoFSActiveSegmentWriter | undefined;
  private activeDataWriter: HizoFSActiveSegmentWriter | undefined;
  private readonly persistentHeadFiles = new Map<0 | 1, HizoFSRandomAccessFile>();
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
    const reference = decodeHizoFSObjectReference({ value: objectId });
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
      physicalPath,
      physicalBytes: physical,
      plaintext,
      kind: reference.kind,
    };
  }

  async writeHead({ slot, sequence, recordBytes }: {
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
          slot,
          activeMetadataSegmentId: metadataSegmentId,
          activeMetadataDurableTail: metadataDurableTail,
          recordBytes,
        });
        await this.replaceHead({ slot, physical });
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

  async readHeadPhysical({ slot }: { slot: 0 | 1 }): Promise<{
    readonly physicalBytes: Uint8Array;
    readonly physicalPath: readonly string[];
  } | undefined> {
    this.assertOpen();
    const physicalPath = getHeadPath({ slot });
    const physicalBytes = await this.backingStore.read({ path: physicalPath });
    if (physicalBytes === undefined) return undefined;
    return { physicalBytes, physicalPath };
  }

  async readHead({ slot }: {
    slot: 0 | 1;
  }): Promise<(HizoFSDecodedHead & {
    readonly physicalByteLength: number;
    readonly physicalBytes: Uint8Array;
    readonly physicalPath: readonly string[];
  }) | undefined> {
    this.assertOpen();
    const physicalPath = getHeadPath({ slot });
    const physical = await this.backingStore.read({ path: physicalPath });
    if (physical === undefined) return undefined;
    const decoded = await decodeHizoFSHead({
      rootKey: this.rootKey,
      fileSystemId: this.fileSystemId,
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

  async listPhysicalObjects(): Promise<HizoFSPhysicalObjectListing> {
    this.assertOpen();
    // TODO(hizofs): Seal rotated segments with an authenticated record index
    // and read that index here instead of scanning every frame header. The
    // active append-only segment may still be scanned only to the durable tail
    // named by the selected head. The footer must be independently validated,
    // bounded, and reconstructible by an offline linear scan so corruption
    // cannot turn one footer length into an unbounded allocation or range read.
    const entries: HizoFSPhysicalObjectEntry[] = [];
    const ignoredPhysicalPaths: string[] = [];
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
          try {
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
            if (segmentHeader === undefined) continue;
            await decodeHizoFSSegmentHeader({
              rootKey: this.rootKey,
              fileSystemId: this.fileSystemId,
              expectedSegmentId: segmentId,
              bytes: segmentHeader,
            });
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
                  message: 'HizoFS segment disappeared while listing records',
                  cause: undefined,
                });
              }
              const reference = decodeHizoFSRecordFrameReference({
                headerBytes: frameHeader,
              });
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
              if (offset + reference.storedLength > physicalByteLength) {
                throw new HizoFSCorruptionError({
                  message: 'HizoFS segment record exceeds the physical segment length',
                  cause: undefined,
                });
              }
              entries.push({
                objectId: encodeHizoFSObjectReference({ reference }),
                physicalPath,
                physicalByteLength,
              });
              offset += reference.storedLength;
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
    return { entries, ignoredPhysicalPaths };
  }

  async selectWholeSegmentReclaimCandidates({ unreachableObjectIds }: {
    unreachableObjectIds: readonly string[];
  }): Promise<readonly HizoFSWholeSegmentReclaimCandidate[]> {
    // TODO(hizofs): Add partial-live segment compaction. Copy reachable frames
    // without re-encryption, publish a chain-free logical-reference relocation
    // index atomically, retain the old segment while any previous head/read
    // lease can still reference it, then remove it. Whole-dead deletion alone
    // cannot bound long-lived shared metadata segments.
    const unreachable = new Set(unreachableObjectIds);
    const listing = await this.listPhysicalObjects();
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
    await this.backingStore.remove({ path, recursive: false });
    this.validatedSegmentKeys.delete(
      this.getSegmentValidationKey({ segmentType, segmentId: reference.homeSegmentId }),
    );
    this.recordKeyPromises.delete(encodeHizoFSSegmentId({ segmentId: reference.homeSegmentId }));
    return 'removed';
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

  private async replaceHead({ slot, physical }: {
    slot: 0 | 1;
    physical: Uint8Array;
  }): Promise<void> {
    const path = getHeadPath({ slot });
    const persistent = this.headHandleRetention === 'persistent';
    const file = persistent
      ? await this.ensurePersistentHeadFile({ slot, path })
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
      if (persistent && this.persistentHeadFiles.get(slot) === file) {
        this.persistentHeadFiles.delete(slot);
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
    slot,
    path,
  }: {
    slot: 0 | 1;
    path: readonly string[];
  }): Promise<HizoFSRandomAccessFile> {
    const existing = this.persistentHeadFiles.get(slot);
    if (existing !== undefined) return existing;
    const file = await this.backingStore.openRandomAccessFile({
      path,
      mode: 'read_write',
      create: true,
    });
    this.persistentHeadFiles.set(slot, file);
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
  getHeadPath,
  getSegmentPath,
};
