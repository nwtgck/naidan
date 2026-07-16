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
  'index_build',
  'index_update',
  'commit_publication',
] as const;

export type HizoFSRuntimeDiagnosticPhase =
  (typeof HIZOFS_RUNTIME_DIAGNOSTIC_PHASES)[number];

export const HIZOFS_RUNTIME_DIAGNOSTIC_RECORD_KINDS = [
  'commit',
  'inode_index_page',
  'file_inode',
  'directory_inode',
  'symlink_inode',
  'directory_index_page',
  'file_extent_page',
  'file_chunk',
  'superblock',
] as const satisfies readonly HizoFSRecordKind[];

export type HizoFSRuntimeDiagnosticCacheKind = 'metadata' | 'file_chunk';

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
  };
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
      },
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
    default: {
      const _ex: never = cache;
      throw new Error(`Unhandled HizoFS diagnostic cache: ${String(_ex)}`);
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
