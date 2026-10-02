import { describe, expect, it, vi } from 'vitest';
import { createBlobStorageBinaryObjectReadHandle } from '@/00-storage/service/binary-object-io';
import type { StorageFileHandle, StorageWritableFile } from './types';
import { writeStorageFileText, writeStorageReadableStream } from './io';

function createFileHandle({ writable }: {
  writable: StorageWritableFile;
}): StorageFileHandle {
  return {
    kind: 'file',
    name: 'value.bin',
    async stat() {
      return { size: 0, createdAt: undefined, modifiedAt: undefined };
    },
    async openReadable({ mimeType }) {
      return createBlobStorageBinaryObjectReadHandle({ blob: new Blob([]), mimeType });
    },
    async createWritable() {
      return writable;
    },
  };
}

function createWritable({ write, close, abort }: {
  write: StorageWritableFile['write'];
  close?: StorageWritableFile['close'];
  abort: StorageWritableFile['abort'];
}): StorageWritableFile {
  return {
    read: undefined,
    write,
    async truncate() {},
    close: close ?? (async () => {}),
    abort,
  };
}

function createGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('storage file-system write settlement', () => {
  it.each([0, 3])('aborts before close when cancellation arrives during EOF after %i bytes', async (byteLength) => {
    const eofRequested = createGate();
    const finishEof = createGate();
    const controller = new AbortController();
    const reason = new Error('cancel before commit');
    const writable = createWritable({
      write: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    });
    let sentChunk = false;
    const source = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        if (byteLength > 0 && !sentChunk) {
          sentChunk = true;
          streamController.enqueue(new Uint8Array(byteLength));
          return;
        }
        eofRequested.resolve();
        await finishEof.promise;
        streamController.close();
      },
    }, { highWaterMark: 0 });
    const operation = writeStorageReadableStream({
      fileHandle: createFileHandle({ writable }),
      source,
      expectedSize: byteLength,
      signal: controller.signal,
      onBytesWritten: undefined,
    });

    await eofRequested.promise;
    controller.abort(reason);
    const rejected = expect(operation).rejects.toBe(reason);
    finishEof.resolve();
    await rejected;

    expect(writable.write).toHaveBeenCalledTimes(byteLength > 0 ? 1 : 0);
    expect(writable.close).not.toHaveBeenCalled();
    expect(writable.abort).toHaveBeenCalledExactlyOnceWith({ reason });
    expect(source.locked).toBe(false);
  });

  it.each(['success', 'failure'] as const)('cleans up reader acquisition failure when writable abort is a %s', async (abortOutcome) => {
    const abortFailure = new Error('abort failed');
    const writable = createWritable({
      write: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {
        if (abortOutcome === 'failure') throw abortFailure;
      }),
    });
    const cancel = vi.fn();
    const chunk = new Uint8Array([1, 2, 3]);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
      },
      cancel,
    });
    const ownerReader = source.getReader();
    try {
      const failure: unknown = await writeStorageReadableStream({
        fileHandle: createFileHandle({ writable }),
        source,
        expectedSize: undefined,
        signal: undefined,
        onBytesWritten: undefined,
      }).catch((error: unknown) => error);

      expect(writable.abort).toHaveBeenCalledOnce();
      const reason = vi.mocked(writable.abort).mock.calls[0]![0].reason;
      expect(reason).toMatchObject({ name: 'TypeError' });
      if (abortOutcome === 'failure') {
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([reason, abortFailure]);
      } else {
        expect(failure).toBe(reason);
      }
      expect(writable.write).not.toHaveBeenCalled();
      expect(writable.close).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(source.locked).toBe(true);
      await expect(ownerReader.read()).resolves.toEqual({ done: false, value: chunk });
    } finally {
      ownerReader.releaseLock();
    }
  });

  it.each([false, true])('cleans up writable acquisition failure without taking a reader when locked=%s', async (locked) => {
    const failure = new Error('writable acquisition failed');
    const writable = createWritable({ write: vi.fn(), abort: vi.fn() });
    const fileHandle = createFileHandle({ writable });
    fileHandle.createWritable = vi.fn(async () => {
      throw failure;
    });
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel });
    const ownerReader = locked ? source.getReader() : undefined;
    const getReader = vi.spyOn(source, 'getReader');
    try {
      await expect(writeStorageReadableStream({
        fileHandle,
        source,
        expectedSize: undefined,
        signal: undefined,
        onBytesWritten: undefined,
      })).rejects.toBe(failure);

      expect(getReader).not.toHaveBeenCalled();
      expect(source.locked).toBe(locked);
      expect(writable.abort).not.toHaveBeenCalled();
      if (locked) expect(cancel).not.toHaveBeenCalled();
      else expect(cancel).toHaveBeenCalledExactlyOnceWith(failure);
    } finally {
      ownerReader?.releaseLock();
    }
  });

  it.each([
    { primary: new Error('open failed'), cleanup: new Error('cancel failed') },
    { primary: undefined, cleanup: undefined },
  ])('preserves writable acquisition and cancellation failures: $primary / $cleanup', async ({ primary, cleanup }) => {
    const writable = createWritable({ write: vi.fn(), abort: vi.fn() });
    const fileHandle = createFileHandle({ writable });
    fileHandle.createWritable = vi.fn(async () => {
      throw primary;
    });
    const cancel = vi.fn(async () => {
      throw cleanup;
    });
    const source = new ReadableStream<Uint8Array>({ cancel });
    const [outcome] = await Promise.allSettled([writeStorageReadableStream({
      fileHandle, source, expectedSize: undefined, signal: undefined, onBytesWritten: undefined,
    })]);

    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('expected writable acquisition failure');
    expect(outcome.reason).toBeInstanceOf(AggregateError);
    expect((outcome.reason as AggregateError).errors).toEqual([primary, cleanup]);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(primary);
    expect(writable.abort).not.toHaveBeenCalled();
  });

  it('waits for source cancellation after writable acquisition fails', async () => {
    const failure = new Error('open failed');
    const cancellationStarted = createGate();
    const cancellationFinished = createGate();
    const fileHandle = createFileHandle({ writable: createWritable({ write: vi.fn(), abort: vi.fn() }) });
    fileHandle.createWritable = vi.fn(async () => {
      throw failure;
    });
    const source = new ReadableStream<Uint8Array>({
      async cancel() {
        cancellationStarted.resolve();
        await cancellationFinished.promise;
      },
    });
    let settled = false;
    const outcome = writeStorageReadableStream({
      fileHandle, source, expectedSize: undefined, signal: undefined, onBytesWritten: undefined,
    }).then(() => {
      settled = true;
    }, error => {
      settled = true;
      return error;
    });
    await Promise.race([cancellationStarted.promise, outcome]);
    try {
      expect(settled).toBe(false);
    } finally {
      cancellationFinished.resolve();
    }
    await expect(outcome).resolves.toBe(failure);
  });

  it('keeps one MiB write chunks as views of the source buffer', async () => {
    const chunkSize = 1024 * 1024;
    const bytes = new Uint8Array(2 * chunkSize + 7);
    const writable = createWritable({
      write: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    });
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const onBytesWritten = vi.fn();

    await writeStorageReadableStream({
      fileHandle: createFileHandle({ writable }),
      source,
      expectedSize: bytes.byteLength,
      signal: undefined,
      onBytesWritten,
    });

    const writes = vi.mocked(writable.write).mock.calls.map(([argument]) => argument);
    expect(writes.map(({ data }) => data.byteLength)).toEqual([chunkSize, chunkSize, 7]);
    expect(writes.map(({ position }) => position)).toEqual([0, chunkSize, 2 * chunkSize]);
    for (const { position, data } of writes) {
      expect(data.buffer).toBe(bytes.buffer);
      expect(data.byteOffset).toBe(bytes.byteOffset + position);
    }
    expect(onBytesWritten.mock.calls).toEqual([
      [{ byteLength: chunkSize }],
      [{ byteLength: chunkSize }],
      [{ byteLength: 7 }],
    ]);
    expect(writable.close).toHaveBeenCalledOnce();
    expect(writable.abort).not.toHaveBeenCalled();
    expect(source.locked).toBe(false);
  });

  it('does not roll back cancellation after writable close has started', async () => {
    const closeStarted = createGate();
    const finishClose = createGate();
    const controller = new AbortController();
    const writable = createWritable({
      write: vi.fn(async () => {}),
      close: vi.fn(async () => {
        closeStarted.resolve();
        await finishClose.promise;
      }),
      abort: vi.fn(async () => {}),
    });
    const source = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.close();
      },
    });
    const operation = writeStorageReadableStream({
      fileHandle: createFileHandle({ writable }),
      source,
      expectedSize: 0,
      signal: controller.signal,
      onBytesWritten: undefined,
    });

    await closeStarted.promise;
    controller.abort(new Error('cancel after commit started'));
    finishClose.resolve();
    await operation;

    expect(writable.close).toHaveBeenCalledOnce();
    expect(writable.abort).not.toHaveBeenCalled();
    expect(source.locked).toBe(false);
  });

  it('preserves text write and writable abort failures in order', async () => {
    const writeFailure = new Error('text write failed');
    const abortFailure = new Error('text writable abort failed');
    const writable = createWritable({
      write: vi.fn(async () => {
        throw writeFailure;
      }),
      abort: vi.fn(async () => {
        throw abortFailure;
      }),
    });

    await expect(writeStorageFileText({
      fileHandle: createFileHandle({ writable }),
      value: 'value',
    })).rejects.toSatisfy((failure: unknown) => {
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([writeFailure, abortFailure]);
      return true;
    });
    expect(writable.abort).toHaveBeenCalledTimes(1);
  });

  it('preserves stream write, reader cancel, and writable abort failures in order', async () => {
    const writeFailure = new Error('stream write failed');
    const cancelFailure = new Error('source cancel failed');
    const abortFailure = new Error('stream writable abort failed');
    const writable = createWritable({
      write: vi.fn(async () => {
        throw writeFailure;
      }),
      abort: vi.fn(async () => {
        throw abortFailure;
      }),
    });
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        throw cancelFailure;
      },
    });

    await expect(writeStorageReadableStream({
      fileHandle: createFileHandle({ writable }),
      source,
      expectedSize: undefined,
      signal: undefined,
      onBytesWritten: undefined,
    })).rejects.toSatisfy((failure: unknown) => {
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([
        writeFailure,
        cancelFailure,
        abortFailure,
      ]);
      return true;
    });
    expect(writable.abort).toHaveBeenCalledTimes(1);
  });
});
