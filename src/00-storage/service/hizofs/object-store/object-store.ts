import type { HizoFSBackingStore } from '@/00-storage/service/hizofs/backing-store/backing-store';
import { HizoFSCorruptionError } from '@/00-storage/service/hizofs/errors';
import {
  decryptHizoFSObject,
  encryptHizoFSObject,
} from '@/00-storage/service/hizofs/crypto/object-crypto';
import {
  decodeHizoFSObjectEnvelope,
  encodeHizoFSObjectEnvelope,
} from '@/00-storage/service/hizofs/format/object-envelope';
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
  createHizoFSObjectId,
  getHizoFSObjectShard,
} from './object-id';

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

  set({ objectId, plaintext }: { objectId: string; plaintext: Uint8Array }): void {
    this.delete({ objectId, reason: 'explicit' });
    if (this.entryLimit === 0 || plaintext.byteLength > this.byteLimit) return;
    this.entries.set(objectId, { plaintext });
    this.totalBytes += plaintext.byteLength;
    while (this.totalBytes > this.byteLimit || this.entries.size > this.entryLimit) {
      const oldestObjectId = this.entries.keys().next().value as string | undefined;
      if (oldestObjectId === undefined) break;
      this.delete({ objectId: oldestObjectId, reason: 'eviction' });
    }
    this.recordState();
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

function getPhysicalPath({ area, objectId }: {
  area: 'object' | 'superblock';
  objectId: string;
}): readonly string[] {
  switch (area) {
  case 'object':
    return ['objects', getHizoFSObjectShard({ objectId }), `${objectId}.enc`];
  case 'superblock':
    return [`${objectId}.enc`];
  default: {
    const _ex: never = area;
    throw new Error(`Unhandled HizoFS object area: ${String(_ex)}`);
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
    diagnostics,
  }: {
    backingStore: HizoFSBackingStore;
    rootKey: CryptoKey;
    fileSystemId: string;
    metadataCacheByteLimit: number;
    metadataCacheEntryLimit: number;
    fileChunkCacheByteLimit: number;
    fileChunkCacheEntryLimit: number;
    diagnostics?: HizoFSRuntimeDiagnostics;
  }) {
    this.backingStore = backingStore;
    this.rootKey = rootKey;
    this.fileSystemId = fileSystemId;
    this.diagnostics = diagnostics;
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

  private readonly backingStore: HizoFSBackingStore;
  private readonly rootKey: CryptoKey;
  private readonly fileSystemId: string;
  private readonly diagnostics: HizoFSRuntimeDiagnostics | undefined;
  private readonly metadataCache: HizoFSPlaintextLruCache;
  private readonly fileChunkCache: HizoFSPlaintextLruCache;

  clearPlaintextCaches(): void {
    this.metadataCache.clear();
    this.fileChunkCache.clear();
  }

  async create({ record }: {
    record: HizoFSObjectStoreRecord;
  }): Promise<string> {
    const objectId = createHizoFSObjectId();
    await this.writeObject({ objectId, area: 'object', record });
    return objectId;
  }

  async read({ objectId }: {
    objectId: string;
  }): Promise<DecodedHizoFSRecord | undefined> {
    return this.readObject({ objectId, area: 'object' });
  }

  async remove({ objectId }: {
    objectId: string;
  }): Promise<void> {
    this.metadataCache.delete({ objectId, reason: 'explicit' });
    this.fileChunkCache.delete({ objectId, reason: 'explicit' });
    await this.backingStore.remove({
      path: this.getObjectPath({ objectId }),
      recursive: false,
    });
  }

  async writeSuperblock({ slot, record }: {
    slot: 0 | 1;
    record: HizoFSObjectStoreRecord;
  }): Promise<void> {
    await this.writeObject({
      objectId: `superblock-${String(slot)}`,
      area: 'superblock',
      record,
    });
  }

  async readSuperblock({ slot }: {
    slot: 0 | 1;
  }): Promise<DecodedHizoFSRecord | undefined> {
    return this.readObject({
      objectId: `superblock-${String(slot)}`,
      area: 'superblock',
    });
  }

  private async writeObject({ objectId, area, record }: {
    objectId: string;
    area: 'object' | 'superblock';
    record: HizoFSObjectStoreRecord;
  }): Promise<void> {
    const plaintext = this.diagnostics === undefined
      ? encodeHizoFSRecord(record)
      : this.diagnostics.measureSync({
        phase: 'record_encode',
        operation: () => encodeHizoFSRecord(record),
      });
    const { nonce, ciphertext } = this.diagnostics === undefined
      ? await encryptHizoFSObject({
        rootKey: this.rootKey,
        fileSystemId: this.fileSystemId,
        objectIdentity: objectId,
        area,
        plaintext,
      })
      : await this.diagnostics.measureAsync({
        phase: 'object_encrypt',
        operation: async () => encryptHizoFSObject({
          rootKey: this.rootKey,
          fileSystemId: this.fileSystemId,
          objectIdentity: objectId,
          area,
          plaintext,
        }),
      });
    const physical = this.diagnostics === undefined
      ? encodeHizoFSObjectEnvelope({ nonce, ciphertext })
      : this.diagnostics.measureSync({
        phase: 'envelope_encode',
        operation: () => encodeHizoFSObjectEnvelope({ nonce, ciphertext }),
      });
    await this.backingStore.write({
      path: getPhysicalPath({ area, objectId }),
      bytes: physical,
    });
    this.diagnostics?.recordRecordWrite({
      kind: record.kind,
      plaintextByteLength: plaintext.byteLength,
      physicalByteLength: physical.byteLength,
    });
    switch (area) {
    case 'object':
      this.cachePlaintext({ objectId, kind: record.kind, plaintext });
      break;
    case 'superblock':
      break;
    default: {
      const _ex: never = area;
      throw new Error(`Unhandled HizoFS object area: ${String(_ex)}`);
    }
    }
  }

  private async readObject({ objectId, area }: {
    objectId: string;
    area: 'object' | 'superblock';
  }): Promise<DecodedHizoFSRecord | undefined> {
    switch (area) {
    case 'object': {
      const cachedMetadata = this.metadataCache.get({ objectId });
      if (cachedMetadata !== undefined) {
        return this.decodeCachedRecord({
          plaintext: cachedMetadata,
          cache: 'metadata',
        });
      }
      const cachedChunk = this.fileChunkCache.get({ objectId });
      if (cachedChunk !== undefined) {
        return this.decodeCachedRecord({
          plaintext: cachedChunk,
          cache: 'file_chunk',
        });
      }
      break;
    }
    case 'superblock':
      break;
    default: {
      const _ex: never = area;
      throw new Error(`Unhandled HizoFS object area: ${String(_ex)}`);
    }
    }
    const physical = await this.backingStore.read({
      path: getPhysicalPath({ area, objectId }),
    });
    if (physical === undefined) {
      return undefined;
    }
    const { nonce, ciphertext } = this.diagnostics === undefined
      ? decodeHizoFSObjectEnvelope({ physical })
      : this.diagnostics.measureSync({
        phase: 'envelope_decode',
        operation: () => decodeHizoFSObjectEnvelope({ physical }),
      });
    let plaintext: Uint8Array;
    try {
      plaintext = this.diagnostics === undefined
        ? await decryptHizoFSObject({
          rootKey: this.rootKey,
          fileSystemId: this.fileSystemId,
          objectIdentity: objectId,
          area,
          nonce,
          ciphertext,
        })
        : await this.diagnostics.measureAsync({
          phase: 'object_decrypt',
          operation: async () => decryptHizoFSObject({
            rootKey: this.rootKey,
            fileSystemId: this.fileSystemId,
            objectIdentity: objectId,
            area,
            nonce,
            ciphertext,
          }),
        });
    } catch (error) {
      throw new HizoFSCorruptionError({
        message: `HizoFS ${area} authentication failed`,
        cause: error,
      });
    }
    const decoded = this.diagnostics === undefined
      ? decodeHizoFSRecord({ plaintext })
      : this.diagnostics.measureSync({
        phase: 'record_decode',
        operation: () => decodeHizoFSRecord({ plaintext }),
      });
    this.diagnostics?.recordRecordRead({
      kind: decoded.kind,
      source: 'backing',
      plaintextByteLength: plaintext.byteLength,
      physicalByteLength: physical.byteLength,
    });
    switch (area) {
    case 'object':
      this.recordCacheMiss({ kind: decoded.kind });
      this.cachePlaintext({
        objectId,
        kind: decoded.kind,
        plaintext,
      });
      break;
    case 'superblock':
      break;
    default: {
      const _ex: never = area;
      throw new Error(`Unhandled HizoFS object area: ${String(_ex)}`);
    }
    }
    return decoded;
  }

  private decodeCachedRecord({
    plaintext,
    cache,
  }: {
    plaintext: Uint8Array;
    cache: HizoFSRuntimeDiagnosticCacheKind;
  }): DecodedHizoFSRecord {
    const decoded = this.diagnostics === undefined
      ? decodeHizoFSRecord({ plaintext })
      : this.diagnostics.measureSync({
        phase: 'record_decode',
        operation: () => decodeHizoFSRecord({ plaintext }),
      });
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

  private cachePlaintext({ objectId, kind, plaintext }: {
    objectId: string;
    kind: HizoFSRecordKind;
    plaintext: Uint8Array;
  }): void {
    switch (kind) {
    case 'file_chunk':
      this.fileChunkCache.set({ objectId, plaintext });
      break;
    case 'superblock':
      return;
    case 'commit':
    case 'inode_index_page':
    case 'file_inode':
    case 'directory_inode':
    case 'symlink_inode':
    case 'directory_index_page':
    case 'file_extent_page':
      this.metadataCache.set({ objectId, plaintext });
      break;
    default: {
      const _ex: never = kind;
      throw new Error(`Unhandled HizoFS cache record kind: ${String(_ex)}`);
    }
    }
  }

  private getObjectPath({ objectId }: {
    objectId: string;
  }): readonly string[] {
    return [
      'objects',
      getHizoFSObjectShard({ objectId }),
      `${objectId}.enc`,
    ];
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
