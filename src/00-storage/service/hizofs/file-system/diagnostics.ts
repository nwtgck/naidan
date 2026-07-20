import type { HizoFSRecordKind } from '@/00-storage/service/hizofs/format/record';

export const HIZOFS_RUNTIME_DIAGNOSTIC_PHASES = [
  'record_encode',
  'record_decode',
  'object_encrypt',
  'object_decrypt',
  'envelope_encode',
  'envelope_decode',
  'backing_resolve_parent',
  'backing_get_file_handle',
  'backing_get_file',
  'backing_array_buffer',
  'backing_create_writable',
  'backing_write',
  'backing_close',
  'backing_failure_verification',
  'backing_remove',
  'backing_list',
  'backing_open_random_access',
  'backing_read_at',
  'backing_write_at',
  'backing_truncate',
  'backing_flush',
  'backing_close_random_access',
  'index_build',
  'index_update',
  'commit_publication',
] as const;

export type HizoFSRuntimeDiagnosticPhase =
  (typeof HIZOFS_RUNTIME_DIAGNOSTIC_PHASES)[number];

export const HIZOFS_RUNTIME_DIAGNOSTIC_RECORD_KINDS = [
  'subvolume_descriptor',
  'commit',
  'inode_index_page',
  'file_inode',
  'directory_inode',
  'symlink_inode',
  'directory_index_page',
  'subvolume_mount_index_page',
  'file_extent_page',
  'file_chunk',
  'superblock',
] as const satisfies readonly HizoFSRecordKind[];

export type HizoFSRuntimeDiagnosticCacheKind =
  | 'metadata'
  | 'file_chunk'
  | 'backing_file_handle'
  | 'backing_file_snapshot'
  | 'decoded_inode_index_page';

export type HizoFSRuntimeDiagnosticResourceKind =
  | 'writer_dirty_chunks'
  | 'writer_pending_chunk_writes'
  | 'reader_prefetch';

export type HizoFSRuntimeDiagnosticCoordinatorEvent =
  | 'active_state_cache_hit'
  | 'durable_reload'
  | 'leadership_acquisition'
  | 'failover'
  | 'local_request'
  | 'remote_request';

export type HizoFSRuntimeDiagnosticPhaseSnapshot = {
  readonly operationCount: number;
  readonly totalDurationMs: number;
};

export type HizoFSRuntimeDiagnosticRecordSnapshot = {
  readonly readOperations: number;
  readonly writeOperations: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly plaintextBytesRead: number;
  readonly plaintextBytesWritten: number;
  readonly physicalBytesRead: number;
  readonly physicalBytesWritten: number;
};

export type HizoFSRuntimeDiagnosticCacheSnapshot = {
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly currentBytes: number;
  readonly maximumBytes: number;
  readonly currentEntries: number;
  readonly maximumEntries: number;
};

export type HizoFSRuntimeDiagnosticResourceSnapshot = {
  readonly currentBytes: number;
  readonly maximumBytes: number;
  readonly currentOperations: number;
  readonly maximumOperations: number;
};

export type HizoFSRuntimeDiagnosticCoordinatorSnapshot = {
  readonly activeStateCacheHits: number;
  readonly durableReloads: number;
  readonly leadershipAcquisitions: number;
  readonly failovers: number;
  readonly localRequests: number;
  readonly remoteRequests: number;
};

