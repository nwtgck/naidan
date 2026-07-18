import { HizoFSSuperblockSchemaDto } from '@/00-storage/00-dto/hizofs.dto';
import type { HizoFSBackingStore } from '@/00-storage/service/hizofs/backing-store/backing-store';
import { HizoFSCorruptionError } from '@/00-storage/service/hizofs/errors';
import {
  decodeHizoFSRecord,
  encodeHizoFSRecord,
  type DecodedHizoFSRecord,
  type HizoFSRecordKind,
} from '@/00-storage/service/hizofs/format/record';
import type {
  HizoFSRuntimeDiagnosticCacheKind,
  HizoFSRuntimeDiagnostics,
} from '@/00-storage/service/hizofs/file-system/diagnostics';
import {
  HizoFSSegmentedStore,
  type HizoFSPhysicalObjectListing,
  type HizoFSWholeSegmentReclaimCandidate,
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
    fileChunkCacheAdmission: 'read_only' | 'read_write';
    diagnostics?: HizoFSRuntimeDiagnostics;
  }) {
    switch (fileChunkCacheAdmission) {
    case 'read_only':
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
  private readonly fileChunkCacheAdmission: 'read_only' | 'read_write';
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

  listPhysicalObjects(): Promise<HizoFSPhysicalObjectListing> {
    return this.segmentedStore.listPhysicalObjects();
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
      if (source === 'write' && this.fileChunkCacheAdmission === 'read_only') {
        return false;
      }
      return this.fileChunkCache.set({ objectId, plaintext });
    case 'superblock':
      return false;
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
