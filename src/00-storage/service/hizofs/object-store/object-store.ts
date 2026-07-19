import { HizoFSSuperblockSchemaDto } from '@/00-storage/00-dto/hizofs.dto';
import type { HizoFSBackingStore } from '@/00-storage/service/hizofs/backing-store/backing-store';
import { HizoFSCorruptionError } from '@/00-storage/service/hizofs/errors';
import {
  decodeHizoFSRecord,
  decodeHizoFSRecordBinaryPayloadRange,
  encodeHizoFSRecord,
  getHizoFSRecordByteLength,
  type DecodedHizoFSRecord,
  type HizoFSRecordKind,
} from '@/00-storage/service/hizofs/format/record';
import type {
  HizoFSRuntimeDiagnosticCacheKind,
  HizoFSRuntimeDiagnostics,
} from '@/00-storage/service/hizofs/file-system/diagnostics';
import {
  HIZOFS_MAX_COALESCED_RECORDS_PER_WRITE,
  HizoFSSegmentedStore,
  type HizoFSPhysicalObjectListing,
  type HizoFSWholeSegmentReclaimCandidate,
  type HizoFSPartialSegmentCompactionCandidate,
  type HizoFSWholeSegmentRemovalResult,
} from '@/00-storage/service/hizofs/segment-store/segmented-store';
import { decodeHizoFSObjectReference } from '@/00-storage/service/hizofs/segment-store/object-reference';
import type { HizoFSPhysicalRecord } from '@/00-storage/service/hizofs/segment-store/segmented-store';
import type { HizoFSDecodedHead } from '@/00-storage/service/hizofs/segment-store/segment-format';

type CachedPlaintext = {
  readonly plaintext: Uint8Array;
};