export type HizoFSRuntimeDiagnosticsSnapshot = {
  readonly phases: Readonly<
    Record<HizoFSRuntimeDiagnosticPhase, HizoFSRuntimeDiagnosticPhaseSnapshot>
  >;
  readonly records: Readonly<
    Record<HizoFSRecordKind, HizoFSRuntimeDiagnosticRecordSnapshot>
  >;
  readonly caches: {
    readonly metadata: HizoFSRuntimeDiagnosticCacheSnapshot;
    readonly fileChunk: HizoFSRuntimeDiagnosticCacheSnapshot;
    readonly backingFileHandle: HizoFSRuntimeDiagnosticCacheSnapshot;
    readonly backingFileSnapshot: HizoFSRuntimeDiagnosticCacheSnapshot;
    readonly decodedInodeIndexPage: HizoFSRuntimeDiagnosticCacheSnapshot;
  };
  readonly resources: {
    readonly writerDirtyChunks: HizoFSRuntimeDiagnosticResourceSnapshot;
    readonly writerPendingChunkWrites: HizoFSRuntimeDiagnosticResourceSnapshot;
    readonly readerPrefetch: HizoFSRuntimeDiagnosticResourceSnapshot;
  };
  readonly coordinator: HizoFSRuntimeDiagnosticCoordinatorSnapshot;
};

type MutablePhaseCounter = {
  operationCount: number;
  totalDurationMs: number;
};

type MutableRecordCounter = {
  readOperations: number;
  writeOperations: number;
  cacheHits: number;
  cacheMisses: number;
  plaintextBytesRead: number;
  plaintextBytesWritten: number;
  physicalBytesRead: number;
  physicalBytesWritten: number;
};

type MutableCacheCounter = {
  hits: number;
  misses: number;
  evictions: number;
  currentBytes: number;
  maximumBytes: number;
  currentEntries: number;
  maximumEntries: number;
};

type MutableResourceCounter = {
  currentBytes: number;
  maximumBytes: number;
  currentOperations: number;
  maximumOperations: number;
};

function createPhaseCounters(): Record<HizoFSRuntimeDiagnosticPhase, MutablePhaseCounter> {
  return Object.fromEntries(
    HIZOFS_RUNTIME_DIAGNOSTIC_PHASES.map((phase) => [
      phase,
      { operationCount: 0, totalDurationMs: 0 },
    ]),
  ) as Record<HizoFSRuntimeDiagnosticPhase, MutablePhaseCounter>;
}

function createRecordCounters(): Record<HizoFSRecordKind, MutableRecordCounter> {
  return Object.fromEntries(
    HIZOFS_RUNTIME_DIAGNOSTIC_RECORD_KINDS.map((kind) => [
      kind,
      {
        readOperations: 0,
        writeOperations: 0,
        cacheHits: 0,
        cacheMisses: 0,
        plaintextBytesRead: 0,
        plaintextBytesWritten: 0,
        physicalBytesRead: 0,
        physicalBytesWritten: 0,
      },
    ]),
  ) as Record<HizoFSRecordKind, MutableRecordCounter>;
}

function createCacheCounter(): MutableCacheCounter {
  return {
    hits: 0,
    misses: 0,
    evictions: 0,
    currentBytes: 0,
    maximumBytes: 0,
    currentEntries: 0,
    maximumEntries: 0,
  };
}

function createResourceCounter(): MutableResourceCounter {
  return {
    currentBytes: 0,
    maximumBytes: 0,
    currentOperations: 0,
    maximumOperations: 0,
  };
}

export class HizoFSRuntimeDiagnostics {
  constructor({ now }: { now: () => number }) {
    this.now = now;
  }

  private readonly now: () => number;
  private readonly phases = createPhaseCounters();
  private readonly records = createRecordCounters();
  private readonly caches = {
    metadata: createCacheCounter(),
    fileChunk: createCacheCounter(),
    backingFileHandle: createCacheCounter(),
    backingFileSnapshot: createCacheCounter(),
    decodedInodeIndexPage: createCacheCounter(),
  };
  private readonly resources = {
    writerDirtyChunks: createResourceCounter(),
    writerPendingChunkWrites: createResourceCounter(),
    readerPrefetch: createResourceCounter(),
  };
  private readonly coordinator = {
    activeStateCacheHits: 0,
    durableReloads: 0,
    leadershipAcquisitions: 0,
    failovers: 0,
    localRequests: 0,
    remoteRequests: 0,
  };

