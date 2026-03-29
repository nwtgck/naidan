import type {
  WeshFileHandle,
  WeshFileHandleCloseSemantics,
  WeshIOResult,
  WeshWriteResult,
  WeshStat,
} from '@/services/wesh/types';
import { WeshHandleCloseSignal } from './closeSignal';

class StreamReadHandle implements WeshFileHandle {
  private readonly state: {
    reader: ReadableStreamDefaultReader<Uint8Array>;
    currentChunk: Uint8Array | undefined;
    currentOffset: number;
    isDone: boolean;
    refCount: number;
    closed: boolean;
  };
  private readonly closeSignal = new WeshHandleCloseSignal({});

  constructor(options: {
    state: {
      reader: ReadableStreamDefaultReader<Uint8Array>;
      currentChunk: Uint8Array | undefined;
      currentOffset: number;
      isDone: boolean;
      refCount: number;
      closed: boolean;
    };
  }) {
    this.state = options.state;
  }

  async read(options: {
    buffer: Uint8Array;
    offset?: number;
    length?: number;
    position?: number;
  }): Promise<WeshIOResult> {
    if (this.closeSignal.closed || (this.state.isDone && this.state.currentChunk === undefined)) {
      return { bytesRead: 0 };
    }

    if (this.state.currentChunk === undefined) {
      try {
        const result = await this.closeSignal.raceWithClose({
          operation: this.state.reader.read(),
          buildClosedResult: () => ({
            done: true as const,
            value: undefined,
          }),
        });
        if (result.done) {
          this.state.isDone = true;
          return { bytesRead: 0 };
        }
        this.state.currentChunk = result.value;
        this.state.currentOffset = 0;
      } catch (error: unknown) {
        this.state.isDone = true;
        throw error;
      }
    }

    const chunk = this.state.currentChunk;
    if (chunk === undefined) {
      return { bytesRead: 0 };
    }

    const bufferOffset = options.offset ?? 0;
    const maxLen = options.length ?? (options.buffer.length - bufferOffset);
    const remainingInChunk = chunk.length - this.state.currentOffset;
    const copyLen = Math.min(remainingInChunk, maxLen);

    options.buffer.set(
      chunk.subarray(this.state.currentOffset, this.state.currentOffset + copyLen),
      bufferOffset,
    );
    this.state.currentOffset += copyLen;

    if (this.state.currentOffset >= chunk.length) {
      this.state.currentChunk = undefined;
    }

    return { bytesRead: copyLen };
  }

  async write(): Promise<WeshWriteResult> {
    throw new Error('Handle is read-only (createWeshReadFileHandle)');
  }

  async close(): Promise<void> {
    if (this.closeSignal.closed) {
      return;
    }
    this.closeSignal.close();
    this.state.refCount -= 1;
    if (this.state.refCount <= 0 && !this.state.closed) {
      this.state.closed = true;
      this.state.currentChunk = undefined;
      this.state.isDone = true;
      await this.state.reader.cancel();
    }
  }

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
  }

  async truncate(): Promise<void> {
    throw new Error('Cannot truncate WeshReadFileHandle');
  }

  async ioctl(): Promise<{ ret: number }> {
    return { ret: 0 };
  }

  cloneReference(): WeshFileHandle {
    this.state.refCount += 1;
    return new StreamReadHandle({
      state: this.state,
    });
  }

  getCloseSemantics(): WeshFileHandleCloseSemantics {
    return 'hard';
  }
}

class StreamWriteHandle implements WeshFileHandle {
  private readonly state: {
    writer: WritableStreamDefaultWriter<Uint8Array>;
    refCount: number;
    closed: boolean;
  };
  private readonly closeSignal = new WeshHandleCloseSignal({});

  constructor(options: {
    state: {
      writer: WritableStreamDefaultWriter<Uint8Array>;
      refCount: number;
      closed: boolean;
    };
  }) {
    this.state = options.state;
  }

  async read(): Promise<WeshIOResult> {
    throw new Error('Handle is write-only (createWeshWriteFileHandle)');
  }

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
    if (this.closeSignal.closed) {
      return { bytesWritten: 0 };
    }

    const bufferOffset = offset ?? 0;
    const actualLength = length ?? (buffer.length - bufferOffset);
    const data = buffer.subarray(bufferOffset, bufferOffset + actualLength);

    await this.closeSignal.raceWithClose({
      operation: this.state.writer.write(new Uint8Array(data)),
      buildClosedResult: () => undefined,
    });
    if (this.closeSignal.closed) {
      return { bytesWritten: 0 };
    }

    return { bytesWritten: actualLength };
  }

  async close(): Promise<void> {
    if (this.closeSignal.closed) {
      return;
    }
    this.closeSignal.close();
    this.state.refCount -= 1;
    if (this.state.refCount <= 0 && !this.state.closed) {
      this.state.closed = true;
      await this.state.writer.close();
    }
  }

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
  }

  async truncate(): Promise<void> {
    throw new Error('Cannot truncate WeshWriteFileHandle');
  }

  async ioctl(): Promise<{ ret: number }> {
    return { ret: 0 };
  }

  cloneReference(): WeshFileHandle {
    this.state.refCount += 1;
    return new StreamWriteHandle({
      state: this.state,
    });
  }

  getCloseSemantics(): WeshFileHandleCloseSemantics {
    return 'hard';
  }
}

/**
 * Creates a Wesh file handle that reads from a ReadableStream.
 * Typically used to provide data to Wesh's 'stdin' or any input source.
 */
export function createReadHandleFromStream({
  source,
}: {
  source: ReadableStream<Uint8Array>;
}): WeshFileHandle {
  return new StreamReadHandle({
    state: {
      reader: source.getReader(),
      currentChunk: undefined,
      currentOffset: 0,
      isDone: false,
      refCount: 1,
      closed: false,
    },
  });
}

/**
 * Creates a Wesh file handle that writes to a WritableStream.
 * Typically used to capture output from Wesh's 'stdout', 'stderr', or any output sink.
 */
export function createWriteHandleFromStream({
  target,
}: {
  target: WritableStream<Uint8Array>;
}): WeshFileHandle {
  return new StreamWriteHandle({
    state: {
      writer: target.getWriter(),
      refCount: 1,
      closed: false,
    },
  });
}