class HizoFSPlaintextLruCache {
  constructor({
    byteLimit,
    entryLimit,
    cache,
    diagnostics,
  }: {
    byteLimit: number;
    entryLimit: number;
    cache: HizoFSRuntimeDiagnosticCacheKind;
    diagnostics?: HizoFSRuntimeDiagnostics;
  }) {
    if (!Number.isSafeInteger(byteLimit) || byteLimit < 0) {
      throw new Error('HizoFS object cache byte limit must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(entryLimit) || entryLimit < 0) {
      throw new Error('HizoFS object cache entry limit must be a non-negative safe integer');
    }
    this.byteLimit = byteLimit;
    this.entryLimit = entryLimit;
    this.cache = cache;
    this.diagnostics = diagnostics;
    this.recordState();
  }

  private readonly byteLimit: number;
  private readonly entryLimit: number;
  private readonly cache: HizoFSRuntimeDiagnosticCacheKind;
  private readonly diagnostics: HizoFSRuntimeDiagnostics | undefined;
  private readonly entries = new Map<string, CachedPlaintext>();
  private totalBytes = 0;

  get({ objectId }: { objectId: string }): Uint8Array | undefined {
    const entry = this.entries.get(objectId);
    if (entry === undefined) return undefined;
    this.entries.delete(objectId);
    this.entries.set(objectId, entry);
    return entry.plaintext;
  }

  set({ objectId, plaintext }: { objectId: string; plaintext: Uint8Array }): boolean {
    this.delete({ objectId, reason: 'explicit' });
    if (this.entryLimit === 0 || plaintext.byteLength > this.byteLimit) return false;
    this.entries.set(objectId, { plaintext });
    this.totalBytes += plaintext.byteLength;
    while (this.totalBytes > this.byteLimit || this.entries.size > this.entryLimit) {
      const oldestObjectId = this.entries.keys().next().value as string | undefined;
      if (oldestObjectId === undefined) break;
      this.delete({ objectId: oldestObjectId, reason: 'eviction' });
    }
    this.recordState();
    return true;
  }

  delete({
    objectId,
    reason,
  }: {
    objectId: string;
    reason: 'explicit' | 'eviction';
  }): void {
    const entry = this.entries.get(objectId);
    if (entry === undefined) return;
    this.entries.delete(objectId);
    this.totalBytes -= entry.plaintext.byteLength;
    entry.plaintext.fill(0);
    switch (reason) {
    case 'explicit':
      break;
    case 'eviction':
      this.diagnostics?.recordCacheEviction({ cache: this.cache });
      break;
    default: {
      const _ex: never = reason;
      throw new Error(`Unhandled HizoFS cache deletion reason: ${String(_ex)}`);
    }
    }
    this.recordState();
  }

  clear(): void {
    for (const objectId of [...this.entries.keys()]) {
      this.delete({ objectId, reason: 'explicit' });
    }
  }

  private recordState(): void {
    this.diagnostics?.recordCacheState({
      cache: this.cache,
      byteLength: this.totalBytes,
      entryCount: this.entries.size,
    });
  }
}

export type HizoFSObjectStoreRecord = {
  readonly kind: HizoFSRecordKind;
  readonly recordVersion: number;
  readonly metadata: unknown;
  readonly binaryPayload: Uint8Array;
};

export type HizoFSLazyFileChunkRecord = {
  readonly binaryPayloadByteLength: number;
  readonly createBinaryPayload: () => Promise<Uint8Array>;
  readonly discardBinaryPayload: () => void;
};

function getSegmentRotationPayloadByteLength({
  record,
  encodedRecordByteLength,
}: {
  record: HizoFSObjectStoreRecord;
  encodedRecordByteLength: number;
}): number {
  switch (record.kind) {
  case 'file_chunk':
    return record.binaryPayload.byteLength;
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
    return encodedRecordByteLength;
  default: {
    const _ex: never = record.kind;
    throw new Error(`Unhandled HizoFS record kind: ${String(_ex)}`);
  }
  }
}

export class HizoFSObjectStore {
  constructor({
    backingStore,
    rootKey,
    fileSystemId,
    metadataCacheByteLimit,
    metadataCacheEntryLimit,
    fileChunkCacheByteLimit,
    fileChunkCacheEntryLimit,
    fileChunkCacheAdmission,
    diagnostics,
  }: {
    backingStore: HizoFSBackingStore;
    rootKey: CryptoKey;
    fileSystemId: string;
    metadataCacheByteLimit: number;
    metadataCacheEntryLimit: number;
    fileChunkCacheByteLimit: number;
    fileChunkCacheEntryLimit: number;
    fileChunkCacheAdmission: 'read' | 'read_write';
    diagnostics?: HizoFSRuntimeDiagnostics;
  }) {
    switch (fileChunkCacheAdmission) {
    case 'read':
    case 'read_write':
      this.fileChunkCacheAdmission = fileChunkCacheAdmission;
      break;
    default: {
      const _ex: never = fileChunkCacheAdmission;
      throw new Error(`Unhandled HizoFS file chunk cache admission: ${String(_ex)}`);
    }
    }
    this.diagnostics = diagnostics;
    this.segmentedStore = new HizoFSSegmentedStore({
      backingStore,
      rootKey,
      fileSystemId,
      diagnostics,
    });
    this.metadataCache = new HizoFSPlaintextLruCache({
      byteLimit: metadataCacheByteLimit,
      entryLimit: metadataCacheEntryLimit,
      cache: 'metadata',
      diagnostics,
    });
    this.fileChunkCache = new HizoFSPlaintextLruCache({
      byteLimit: fileChunkCacheByteLimit,
      entryLimit: fileChunkCacheEntryLimit,
      cache: 'file_chunk',
      diagnostics,
    });
  }

  private readonly diagnostics: HizoFSRuntimeDiagnostics | undefined;
  private readonly fileChunkCacheAdmission: 'read' | 'read_write';
  private readonly metadataCache: HizoFSPlaintextLruCache;
  private readonly fileChunkCache: HizoFSPlaintextLruCache;
  private readonly segmentedStore: HizoFSSegmentedStore;

  clearPlaintextCaches(): void {
    this.metadataCache.clear();
    this.fileChunkCache.clear();
  }

  async releasePhysicalHandles(): Promise<void> {
    await this.segmentedStore.releaseActiveWriters();
  }

  async flushPendingRecords(): Promise<void> {
    await this.segmentedStore.flushPendingRecords();
  }

  async setHeadHandleRetention({ retention }: {
    retention: 'ephemeral' | 'persistent';
  }): Promise<void> {
    await this.segmentedStore.setHeadHandleRetention({ retention });
  }

