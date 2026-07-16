import type { StorageBinaryObjectReadHandle } from '@/00-storage/service/binary-object-io';
import type { HizoFSExtentIndex } from './extent-index';
import type { HizoFSFileChunkStore } from './file-chunk-store';
import type { HizoFSMaintenanceLease } from './maintenance-lock';
import type { LoadedHizoFSFile } from './node-service';

type PrefetchedChunkResult =
  | {
      readonly status: 'fulfilled';
      readonly chunk: Uint8Array | undefined;
    }
  | {
      readonly status: 'rejected';
      readonly error: unknown;
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

export class HizoFSFileReader implements StorageBinaryObjectReadHandle {
  constructor({
    file,
    extentIndex,
    chunkStore,
    mimeType,
    streamChunkSize,
    prefetchConcurrency,
    maintenanceLease,
    onSettled,
  }: {
    file: LoadedHizoFSFile;
    extentIndex: HizoFSExtentIndex;
    chunkStore: HizoFSFileChunkStore;
    mimeType: string;
    streamChunkSize: number;
    prefetchConcurrency: number;
    maintenanceLease: HizoFSMaintenanceLease;
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
  private readonly onSettled: () => void;
  private readonly prefetchedChunks = new Map<
    number,
    Promise<PrefetchedChunkResult>
  >();
  private readonly prefetchCleanupTasks = new Set<Promise<void>>();
  private lastReadEndPosition: number | undefined;
  private closed = false;

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
    this.assertOpen();
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
    const finalEnd = Math.min(end ?? this.size, this.size);
    let position = Math.min(start, finalEnd);
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          signal?.throwIfAborted();
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
            signal,
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
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.clearPrefetchedChunks();
      await this.maintenanceLease.release();
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
      const chunk = await this.readChunk({ storage, chunkIndex });
      try {
        if (chunk === undefined) {
          buffer.fill(0, destinationOffset, destinationOffset + copyLength);
        } else {
          const available = Math.max(
            0,
            Math.min(copyLength, chunk.byteLength - offsetInChunk),
          );
          if (available > 0) {
            buffer.set(
              chunk.subarray(offsetInChunk, offsetInChunk + available),
              destinationOffset,
            );
          }
          if (available < copyLength) {
            buffer.fill(
              0,
              destinationOffset + available,
              destinationOffset + copyLength,
            );
          }
        }
      } finally {
        chunk?.fill(0);
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
      const pending = this.loadChunk({ storage, chunkIndex }).then(
        chunk => ({ status: 'fulfilled' as const, chunk }),
        error => ({ status: 'rejected' as const, error }),
      );
      this.prefetchedChunks.set(chunkIndex, pending);
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
    const result = await prefetched;
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
    const extent = await this.extentIndex.get({
      rootObjectId: storage.extentIndexRootObjectId,
      chunkIndex,
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
    for (const [chunkIndex, pending] of this.prefetchedChunks) {
      if (
        chunkIndex >= minimumChunkIndex
        && chunkIndex < maximumChunkIndexExclusive
      ) {
        continue;
      }
      this.prefetchedChunks.delete(chunkIndex);
      this.schedulePrefetchCleanup({ pending });
    }
  }

  private discardPrefetchedChunks(): void {
    for (const pending of this.prefetchedChunks.values()) {
      this.schedulePrefetchCleanup({ pending });
    }
    this.prefetchedChunks.clear();
  }

  private schedulePrefetchCleanup({
    pending,
  }: {
    pending: Promise<PrefetchedChunkResult>;
  }): void {
    const cleanup = pending.then(result => this.clearPrefetchedChunkResult({ result }));
    this.prefetchCleanupTasks.add(cleanup);
    void cleanup.then(() => this.prefetchCleanupTasks.delete(cleanup));
  }

  private async clearPrefetchedChunks(): Promise<void> {
    const pending = [...this.prefetchedChunks.values()];
    this.prefetchedChunks.clear();
    const results = await Promise.all(pending);
    for (const result of results) {
      this.clearPrefetchedChunkResult({ result });
    }
    await Promise.all([...this.prefetchCleanupTasks]);
    this.prefetchCleanupTasks.clear();
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
