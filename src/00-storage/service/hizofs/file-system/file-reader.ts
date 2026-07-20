import type { StorageBinaryObjectReadHandle } from '@/00-storage/service/binary-object-io';
import type {
  HizoFSExtentIndex,
  HizoFSExtentIndexLookupCache,
} from './extent-index';
import type { HizoFSFileChunkStore } from './file-chunk-store';
import type { HizoFSMaintenanceLease } from './maintenance-lock';
import type { LoadedHizoFSFile } from './node-service';
import type { HizoFSRuntimeDiagnostics } from './diagnostics';

type PrefetchedChunkResult =
  | {
      readonly status: 'fulfilled';
      readonly chunk: Uint8Array | undefined;
    }
  | {
      readonly status: 'rejected';
      readonly error: unknown;
    };

type PrefetchedChunk = {
  readonly reservedByteLength: number;
  readonly result: Promise<PrefetchedChunkResult>;
};

function assertReadArguments({
  buffer,
  offset,
  length,
  position,
}: {
  buffer: Uint8Array;
  offset: number;
  length: number;
  position: number;
}): void {
  for (const [fieldName, value] of [
    ['offset', offset],
    ['length', length],
    ['position', position],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `HizoFS read ${fieldName} must be a non-negative safe integer`,
      );
    }
  }
  if (offset + length > buffer.byteLength) {
    throw new Error('HizoFS read range exceeds the destination buffer');
  }
}