  async close(): Promise<void> {
    this.clearPlaintextCaches();
    await this.segmentedStore.close();
  }

  async create({ record }: {
    record: HizoFSObjectStoreRecord;
  }): Promise<string> {
    const plaintext = this.encodeRecord({ record });
    let plaintextRetained = false;
    try {
      const objectId = await this.segmentedStore.createRecord({
        kind: record.kind,
        plaintext,
        rotationPayloadByteLength: getSegmentRotationPayloadByteLength({
          record,
          encodedRecordByteLength: plaintext.byteLength,
        }),
      });
      const reference = decodeHizoFSObjectReference({ value: objectId });
      this.diagnostics?.recordRecordWrite({
        kind: record.kind,
        plaintextByteLength: plaintext.byteLength,
        physicalByteLength: reference.storedLength,
      });
      plaintextRetained = this.cachePlaintext({
        objectId,
        kind: record.kind,
        plaintext,
        source: 'write',
      });
      return objectId;
    } finally {
      if (!plaintextRetained) plaintext.fill(0);
    }
  }

  async createMany({ records }: {
    records: readonly HizoFSObjectStoreRecord[];
  }): Promise<readonly string[]> {
    if (records.length === 0) return [];
    if (records.length > HIZOFS_MAX_COALESCED_RECORDS_PER_WRITE) {
      throw new Error(
        `HizoFS object batches may contain at most ${String(HIZOFS_MAX_COALESCED_RECORDS_PER_WRITE)} records`,
      );
    }
    const encoded = records.map(record => ({
      record,
      plaintext: this.encodeRecord({ record }),
      retained: false,
    }));
    try {
      const objectIds = await this.segmentedStore.createRecords({
        records: encoded.map(({ record, plaintext }) => ({
          kind: record.kind,
          plaintext,
          rotationPayloadByteLength: getSegmentRotationPayloadByteLength({
            record,
            encodedRecordByteLength: plaintext.byteLength,
          }),
        })),
      });
      if (objectIds.length !== encoded.length) {
        throw new Error('HizoFS object batch returned an inconsistent result count');
      }
      for (const [index, entry] of encoded.entries()) {
        const objectId = objectIds[index];
        if (objectId === undefined) {
          throw new Error('HizoFS object batch omitted an object identifier');
        }
        const reference = decodeHizoFSObjectReference({ value: objectId });
        this.diagnostics?.recordRecordWrite({
          kind: entry.record.kind,
          plaintextByteLength: entry.plaintext.byteLength,
          physicalByteLength: reference.storedLength,
        });
        entry.retained = this.cachePlaintext({
          objectId,
          kind: entry.record.kind,
          plaintext: entry.plaintext,
          source: 'write',
        });
      }
      return objectIds;
    } finally {
      for (const entry of encoded) {
        if (!entry.retained) entry.plaintext.fill(0);
      }
    }
  }