  measureSync<T>({
    phase,
    operation,
  }: {
    phase: HizoFSRuntimeDiagnosticPhase;
    operation: () => T;
  }): T {
    const startedAt = this.now();
    try {
      return operation();
    } finally {
      this.recordPhase({ phase, durationMs: Math.max(this.now() - startedAt, 0) });
    }
  }

  async measureAsync<T>({
    phase,
    operation,
  }: {
    phase: HizoFSRuntimeDiagnosticPhase;
    operation: () => Promise<T>;
  }): Promise<T> {
    const startedAt = this.now();
    try {
      return await operation();
    } finally {
      this.recordPhase({ phase, durationMs: Math.max(this.now() - startedAt, 0) });
    }
  }

  recordRecordRead({
    kind,
    source,
    plaintextByteLength,
    physicalByteLength,
  }: {
    kind: HizoFSRecordKind;
    source: 'cache' | 'backing';
    plaintextByteLength: number;
    physicalByteLength: number;
  }): void {
    const counter = this.records[kind];
    counter.readOperations += 1;
    counter.plaintextBytesRead += plaintextByteLength;
    counter.physicalBytesRead += physicalByteLength;
    switch (source) {
    case 'cache':
      counter.cacheHits += 1;
      break;
    case 'backing':
      counter.cacheMisses += 1;
      break;
    default: {
      const _ex: never = source;
      throw new Error(`Unhandled HizoFS diagnostic read source: ${String(_ex)}`);
    }
    }
  }

  recordRecordWrite({
    kind,
    plaintextByteLength,
    physicalByteLength,
  }: {
    kind: HizoFSRecordKind;
    plaintextByteLength: number;
    physicalByteLength: number;
  }): void {
    const counter = this.records[kind];
    counter.writeOperations += 1;
    counter.plaintextBytesWritten += plaintextByteLength;
    counter.physicalBytesWritten += physicalByteLength;
  }

  recordCacheHit({ cache }: { cache: HizoFSRuntimeDiagnosticCacheKind }): void {
    this.getCacheCounter({ cache }).hits += 1;
  }

  recordCacheMiss({ cache }: { cache: HizoFSRuntimeDiagnosticCacheKind }): void {
    this.getCacheCounter({ cache }).misses += 1;
  }

  recordCacheEviction({ cache }: { cache: HizoFSRuntimeDiagnosticCacheKind }): void {
    this.getCacheCounter({ cache }).evictions += 1;
  }

  recordCacheState({
    cache,
    byteLength,
    entryCount,
  }: {
    cache: HizoFSRuntimeDiagnosticCacheKind;
    byteLength: number;
    entryCount: number;
  }): void {
    const counter = this.getCacheCounter({ cache });
    counter.currentBytes = byteLength;
    counter.maximumBytes = Math.max(counter.maximumBytes, byteLength);
    counter.currentEntries = entryCount;
    counter.maximumEntries = Math.max(counter.maximumEntries, entryCount);
  }

  adjustResourceUsage({
    resource,
    byteDelta,
    operationDelta,
  }: {
    resource: HizoFSRuntimeDiagnosticResourceKind;
    byteDelta: number;
    operationDelta: number;
  }): void {
    const counter = this.getResourceCounter({ resource });
    const currentBytes = counter.currentBytes + byteDelta;
    const currentOperations = counter.currentOperations + operationDelta;
    if (currentBytes < 0 || currentOperations < 0) {
      throw new Error(`HizoFS diagnostic resource usage became negative: ${resource}`);
    }
    counter.currentBytes = currentBytes;
    counter.maximumBytes = Math.max(counter.maximumBytes, currentBytes);
    counter.currentOperations = currentOperations;
    counter.maximumOperations = Math.max(
      counter.maximumOperations,
      currentOperations,
    );
  }