async function awaitAbortableRead<T>({
  operation,
  signal,
  disposeLateValue,
  trackLateCleanup,
}: {
  operation: Promise<T>;
  signal: AbortSignal | undefined;
  disposeLateValue: ({ value }: { value: T }) => void;
  trackLateCleanup: ({ cleanup }: { cleanup: Promise<void> }) => void;
}): Promise<T> {
  if (signal === undefined) return await operation;
  signal.throwIfAborted();
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([operation, aborted.promise]);
  } catch (error) {
    if (signal.aborted) {
      const cleanup = operation.then(
        value => disposeLateValue({ value }),
        () => undefined,
      );
      trackLateCleanup({ cleanup });
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export class HizoFSFileReader implements StorageBinaryObjectReadHandle {
  constructor({
    file,
    extentIndex,
    chunkStore,
    mimeType,
    streamChunkSize,
    prefetchConcurrency,
    maintenanceLease,
    diagnostics,
    onSettled,
  }: {
    file: LoadedHizoFSFile;
    extentIndex: HizoFSExtentIndex;
    chunkStore: HizoFSFileChunkStore;
    mimeType: string;
    streamChunkSize: number;
    prefetchConcurrency: number;
    maintenanceLease: HizoFSMaintenanceLease;
    diagnostics: HizoFSRuntimeDiagnostics | undefined;
    onSettled: () => void;
  }) {
    if (!Number.isSafeInteger(prefetchConcurrency) || prefetchConcurrency < 1) {
      throw new Error(
        'HizoFS fileChunkReadPrefetchConcurrency must be a positive safe integer',
      );
    }
    this.file = file;
    this.extentIndex = extentIndex;
    this.chunkStore = chunkStore;
    this.mimeType = mimeType;
    this.streamChunkSize = streamChunkSize;
    this.prefetchConcurrency = prefetchConcurrency;
    this.maintenanceLease = maintenanceLease;
    this.diagnostics = diagnostics;
    this.onSettled = onSettled;
    this.size = file.inode.size;
  }

  readonly size: number;
  readonly mimeType: string;
  readonly backing = { type: 'reader_only' as const };

  private readonly file: LoadedHizoFSFile;
  private readonly extentIndex: HizoFSExtentIndex;
  private readonly chunkStore: HizoFSFileChunkStore;
  private readonly streamChunkSize: number;
  private readonly prefetchConcurrency: number;
  private readonly maintenanceLease: HizoFSMaintenanceLease;
  private readonly diagnostics: HizoFSRuntimeDiagnostics | undefined;
  private readonly onSettled: () => void;
  private readonly extentLookupCache: HizoFSExtentIndexLookupCache = { value: undefined };
  private readonly prefetchedChunks = new Map<number, PrefetchedChunk>();
  private readonly prefetchCleanupTasks = new Set<Promise<void>>();
  private readonly lateReadCleanupTasks = new Set<Promise<void>>();
  private lastReadEndPosition: number | undefined;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private activeReadCount = 0;
  private activeReadsSettled: PromiseWithResolvers<void> | undefined;

  async read({
    buffer,
    offset,
    length,
    position,
    signal,
  }: {
    buffer: Uint8Array;
    offset: number;
    length: number;
    position: number;
    signal: AbortSignal | undefined;
  }): Promise<{ bytesRead: number }> {
    const finishRead = this.beginRead();
    try {
      assertReadArguments({ buffer, offset, length, position });
      signal?.throwIfAborted();
      const bytesRead = Math.max(0, Math.min(length, this.size - position));
      if (bytesRead === 0) {
        this.lastReadEndPosition = position;
        return { bytesRead: 0 };
      }

      const enableSequentialPrefetch = this.prefetchConcurrency > 1
      && this.lastReadEndPosition === position;
      if (this.prefetchConcurrency > 1 && !enableSequentialPrefetch) {
        this.discardPrefetchedChunks();
      }

      switch (this.file.inode.storage.type) {
      case 'inline':
        buffer.set(
          this.file.binaryPayload.subarray(position, position + bytesRead),
          offset,
        );
        break;
      case 'extents':
        await this.readExtents({
          buffer,
          offset,
          length: bytesRead,
          position,
          signal,
          enableSequentialPrefetch,
        });
        break;
      default: {
        const _ex: never = this.file.inode.storage;
        throw new Error(`Unhandled HizoFS file storage: ${String(_ex)}`);
      }
      }
      signal?.throwIfAborted();
      this.lastReadEndPosition = position + bytesRead;
      return { bytesRead };
    } finally {
      finishRead();
    }
  }

  stream({
    start,
    end,
    signal,
  }: {
    start: number;
    end: number | undefined;
    signal: AbortSignal | undefined;
  }): ReadableStream<Uint8Array> {
    this.assertOpen();
    if (!Number.isSafeInteger(start) || start < 0) {
      throw new Error(
        'HizoFS stream start must be a non-negative safe integer',
      );
    }
    if (end !== undefined && (!Number.isSafeInteger(end) || end < start)) {
      throw new Error(
        'HizoFS stream end must be a safe integer not smaller than start',
      );
    }
    const streamAbortController = new AbortController();
    const readSignal = signal === undefined
      ? streamAbortController.signal
      : AbortSignal.any([signal, streamAbortController.signal]);
    const finalEnd = Math.min(end ?? this.size, this.size);
    let position = Math.min(start, finalEnd);
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          readSignal.throwIfAborted();
          if (position >= finalEnd) {
            controller.close();
            return;
          }
          const bytes = new Uint8Array(
            Math.min(this.streamChunkSize, finalEnd - position),
          );
          const { bytesRead } = await this.read({
            buffer: bytes,
            offset: 0,
            length: bytes.byteLength,
            position,
            signal: readSignal,
          });
          position += bytesRead;
          controller.enqueue(
            bytesRead === bytes.byteLength
              ? bytes
              : bytes.subarray(0, bytesRead),
          );
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: () => {
        streamAbortController.abort(
          new DOMException('HizoFS stream was cancelled', 'AbortError'),
        );
      },
    });
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.closed = true;
    await this.activeReadsSettled?.promise;
    await Promise.all([...this.lateReadCleanupTasks]);
    try {
      try {
        await this.clearPrefetchedChunks();
      } finally {
        this.extentLookupCache.value = undefined;
        await this.maintenanceLease.release();
      }
    } finally {
      this.onSettled();
    }
  }

  private async readExtents({
    buffer,
    offset,
    length,
    position,
    signal,
    enableSequentialPrefetch,
  }: {
    buffer: Uint8Array;
    offset: number;
    length: number;
    position: number;
    signal: AbortSignal | undefined;
    enableSequentialPrefetch: boolean;
  }): Promise<void> {
    const storage = this.file.inode.storage;
    switch (storage.type) {
    case 'extents':
      break;
    case 'inline':
      throw new Error('HizoFS extent reader received an inline file');
    default: {
      const _ex: never = storage;
      throw new Error(`Unhandled HizoFS file storage: ${String(_ex)}`);
    }
    }
    if (enableSequentialPrefetch) {
      this.schedulePrefetchWindow({
        storage,
        firstChunkIndex: Math.floor(position / storage.chunkSize),
      });
    }

    let remaining = length;
    let sourcePosition = position;
    let destinationOffset = offset;
    while (remaining > 0) {
      signal?.throwIfAborted();
      const chunkIndex = Math.floor(sourcePosition / storage.chunkSize);
      const offsetInChunk = sourcePosition % storage.chunkSize;
      const copyLength = Math.min(remaining, storage.chunkSize - offsetInChunk);
      const chunkRange = await awaitAbortableRead({
        operation: this.readChunkRange({
          storage,
          chunkIndex,
          offsetInChunk,
          length: copyLength,
        }),
        signal,
        disposeLateValue: ({ value }) => value?.fill(0),
        trackLateCleanup: ({ cleanup }) => {
          this.lateReadCleanupTasks.add(cleanup);
          void cleanup.finally(() => this.lateReadCleanupTasks.delete(cleanup));
        },
      });
      try {
        signal?.throwIfAborted();
        this.assertOpen();
        if (chunkRange === undefined) {
          buffer.fill(0, destinationOffset, destinationOffset + copyLength);
        } else {
          buffer.set(chunkRange, destinationOffset);
          if (chunkRange.byteLength < copyLength) {
            buffer.fill(
              0,
              destinationOffset + chunkRange.byteLength,
              destinationOffset + copyLength,
            );
          }
        }
      } finally {
        chunkRange?.fill(0);
      }
      sourcePosition += copyLength;
      destinationOffset += copyLength;
      remaining -= copyLength;
    }
  }

  private schedulePrefetchWindow({
    storage,
    firstChunkIndex,
  }: {
    storage: Extract<LoadedHizoFSFile['inode']['storage'], { type: 'extents' }>;
    firstChunkIndex: number;
  }): void {
    const chunkCount = Math.ceil(this.size / storage.chunkSize);
    const endChunkIndex = Math.min(
      firstChunkIndex + this.prefetchConcurrency,
      chunkCount,
    );
    this.discardPrefetchedChunksOutside({
      minimumChunkIndex: firstChunkIndex,
      maximumChunkIndexExclusive: endChunkIndex,
    });
    for (
      let chunkIndex = firstChunkIndex;
      chunkIndex < endChunkIndex;
      chunkIndex += 1
    ) {
      if (this.prefetchedChunks.has(chunkIndex)) continue;
      const reservedByteLength = storage.chunkSize;
      this.adjustPrefetchUsage({
        byteDelta: reservedByteLength,
        operationDelta: 1,
      });
      const result = this.loadChunk({ storage, chunkIndex }).then(
        chunk => ({ status: 'fulfilled' as const, chunk }),
        error => ({ status: 'rejected' as const, error }),
      );
      this.prefetchedChunks.set(chunkIndex, { reservedByteLength, result });
    }
  }

  private async readChunkRange({
    storage,
    chunkIndex,
    offsetInChunk,
    length,
  }: {
    storage: Extract<LoadedHizoFSFile['inode']['storage'], { type: 'extents' }>;
    chunkIndex: number;
    offsetInChunk: number;
    length: number;
  }): Promise<Uint8Array | undefined> {
    const prefetched = this.prefetchedChunks.get(chunkIndex);
    if (prefetched === undefined) {
      const extent = await this.extentIndex.getWithLeafCache({
        rootObjectId: storage.extentIndexRootObjectId,
        chunkIndex,
        cache: this.extentLookupCache,
      });
      if (extent === undefined) return undefined;
      return this.chunkStore.readRange({
        objectId: extent.chunkObjectId,
        chunkSize: storage.chunkSize,
        offset: offsetInChunk,
        length,
      });
    }

    const chunk = await this.readChunk({ storage, chunkIndex });
    if (chunk === undefined) return undefined;
    try {
      return chunk.slice(offsetInChunk, offsetInChunk + length);
    } finally {
      chunk.fill(0);
    }
  }

  private async readChunk({
    storage,
    chunkIndex,
  }: {
    storage: Extract<LoadedHizoFSFile['inode']['storage'], { type: 'extents' }>;
    chunkIndex: number;
  }): Promise<Uint8Array | undefined> {
    const prefetched = this.prefetchedChunks.get(chunkIndex);
    if (prefetched === undefined) {
      return this.loadChunk({ storage, chunkIndex });
    }
    this.prefetchedChunks.delete(chunkIndex);
    const result = await prefetched.result;
    this.adjustPrefetchUsage({
      byteDelta: -prefetched.reservedByteLength,
      operationDelta: -1,
    });
    switch (result.status) {
    case 'fulfilled':
      return result.chunk;
    case 'rejected':
      throw result.error;
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled HizoFS prefetch result: ${String(_ex)}`);
    }
    }
  }

  private async loadChunk({
    storage,
    chunkIndex,
  }: {
    storage: Extract<LoadedHizoFSFile['inode']['storage'], { type: 'extents' }>;
    chunkIndex: number;
  }): Promise<Uint8Array | undefined> {
    const extent = await this.extentIndex.getWithLeafCache({
      rootObjectId: storage.extentIndexRootObjectId,
      chunkIndex,
      cache: this.extentLookupCache,
    });
    if (extent === undefined) return undefined;
    return this.chunkStore.read({
      objectId: extent.chunkObjectId,
      chunkSize: storage.chunkSize,
    });
  }

  private discardPrefetchedChunksOutside({
    minimumChunkIndex,
    maximumChunkIndexExclusive,
  }: {
    minimumChunkIndex: number;
    maximumChunkIndexExclusive: number;
  }): void {
    for (const [chunkIndex, prefetched] of this.prefetchedChunks) {
      if (
        chunkIndex >= minimumChunkIndex
        && chunkIndex < maximumChunkIndexExclusive
      ) {
        continue;
      }
      this.prefetchedChunks.delete(chunkIndex);
      this.schedulePrefetchCleanup({ prefetched });
    }
  }

  private discardPrefetchedChunks(): void {
    for (const prefetched of this.prefetchedChunks.values()) {
      this.schedulePrefetchCleanup({ prefetched });
    }
    this.prefetchedChunks.clear();
  }

  private schedulePrefetchCleanup({
    prefetched,
  }: {
    prefetched: PrefetchedChunk;
  }): void {
    const cleanup = prefetched.result.then((result) => {
      try {
        this.clearPrefetchedChunkResult({ result });
      } finally {
        this.adjustPrefetchUsage({
          byteDelta: -prefetched.reservedByteLength,
          operationDelta: -1,
        });
      }
    });
    this.prefetchCleanupTasks.add(cleanup);
    void cleanup.then(
      () => this.prefetchCleanupTasks.delete(cleanup),
      () => {
        // Keep rejected cleanup tasks for close() to observe after all settle.
      },
    );
  }

  private async clearPrefetchedChunks(): Promise<void> {
    const prefetchedChunks = [...this.prefetchedChunks.values()];
    this.prefetchedChunks.clear();
    const results = await Promise.all(
      prefetchedChunks.map(prefetched => prefetched.result),
    );
    let firstError: unknown;
    for (const [index, result] of results.entries()) {
      const prefetched = prefetchedChunks[index];
      if (prefetched === undefined) continue;
      try {
        this.clearPrefetchedChunkResult({ result });
      } catch (error) {
        firstError ??= error;
      } finally {
        try {
          this.adjustPrefetchUsage({
            byteDelta: -prefetched.reservedByteLength,
            operationDelta: -1,
          });
        } catch (error) {
          firstError ??= error;
        }
      }
    }
    const cleanupResults = await Promise.allSettled([
      ...this.prefetchCleanupTasks,
    ]);
    this.prefetchCleanupTasks.clear();
    const cleanupFailure = cleanupResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    firstError ??= cleanupFailure?.reason;
    if (firstError !== undefined) throw firstError;
  }

  private adjustPrefetchUsage({
    byteDelta,
    operationDelta,
  }: {
    byteDelta: number;
    operationDelta: number;
  }): void {
    this.diagnostics?.adjustResourceUsage({
      resource: 'reader_prefetch',
      byteDelta,
      operationDelta,
    });
  }

  private clearPrefetchedChunkResult({
    result,
  }: {
    result: PrefetchedChunkResult;
  }): void {
    switch (result.status) {
    case 'fulfilled':
      result.chunk?.fill(0);
      break;
    case 'rejected':
      break;
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled HizoFS prefetch result: ${String(_ex)}`);
    }
    }
  }

  private beginRead(): () => void {
    this.assertOpen();
    if (this.activeReadCount === 0) {
      this.activeReadsSettled = Promise.withResolvers<void>();
    }
    this.activeReadCount += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.activeReadCount -= 1;
      if (this.activeReadCount === 0) {
        this.activeReadsSettled?.resolve();
        this.activeReadsSettled = undefined;
      }
    };
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('HizoFS file reader is closed');
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