  async createFileChunksPipelined({
    records,
    maximumPlaintextRecordsInFlight,
  }: {
    records: readonly HizoFSLazyFileChunkRecord[];
    maximumPlaintextRecordsInFlight: number;
  }): Promise<readonly string[]> {
    if (records.length === 0) return [];
    const managedRecords = records.map(record => {
      let discarded = false;
      return {
        ...record,
        discardBinaryPayload: (): void => {
          if (discarded) return;
          discarded = true;
          record.discardBinaryPayload();
        },
      } satisfies HizoFSLazyFileChunkRecord;
    });

    try {
      if (
        !Number.isSafeInteger(maximumPlaintextRecordsInFlight)
        || maximumPlaintextRecordsInFlight < 1
      ) {
        throw new Error(
          'HizoFS maximum plaintext records in flight must be a positive safe integer',
        );
      }
      for (const record of managedRecords) {
        if (
          !Number.isSafeInteger(record.binaryPayloadByteLength)
          || record.binaryPayloadByteLength < 0
        ) {
          throw new Error(
            'HizoFS lazy file chunk payload length must be a non-negative safe integer',
          );
        }
      }
      switch (this.fileChunkCacheAdmission) {
      case 'read_write': {
        const objectIds: string[] = [];
        for (
          let batchStart = 0;
          batchStart < managedRecords.length;
          batchStart += HIZOFS_MAX_COALESCED_RECORDS_PER_WRITE
        ) {
          const batch = managedRecords.slice(
            batchStart,
            batchStart + HIZOFS_MAX_COALESCED_RECORDS_PER_WRITE,
          );
          const payloads: Uint8Array[] = [];
          try {
            for (const record of batch) {
              const binaryPayload = await record.createBinaryPayload();
              if (binaryPayload.byteLength !== record.binaryPayloadByteLength) {
                throw new Error(
                  'HizoFS lazy file chunk payload length does not match its declaration',
                );
              }
              payloads.push(binaryPayload);
            }
            const batchObjectIds = await this.createMany({
              records: payloads.map(binaryPayload => ({
                kind: 'file_chunk',
                recordVersion: 1,
                metadata: {},
                binaryPayload,
              })),
            });
            objectIds.push(...batchObjectIds);
          } finally {
            for (const record of batch) record.discardBinaryPayload();
          }
        }
        return objectIds;
      }
      case 'read':
        break;
      default: {
        const _ex: never = this.fileChunkCacheAdmission;
        throw new Error(
          `Unhandled HizoFS file chunk cache admission: ${String(_ex)}`,
        );
      }
      }

      const metadata = {};
      const plaintextByteLengths = managedRecords.map(record =>
        getHizoFSRecordByteLength({
          metadata,
          binaryPayloadByteLength: record.binaryPayloadByteLength,
        })
      );
      const objectIds = await this.segmentedStore.createRecordsPipelined({
        records: managedRecords.map((record, index) => {
          const plaintextByteLength = plaintextByteLengths[index];
          if (plaintextByteLength === undefined) {
            throw new Error('HizoFS file chunk pipeline omitted a plaintext length');
          }
          return {
            kind: 'file_chunk',
            plaintextByteLength,
            rotationPayloadByteLength: record.binaryPayloadByteLength,
            createPlaintext: async (): Promise<Uint8Array> => {
              const binaryPayload = await record.createBinaryPayload();
              if (binaryPayload.byteLength !== record.binaryPayloadByteLength) {
                throw new Error(
                  'HizoFS lazy file chunk payload length does not match its declaration',
                );
              }
              return this.encodeRecord({
                record: {
                  kind: 'file_chunk',
                  recordVersion: 1,
                  metadata,
                  binaryPayload,
                },
              });
            },
            discardPlaintext: record.discardBinaryPayload,
          };
        }),
        maximumPlaintextRecordsInFlight,
        maximumRecordsPerPhysicalWrite: HIZOFS_MAX_COALESCED_RECORDS_PER_WRITE,
      });
      if (objectIds.length !== managedRecords.length) {
        throw new Error('HizoFS file chunk pipeline returned an inconsistent result count');
      }
      for (const [index, objectId] of objectIds.entries()) {
        const plaintextByteLength = plaintextByteLengths[index];
        if (plaintextByteLength === undefined) {
          throw new Error('HizoFS file chunk pipeline omitted diagnostic metadata');
        }
        const reference = decodeHizoFSObjectReference({ value: objectId });
        this.diagnostics?.recordRecordWrite({
          kind: 'file_chunk',
          plaintextByteLength,
          physicalByteLength: reference.storedLength,
        });
      }
      return objectIds;
    } finally {
      for (const record of managedRecords) record.discardBinaryPayload();
    }
  }

