import { describe, expect, it } from 'vitest';
import { HizoFSRuntimeDiagnostics } from './diagnostics';

function createDeterministicDiagnostics({ timestamps }: {
  timestamps: readonly number[];
}): HizoFSRuntimeDiagnostics {
  let index = 0;
  return new HizoFSRuntimeDiagnostics({
    now: () => {
      const timestamp = timestamps[index];
      if (timestamp === undefined) {
        throw new Error('Missing deterministic HizoFS diagnostic timestamp');
      }
      index += 1;
      return timestamp;
    },
  });
}

describe('HizoFS runtime diagnostics', () => {
  it('records nested phase durations without changing operation results', async () => {
    const diagnostics = createDeterministicDiagnostics({
      timestamps: [10, 14, 20, 27],
    });

    expect(diagnostics.measureSync({
      phase: 'record_encode',
      operation: () => 'encoded',
    })).toBe('encoded');
    await expect(diagnostics.measureAsync({
      phase: 'backing_write',
      operation: async () => 'written',
    })).resolves.toBe('written');

    const snapshot = diagnostics.snapshot();
    expect(snapshot.phases.record_encode).toEqual({
      operationCount: 1,
      totalDurationMs: 4,
    });
    expect(snapshot.phases.backing_write).toEqual({
      operationCount: 1,
      totalDurationMs: 7,
    });
  });

  it('records failed operations and clamps a regressing clock to zero', async () => {
    const diagnostics = createDeterministicDiagnostics({
      timestamps: [10, 8, 20, 25],
    });

    expect(() => diagnostics.measureSync({
      phase: 'record_decode',
      operation: () => {
        throw new Error('decode failed');
      },
    })).toThrow('decode failed');
    await expect(diagnostics.measureAsync({
      phase: 'backing_close',
      operation: async () => {
        throw new Error('close failed');
      },
    })).rejects.toThrow('close failed');

    const snapshot = diagnostics.snapshot();
    expect(snapshot.phases.record_decode).toEqual({
      operationCount: 1,
      totalDurationMs: 0,
    });
    expect(snapshot.phases.backing_close).toEqual({
      operationCount: 1,
      totalDurationMs: 5,
    });
  });

  it('tracks record kinds and bounded cache behavior structurally', () => {
    const diagnostics = createDeterministicDiagnostics({ timestamps: [] });

    diagnostics.recordRecordWrite({
      kind: 'file_chunk',
      plaintextByteLength: 256,
      physicalByteLength: 300,
    });
    diagnostics.recordRecordRead({
      kind: 'file_chunk',
      source: 'backing',
      plaintextByteLength: 256,
      physicalByteLength: 300,
    });
    diagnostics.recordRecordRead({
      kind: 'file_chunk',
      source: 'cache',
      plaintextByteLength: 256,
      physicalByteLength: 0,
    });
    diagnostics.recordCacheMiss({ cache: 'file_chunk' });
    diagnostics.recordCacheHit({ cache: 'file_chunk' });
    diagnostics.recordCacheEviction({ cache: 'file_chunk' });
    diagnostics.recordCacheState({
      cache: 'file_chunk',
      byteLength: 512,
      entryCount: 2,
    });
    diagnostics.recordCacheState({
      cache: 'file_chunk',
      byteLength: 256,
      entryCount: 1,
    });

    const snapshot = diagnostics.snapshot();
    expect(snapshot.records.file_chunk).toEqual({
      readOperations: 2,
      writeOperations: 1,
      cacheHits: 1,
      cacheMisses: 1,
      plaintextBytesRead: 512,
      plaintextBytesWritten: 256,
      physicalBytesRead: 300,
      physicalBytesWritten: 300,
    });
    expect(snapshot.caches.fileChunk).toEqual({
      hits: 1,
      misses: 1,
      evictions: 1,
      currentBytes: 256,
      maximumBytes: 512,
      currentEntries: 1,
      maximumEntries: 2,
    });
  });

  it('tracks backing file-handle cache state and bounded plaintext resources', () => {
    const diagnostics = createDeterministicDiagnostics({ timestamps: [] });

    diagnostics.recordCacheMiss({ cache: 'backing_file_handle' });
    diagnostics.recordCacheHit({ cache: 'backing_file_handle' });
    diagnostics.recordCacheEviction({ cache: 'backing_file_handle' });
    diagnostics.recordCacheState({
      cache: 'backing_file_handle',
      byteLength: 0,
      entryCount: 2,
    });
    diagnostics.adjustResourceUsage({
      resource: 'writer_dirty_chunks',
      byteDelta: 8,
      operationDelta: 2,
    });
    diagnostics.adjustResourceUsage({
      resource: 'writer_dirty_chunks',
      byteDelta: -4,
      operationDelta: -1,
    });
    diagnostics.adjustResourceUsage({
      resource: 'reader_prefetch',
      byteDelta: 16,
      operationDelta: 1,
    });
    diagnostics.adjustResourceUsage({
      resource: 'reader_prefetch',
      byteDelta: -16,
      operationDelta: -1,
    });

    const snapshot = diagnostics.snapshot();
    expect(snapshot.caches.backingFileHandle).toEqual({
      hits: 1,
      misses: 1,
      evictions: 1,
      currentBytes: 0,
      maximumBytes: 0,
      currentEntries: 2,
      maximumEntries: 2,
    });
    expect(snapshot.resources.writerDirtyChunks).toEqual({
      currentBytes: 4,
      maximumBytes: 8,
      currentOperations: 1,
      maximumOperations: 2,
    });
    expect(snapshot.resources.readerPrefetch).toEqual({
      currentBytes: 0,
      maximumBytes: 16,
      currentOperations: 0,
      maximumOperations: 1,
    });
  });

  it('resets resource high-water marks to current live usage', () => {
    const diagnostics = createDeterministicDiagnostics({ timestamps: [] });

    diagnostics.adjustResourceUsage({
      resource: 'writer_dirty_chunks',
      byteDelta: 8,
      operationDelta: 2,
    });
    diagnostics.adjustResourceUsage({
      resource: 'writer_dirty_chunks',
      byteDelta: -4,
      operationDelta: -1,
    });
    diagnostics.resetResourceHighWaterMarks();

    expect(diagnostics.snapshot().resources.writerDirtyChunks).toEqual({
      currentBytes: 4,
      maximumBytes: 4,
      currentOperations: 1,
      maximumOperations: 1,
    });

    diagnostics.adjustResourceUsage({
      resource: 'writer_dirty_chunks',
      byteDelta: 2,
      operationDelta: 1,
    });
    expect(diagnostics.snapshot().resources.writerDirtyChunks).toEqual({
      currentBytes: 6,
      maximumBytes: 6,
      currentOperations: 2,
      maximumOperations: 2,
    });
  });

  it('rejects diagnostic resource underflow instead of hiding lifecycle bugs', () => {
    const diagnostics = createDeterministicDiagnostics({ timestamps: [] });

    expect(() => diagnostics.adjustResourceUsage({
      resource: 'writer_pending_chunk_writes',
      byteDelta: -1,
      operationDelta: 0,
    })).toThrow('resource usage became negative');
    expect(diagnostics.snapshot().resources.writerPendingChunkWrites).toEqual({
      currentBytes: 0,
      maximumBytes: 0,
      currentOperations: 0,
      maximumOperations: 0,
    });
  });

  it('returns detached snapshots that cannot mutate later counters', () => {
    const diagnostics = createDeterministicDiagnostics({ timestamps: [] });
    const first = diagnostics.snapshot();

    diagnostics.recordRecordWrite({
      kind: 'commit',
      plaintextByteLength: 10,
      physicalByteLength: 20,
    });
    diagnostics.recordCacheState({
      cache: 'metadata',
      byteLength: 10,
      entryCount: 1,
    });

    expect(first.records.commit.writeOperations).toBe(0);
    expect(first.caches.metadata.currentBytes).toBe(0);
    expect(diagnostics.snapshot().records.commit.writeOperations).toBe(1);
  });
});
