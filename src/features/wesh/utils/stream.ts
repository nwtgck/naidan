import type {
  WeshFileHandle,
  WeshFileHandleCloseSemantics,
  WeshIOResult,
  WeshWriteResult,
  WeshOwnedBytes,
  WeshStat,
} from '@/features/wesh/types';
import { WeshHandleCloseSignal } from './closeSignal';
import { OPEN_FILE_DESCRIPTION } from './file-input';

type StreamReadWaiter = ReturnType<typeof Promise.withResolvers<boolean>>;

interface StreamReadState {
  reader: ReadableStreamDefaultReader<Uint8Array>,
  readWaiters: Set<StreamReadWaiter> | undefined,
  readError: { error: unknown } | undefined,
  activeReads: number,
  currentChunk: Uint8Array | undefined,
  currentOffset: number,
  isDone: boolean,
  refCount: number,
  closed: boolean,
}

class StreamReadHandle implements WeshFileHandle {
  private readonly state: StreamReadState;
  private readonly closeSignal = new WeshHandleCloseSignal();

  constructor({ state }: { state: StreamReadState }) {
    this.state = state;
  }

  get [OPEN_FILE_DESCRIPTION](): object {
    return this.state;
  }

  async read({ buffer, offset, length, position: _position }: {
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number,
  }): Promise<WeshIOResult> {
    if (this.closeSignal.closed) {
      return { bytesRead: 0 };
    }

    const { state } = this;
    state.activeReads += 1;
    try {
      while (state.currentChunk === undefined) {
        if (this.closeSignal.closed) {
          return { bytesRead: 0 };
        }
        if (state.readError !== undefined) {
          throw state.readError.error;
        }
        if (state.isDone) {
          return { bytesRead: 0 };
        }
        const waiters = state.readWaiters ?? this.startRead();
        const waiter = Promise.withResolvers<boolean>();
        waiters.add(waiter);
        try {
          const available = await this.closeSignal.raceWithClose({ operation: waiter.promise, buildClosedResult: () => false });
          if (!available) {
            return { bytesRead: 0 };
          }
        } finally {
          waiters.delete(waiter);
        }
      }

      const chunk = state.currentChunk;
      const bufferOffset = offset ?? 0;
      const maxLen = length ?? (buffer.length - bufferOffset);
      const remainingInChunk = chunk.length - state.currentOffset;
      const copyLen = Math.min(remainingInChunk, maxLen);

      buffer.set(chunk.subarray(state.currentOffset, state.currentOffset + copyLen), bufferOffset);
      state.currentOffset += copyLen;

      if (state.currentOffset >= chunk.length) {
        state.currentChunk = undefined;
      }
      return { bytesRead: copyLen };
    } finally {
      state.activeReads -= 1;
      if (state.closed && state.activeReads === 0) {
        state.currentChunk = undefined;
      }
    }
  }

  private startRead(): Set<StreamReadWaiter> {
    // The shared stream owns its outstanding pull. Closing one descriptor
    // removes its waiter and leaves any bytes available to the other readers.
    const { state } = this;
    const waiters = new Set<StreamReadWaiter>();
    state.readWaiters = waiters;
    void state.reader.read().then(
      result => {
        state.readWaiters = undefined;
        if (result.done) {
          state.isDone = true;
        } else if (!state.closed || waiters.size !== 0) {
          state.currentChunk = result.value;
          state.currentOffset = 0;
        }
        for (const waiter of waiters) {
          waiter.resolve(!result.done);
        }
        waiters.clear();
      },
      (error: unknown) => {
        state.readWaiters = undefined;
        state.readError = { error };
        for (const waiter of waiters) {
          waiter.reject(error);
        }
        waiters.clear();
      },
    );
    return waiters;
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
      if (this.state.activeReads === 0) {
        this.state.currentChunk = undefined;
      }
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
    writer: WritableStreamDefaultWriter<Uint8Array>,
    refCount: number,
    closed: boolean,
  };
  private readonly closeSignal = new WeshHandleCloseSignal();

  constructor({ state }: {
    state: {
      writer: WritableStreamDefaultWriter<Uint8Array>,
      refCount: number,
      closed: boolean,
    },
  }) {
    this.state = state;
  }

  async read(): Promise<WeshIOResult> {
    throw new Error('Handle is write-only (createWeshWriteFileHandle)');
  }

  async write({
    buffer,
    offset,
    length,
  }: {
    buffer: Uint8Array,
    offset: number | undefined,
    length: number | undefined,
    position?: number | undefined,
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

  async writeOwned({ chunk }: { chunk: WeshOwnedBytes }): Promise<void> {
    if (this.closeSignal.closed) {
      return;
    }
    await this.closeSignal.raceWithClose({
      operation: this.state.writer.write(chunk.bytes),
      buildClosedResult: () => undefined,
    });
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
  source: ReadableStream<Uint8Array>,
}): WeshFileHandle {
  return new StreamReadHandle({
    state: {
      reader: source.getReader(),
      readWaiters: undefined,
      readError: undefined,
      activeReads: 0,
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
  target: WritableStream<Uint8Array>,
}): WeshFileHandle {
  return new StreamWriteHandle({
    state: {
      writer: target.getWriter(),
      refCount: 1,
      closed: false,
    },
  });
}


export async function* iterateReadableStreamChunks({
  stream,
}: {
  stream: ReadableStream<Uint8Array>,
}): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        return;
      }
      yield value;
    }
  } finally {
    if (!completed) {
      await reader.cancel();
    }
    reader.releaseLock();
  }
}


export function pipeThroughBufferSourceTransform({
  source,
  transform,
}: {
  source: ReadableStream<Uint8Array>,
  transform: {
    readable: ReadableStream<Uint8Array>,
    writable: WritableStream<BufferSource>,
  },
}): ReadableStream<Uint8Array> {
  const byteTransform: ReadableWritablePair<Uint8Array, Uint8Array> = {
    readable: transform.readable,
    writable: transform.writable as unknown as WritableStream<Uint8Array>,
  };
  return source.pipeThrough(byteTransform);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
