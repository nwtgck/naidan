import type { StorageBinaryObjectReadHandle } from '@/00-storage/service/binary-object-io';
import type { HizoFSExtentIndex } from './extent-index';
import type { HizoFSFileChunkStore } from './file-chunk-store';
import type { LoadedHizoFSFile } from './node-service';

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
      throw new Error(`HizoFS read ${fieldName} must be a non-negative safe integer`);
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
    onSettled,
  }: {
    file: LoadedHizoFSFile;
    extentIndex: HizoFSExtentIndex;
    chunkStore: HizoFSFileChunkStore;
    mimeType: string;
    streamChunkSize: number;
    onSettled: () => void;
  }) {
    this.file = file;
    this.extentIndex = extentIndex;
    this.chunkStore = chunkStore;
    this.mimeType = mimeType;
    this.streamChunkSize = streamChunkSize;
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
  private readonly onSettled: () => void;
  private closed = false;

  async read({ buffer, offset, length, position, signal }: {
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
      return { bytesRead: 0 };
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
      });
      break;
    default: {
      const _ex: never = this.file.inode.storage;
      throw new Error(`Unhandled HizoFS file storage: ${String(_ex)}`);
    }
    }
    signal?.throwIfAborted();
    return { bytesRead };
  }

  stream({ start, end, signal }: {
    start: number;
    end: number | undefined;
    signal: AbortSignal | undefined;
  }): ReadableStream<Uint8Array> {
    this.assertOpen();
    if (!Number.isSafeInteger(start) || start < 0) {
      throw new Error('HizoFS stream start must be a non-negative safe integer');
    }
    if (end !== undefined && (!Number.isSafeInteger(end) || end < start)) {
      throw new Error('HizoFS stream end must be a safe integer not smaller than start');
    }
    const finalEnd = Math.min(end ?? this.size, this.size);
    let position = Math.min(start, finalEnd);
    return new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          signal?.throwIfAborted();
          if (position >= finalEnd) {
            controller.close();
            return;
          }
          const bytes = new Uint8Array(Math.min(this.streamChunkSize, finalEnd - position));
          const { bytesRead } = await this.read({
            buffer: bytes,
            offset: 0,
            length: bytes.byteLength,
            position,
            signal,
          });
          position += bytesRead;
          controller.enqueue(bytesRead === bytes.byteLength ? bytes : bytes.subarray(0, bytesRead));
        } catch (error) {
          controller.error(error);
        }
      },
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onSettled();
  }

  private async readExtents({ buffer, offset, length, position, signal }: {
    buffer: Uint8Array;
    offset: number;
    length: number;
    position: number;
    signal: AbortSignal | undefined;
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
    let remaining = length;
    let sourcePosition = position;
    let destinationOffset = offset;
    while (remaining > 0) {
      signal?.throwIfAborted();
      const chunkIndex = Math.floor(sourcePosition / storage.chunkSize);
      const offsetInChunk = sourcePosition % storage.chunkSize;
      const copyLength = Math.min(remaining, storage.chunkSize - offsetInChunk);
      const extent = await this.extentIndex.get({
        rootObjectId: storage.extentIndexRootObjectId,
        chunkIndex,
      });
      if (extent === undefined) {
        buffer.fill(0, destinationOffset, destinationOffset + copyLength);
      } else {
        const chunk = await this.chunkStore.read({
          objectId: extent.chunkObjectId,
          chunkSize: storage.chunkSize,
        });
        const available = Math.max(0, Math.min(copyLength, chunk.byteLength - offsetInChunk));
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
      sourcePosition += copyLength;
      destinationOffset += copyLength;
      remaining -= copyLength;
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
