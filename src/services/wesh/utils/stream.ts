import type {
  WeshFileHandle,
  WeshIOResult,
  WeshWriteResult,
  WeshStat,
} from '@/services/wesh/types';

/**
 * Creates a Wesh file handle that reads from a ReadableStream.
 * Typically used to provide data to Wesh's 'stdin' or any input source.
 */
export function createWeshReadFileHandle({
  source,
}: {
  source: ReadableStream<Uint8Array>;
}): WeshFileHandle {
  const reader = source.getReader();
  let currentChunk: Uint8Array | undefined = undefined;
  let currentOffset = 0;
  let isDone = false;

  return {
    async read({
      buffer,
      offset,
      length,
    }: {
      buffer: Uint8Array;
      offset: number | undefined;
      length: number | undefined;
      position?: number | undefined;
    }): Promise<WeshIOResult> {
      if (isDone && currentChunk === undefined) return { bytesRead: 0 };

      // Pull next chunk from stream if current one is exhausted
      if (currentChunk === undefined) {
        try {
          const { value, done } = await reader.read();
          if (done) {
            isDone = true;
            return { bytesRead: 0 };
          }
          currentChunk = value;
          currentOffset = 0;
        } catch (e) {
          isDone = true;
          throw e;
        }
      }

      const bufferOffset = offset ?? 0;
      const maxLen = length ?? (buffer.length - bufferOffset);
      const remainingInChunk = currentChunk.length - currentOffset;
      const copyLen = Math.min(remainingInChunk, maxLen);

      buffer.set(currentChunk.subarray(currentOffset, currentOffset + copyLen), bufferOffset);
      currentOffset += copyLen;

      if (currentOffset >= currentChunk.length) {
        currentChunk = undefined;
      }

      return { bytesRead: copyLen };
    },

    async write(): Promise<WeshWriteResult> {
      throw new Error('Handle is read-only (createWeshReadFileHandle)');
    },

    async close(): Promise<void> {
      await reader.cancel();
      currentChunk = undefined;
      isDone = true;
    },

    async stat(): Promise<WeshStat> {
      return {
        size: 0,
        mode: 0o644,
        type: 'fifo',
        mtime: Date.now(),
        ino: 0,
        uid: 0,
        gid: 0,
      };
    },

    async truncate(): Promise<void> {
      throw new Error('Cannot truncate WeshReadFileHandle');
    },

    async ioctl(): Promise<{ ret: number }> {
      return { ret: 0 };
    },
  };
}

/**
 * Creates a Wesh file handle that writes to a WritableStream.
 * Typically used to capture output from Wesh's 'stdout', 'stderr', or any output sink.
 */
export function createWeshWriteFileHandle({
  target,
}: {
  target: WritableStream<Uint8Array>;
}): WeshFileHandle {
  const writer = target.getWriter();

  return {
    async read(): Promise<WeshIOResult> {
      throw new Error('Handle is write-only (createWeshWriteFileHandle)');
    },

    async write({
      buffer,
      offset,
      length,
    }: {
      buffer: Uint8Array;
      offset: number | undefined;
      length: number | undefined;
      position?: number | undefined;
    }): Promise<WeshWriteResult> {
      const bufferOffset = offset ?? 0;
      const actualLength = length ?? (buffer.length - bufferOffset);
      const data = buffer.subarray(bufferOffset, bufferOffset + actualLength);

      // We must copy the data because Wesh might reuse its internal buffer
      // and writer.write() might be asynchronous.
      await writer.write(new Uint8Array(data));

      return { bytesWritten: actualLength };
    },

    async close(): Promise<void> {
      await writer.close();
    },

    async stat(): Promise<WeshStat> {
      return {
        size: 0,
        mode: 0o644,
        type: 'fifo',
        mtime: Date.now(),
        ino: 0,
        uid: 0,
        gid: 0,
      };
    },

    async truncate(): Promise<void> {
      throw new Error('Cannot truncate WeshWriteFileHandle');
    },

    async ioctl(): Promise<{ ret: number }> {
      return { ret: 0 };
    },
  };
}