  async read({ objectId }: {
    objectId: string;
  }): Promise<DecodedHizoFSRecord | undefined> {
    const cachedMetadata = this.metadataCache.get({ objectId });
    if (cachedMetadata !== undefined) {
      return this.decodeCachedRecord({ plaintext: cachedMetadata, cache: 'metadata' });
    }
    const cachedChunk = this.fileChunkCache.get({ objectId });
    if (cachedChunk !== undefined) {
      return this.decodeCachedRecord({ plaintext: cachedChunk, cache: 'file_chunk' });
    }

    const loaded = await this.segmentedStore.readRecord({ objectId });
    if (loaded === undefined) return undefined;
    let plaintextRetained = false;
    try {
      const decoded = this.decodeRecord({ plaintext: loaded.plaintext });
      if (decoded.kind !== loaded.kind) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS decoded record kind does not match its direct object reference',
          cause: undefined,
        });
      }
      this.diagnostics?.recordRecordRead({
        kind: decoded.kind,
        source: 'backing',
        plaintextByteLength: loaded.plaintext.byteLength,
        physicalByteLength: loaded.physicalByteLength,
      });
      this.recordCacheMiss({ kind: decoded.kind });
      plaintextRetained = this.cachePlaintext({
        objectId,
        kind: decoded.kind,
        plaintext: loaded.plaintext,
        source: 'read',
      });
      return decoded;
    } finally {
      if (!plaintextRetained) loaded.plaintext.fill(0);
    }
  }

  async readBinaryPayloadRange({
    objectId,
    offset,
    length,
  }: {
    objectId: string;
    offset: number;
    length: number;
  }): Promise<(DecodedHizoFSRecord & {
    readonly binaryPayloadByteLength: number;
  }) | undefined> {
    const cachedMetadata = this.metadataCache.get({ objectId });
    if (cachedMetadata !== undefined) {
      return this.decodeCachedRecordRange({
        plaintext: cachedMetadata,
        cache: 'metadata',
        offset,
        length,
      });
    }
    const cachedChunk = this.fileChunkCache.get({ objectId });
    if (cachedChunk !== undefined) {
      return this.decodeCachedRecordRange({
        plaintext: cachedChunk,
        cache: 'file_chunk',
        offset,
        length,
      });
    }

    const loaded = await this.segmentedStore.readRecord({ objectId });
    if (loaded === undefined) return undefined;
    let plaintextRetained = false;
    try {
      const decoded = this.decodeRecordRange({
        plaintext: loaded.plaintext,
        offset,
        length,
      });
      if (decoded.kind !== loaded.kind) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS decoded record kind does not match its direct object reference',
          cause: undefined,
        });
      }
      this.diagnostics?.recordRecordRead({
        kind: decoded.kind,
        source: 'backing',
        plaintextByteLength: loaded.plaintext.byteLength,
        physicalByteLength: loaded.physicalByteLength,
      });
      this.recordCacheMiss({ kind: decoded.kind });
      plaintextRetained = this.cachePlaintext({
        objectId,
        kind: decoded.kind,
        plaintext: loaded.plaintext,
        source: 'read',
      });
      return decoded;
    } finally {
      if (!plaintextRetained) loaded.plaintext.fill(0);
    }
  }

  resolveObjectId({ objectId }: { objectId: string }): Promise<string> {
    return this.segmentedStore.resolveObjectId({ objectId });
  }

  publishRelocations({ mappings }: {
    mappings: ReadonlyMap<string, string>;
  }): Promise<void> {
    return this.segmentedStore.publishRelocations({ mappings }).then(() => undefined);
  }

  readRelocationSnapshot() {
    return this.segmentedStore.readRelocationSnapshot();
  }

  async copyObjectsForRelocation({ objectIds }: {
    objectIds: readonly string[];
  }): Promise<ReadonlyMap<string, string>> {
    const mappings = new Map<string, string>();
    for (const objectId of objectIds) {
      const canonical = await this.resolveObjectId({ objectId });
      const record = await this.read({ objectId: canonical });
      if (record === undefined) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS compaction source object is missing',
          cause: undefined,
        });
      }
      const relocatedObjectId = await this.create({ record });
      mappings.set(objectId, relocatedObjectId);
    }
    await this.flushPendingRecords();
    return mappings;
  }

  async removeWholeSegmentIfUnchanged({ candidate }: {
    candidate: HizoFSWholeSegmentReclaimCandidate;
  }): Promise<HizoFSWholeSegmentRemovalResult> {
    const result = await this.segmentedStore.removeWholeSegmentIfUnchanged({
      objectId: candidate.representativeObjectId,
      expectedPhysicalByteLength: candidate.expectedPhysicalByteLength,
    });
    switch (result) {
    case 'removed':
    case 'missing':
      for (const objectId of candidate.objectIds) {
        this.metadataCache.delete({ objectId, reason: 'explicit' });
        this.fileChunkCache.delete({ objectId, reason: 'explicit' });
      }
      break;
    case 'changed':
      break;
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled HizoFS whole-segment removal result: ${String(_ex)}`);
    }
    }
    return result;
  }

  selectPartialSegmentCompactionCandidates({
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
    return this.segmentedStore.selectPartialSegmentCompactionCandidates({
      reachableObjectIds,
      minimumDeadRecordByteLength,
      maximumLiveRecordByteLength,
      maximumLiveRecordCount,
      maximumCandidateCount,
    });
  }

  selectWholeSegmentReclaimCandidates({ unreachableObjectIds }: {
    unreachableObjectIds: readonly string[];
  }): Promise<readonly HizoFSWholeSegmentReclaimCandidate[]> {
    return this.segmentedStore.selectWholeSegmentReclaimCandidates({
      unreachableObjectIds,
    });
  }

  inspectPhysicalRecord({ objectId }: {
    objectId: string;
  }): Promise<HizoFSPhysicalRecord | undefined> {
    return this.segmentedStore.readPhysicalRecord({ objectId });
  }

  inspectHeadPhysical({ slot }: { slot: 0 | 1 }): Promise<{
    readonly physicalBytes: Uint8Array;
    readonly physicalPath: readonly string[];
  } | undefined> {
    return this.segmentedStore.readHeadPhysical({ slot });
  }

  inspectHead({ slot }: {
    slot: 0 | 1;
  }): Promise<(HizoFSDecodedHead & {
    readonly physicalByteLength: number;
    readonly physicalBytes: Uint8Array;
    readonly physicalPath: readonly string[];
  }) | undefined> {
    return this.segmentedStore.readHead({ slot });
  }

  async writeSuperblock({ slot, record }: {
    slot: 0 | 1;
    record: HizoFSObjectStoreRecord;
  }): Promise<void> {
    const plaintext = this.encodeRecord({ record });
    try {
      switch (record.kind) {
      case 'superblock':
        break;
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
        throw new Error('HizoFS head publication requires a superblock record');
      default: {
        const _ex: never = record.kind;
        throw new Error(`Unhandled HizoFS record kind: ${String(_ex)}`);
      }
      }
      const superblock = HizoFSSuperblockSchemaDto.parse(record.metadata);
      const physicalByteLength = await this.segmentedStore.writeHead({
        slot,
        sequence: superblock.sequence,
        recordBytes: plaintext,
      });
      this.diagnostics?.recordRecordWrite({
        kind: record.kind,
        plaintextByteLength: plaintext.byteLength,
        physicalByteLength,
      });
    } finally {
      plaintext.fill(0);
    }
  }

  async readSuperblock({ slot }: {
    slot: 0 | 1;
  }): Promise<DecodedHizoFSRecord | undefined> {
    const head = await this.segmentedStore.readHead({ slot });
    if (head === undefined) return undefined;
    try {
      switch (head.record.kind) {
      case 'superblock':
        break;
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
        throw new HizoFSCorruptionError({
          message: 'HizoFS head contains a non-superblock record',
          cause: undefined,
        });
      default: {
        const _ex: never = head.record.kind;
        throw new Error(`Unhandled HizoFS record kind: ${String(_ex)}`);
      }
      }
      const plaintext = this.encodeRecord({
        record: {
          kind: head.record.kind,
          recordVersion: head.record.recordVersion,
          metadata: head.record.metadata,
          binaryPayload: head.record.binaryPayload,
        },
      });
      try {
        this.diagnostics?.recordRecordRead({
          kind: 'superblock',
          source: 'backing',
          plaintextByteLength: plaintext.byteLength,
          physicalByteLength: head.physicalByteLength,
        });
      } finally {
        plaintext.fill(0);
      }
      return head.record;
    } finally {
      head.recordBytes.fill(0);
    }
  }

  listPhysicalObjects({ persistMissingSegmentIndexes = false }: {
    persistMissingSegmentIndexes?: boolean;
  } = {}): Promise<HizoFSPhysicalObjectListing> {
    return this.segmentedStore.listPhysicalObjects({ persistMissingSegmentIndexes });
  }

  getObjectPhysicalPath({ objectId }: {
    objectId: string;
  }): readonly string[] {
    return this.segmentedStore.getPhysicalPath({ objectId });
  }

  private encodeRecord({ record }: {
    record: HizoFSObjectStoreRecord;
  }): Uint8Array {
    return this.diagnostics === undefined
      ? encodeHizoFSRecord(record)
      : this.diagnostics.measureSync({
        phase: 'record_encode',
        operation: () => encodeHizoFSRecord(record),
      });
  }

  private decodeRecord({ plaintext }: {
    plaintext: Uint8Array;
  }): DecodedHizoFSRecord {
    return this.diagnostics === undefined
      ? decodeHizoFSRecord({ plaintext })
      : this.diagnostics.measureSync({
        phase: 'record_decode',
        operation: () => decodeHizoFSRecord({ plaintext }),
      });
  }

  private decodeRecordRange({
    plaintext,
    offset,
    length,
  }: {
    plaintext: Uint8Array;
    offset: number;
    length: number;
  }): DecodedHizoFSRecord & {
    readonly binaryPayloadByteLength: number;
  } {
    return this.diagnostics === undefined
      ? decodeHizoFSRecordBinaryPayloadRange({ plaintext, offset, length })
      : this.diagnostics.measureSync({
        phase: 'record_decode',
        operation: () => decodeHizoFSRecordBinaryPayloadRange({
          plaintext,
          offset,
          length,
        }),
      });
  }

  private decodeCachedRecordRange({
    plaintext,
    cache,
    offset,
    length,
  }: {
    plaintext: Uint8Array;
    cache: HizoFSRuntimeDiagnosticCacheKind;
    offset: number;
    length: number;
  }): DecodedHizoFSRecord & {
    readonly binaryPayloadByteLength: number;
  } {
    const decoded = this.decodeRecordRange({ plaintext, offset, length });
    this.diagnostics?.recordCacheHit({ cache });
    this.diagnostics?.recordRecordRead({
      kind: decoded.kind,
      source: 'cache',
      plaintextByteLength: plaintext.byteLength,
      physicalByteLength: 0,
    });
    return decoded;
  }

  private decodeCachedRecord({
    plaintext,
    cache,
  }: {
    plaintext: Uint8Array;
    cache: HizoFSRuntimeDiagnosticCacheKind;
  }): DecodedHizoFSRecord {
    const decoded = this.decodeRecord({ plaintext });
    this.diagnostics?.recordCacheHit({ cache });
    this.diagnostics?.recordRecordRead({
      kind: decoded.kind,
      source: 'cache',
      plaintextByteLength: plaintext.byteLength,
      physicalByteLength: 0,
    });
    return decoded;
  }

  private recordCacheMiss({ kind }: { kind: HizoFSRecordKind }): void {
    switch (kind) {
    case 'file_chunk':
      this.diagnostics?.recordCacheMiss({ cache: 'file_chunk' });
      break;
    case 'superblock':
      break;
    case 'subvolume_descriptor':
    case 'subvolume_mount_index_page':
    case 'commit':
    case 'inode_index_page':
    case 'file_inode':
    case 'directory_inode':
    case 'symlink_inode':
    case 'directory_index_page':
    case 'file_extent_page':
      this.diagnostics?.recordCacheMiss({ cache: 'metadata' });
      break;
    default: {
      const _ex: never = kind;
      throw new Error(`Unhandled HizoFS diagnostic cache record kind: ${String(_ex)}`);
    }
    }
  }

  private cachePlaintext({
    objectId,
    kind,
    plaintext,
    source,
  }: {
    objectId: string;
    kind: HizoFSRecordKind;
    plaintext: Uint8Array;
    source: 'read' | 'write';
  }): boolean {
    switch (kind) {
    case 'file_chunk':
      if (source === 'write' && this.fileChunkCacheAdmission === 'read') {
        return false;
      }
      return this.fileChunkCache.set({ objectId, plaintext });
    case 'superblock':
      return false;
    case 'subvolume_descriptor':
    case 'subvolume_mount_index_page':
    case 'commit':
    case 'inode_index_page':
    case 'file_inode':
    case 'directory_inode':
    case 'symlink_inode':
    case 'directory_index_page':
    case 'file_extent_page':
      return this.metadataCache.set({ objectId, plaintext });
    default: {
      const _ex: never = kind;
      throw new Error(`Unhandled HizoFS cache record kind: ${String(_ex)}`);
    }
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