  recordCoordinatorEvent({
    event,
  }: {
    event: HizoFSRuntimeDiagnosticCoordinatorEvent;
  }): void {
    switch (event) {
    case 'active_state_cache_hit':
      this.coordinator.activeStateCacheHits += 1;
      return;
    case 'durable_reload':
      this.coordinator.durableReloads += 1;
      return;
    case 'leadership_acquisition':
      this.coordinator.leadershipAcquisitions += 1;
      return;
    case 'failover':
      this.coordinator.failovers += 1;
      return;
    case 'local_request':
      this.coordinator.localRequests += 1;
      return;
    case 'remote_request':
      this.coordinator.remoteRequests += 1;
      return;
    default: {
      const _ex: never = event;
      throw new Error(`Unhandled HizoFS coordinator diagnostic event: ${_ex}`);
    }
    }
  }

  resetResourceHighWaterMarks(): void {
    for (const counter of Object.values(this.resources)) {
      counter.maximumBytes = counter.currentBytes;
      counter.maximumOperations = counter.currentOperations;
    }
  }

  snapshot(): HizoFSRuntimeDiagnosticsSnapshot {
    return {
      phases: Object.fromEntries(
        HIZOFS_RUNTIME_DIAGNOSTIC_PHASES.map((phase) => {
          const counter = this.phases[phase];
          return [phase, { ...counter }];
        }),
      ) as Record<
        HizoFSRuntimeDiagnosticPhase,
        HizoFSRuntimeDiagnosticPhaseSnapshot
      >,
      records: Object.fromEntries(
        HIZOFS_RUNTIME_DIAGNOSTIC_RECORD_KINDS.map((kind) => {
          const counter = this.records[kind];
          return [kind, { ...counter }];
        }),
      ) as Record<HizoFSRecordKind, HizoFSRuntimeDiagnosticRecordSnapshot>,
      caches: {
        metadata: { ...this.caches.metadata },
        fileChunk: { ...this.caches.fileChunk },
        backingFileHandle: { ...this.caches.backingFileHandle },
        backingFileSnapshot: { ...this.caches.backingFileSnapshot },
        decodedInodeIndexPage: { ...this.caches.decodedInodeIndexPage },
      },
      resources: {
        writerDirtyChunks: { ...this.resources.writerDirtyChunks },
        writerPendingChunkWrites: {
          ...this.resources.writerPendingChunkWrites,
        },
        readerPrefetch: { ...this.resources.readerPrefetch },
      },
      coordinator: { ...this.coordinator },
    };
  }

  private recordPhase({
    phase,
    durationMs,
  }: {
    phase: HizoFSRuntimeDiagnosticPhase;
    durationMs: number;
  }): void {
    const counter = this.phases[phase];
    counter.operationCount += 1;
    counter.totalDurationMs += durationMs;
  }

  private getCacheCounter({
    cache,
  }: {
    cache: HizoFSRuntimeDiagnosticCacheKind;
  }): MutableCacheCounter {
    switch (cache) {
    case 'metadata':
      return this.caches.metadata;
    case 'file_chunk':
      return this.caches.fileChunk;
    case 'backing_file_handle':
      return this.caches.backingFileHandle;
    case 'backing_file_snapshot':
      return this.caches.backingFileSnapshot;
    case 'decoded_inode_index_page':
      return this.caches.decodedInodeIndexPage;
    default: {
      const _ex: never = cache;
      throw new Error(`Unhandled HizoFS diagnostic cache: ${String(_ex)}`);
    }
    }
  }

  private getResourceCounter({
    resource,
  }: {
    resource: HizoFSRuntimeDiagnosticResourceKind;
  }): MutableResourceCounter {
    switch (resource) {
    case 'writer_dirty_chunks':
      return this.resources.writerDirtyChunks;
    case 'writer_pending_chunk_writes':
      return this.resources.writerPendingChunkWrites;
    case 'reader_prefetch':
      return this.resources.readerPrefetch;
    default: {
      const _ex: never = resource;
      throw new Error(`Unhandled HizoFS diagnostic resource: ${String(_ex)}`);
    }
    }
  }
}

export function createHizoFSRuntimeDiagnostics(): HizoFSRuntimeDiagnostics {
  return new HizoFSRuntimeDiagnostics({ now: () => performance.now() });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
