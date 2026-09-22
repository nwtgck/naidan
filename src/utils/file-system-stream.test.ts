import { describe, expect, it, vi } from 'vitest';

import {
  copyFileSystemFileHandle,
  isFileSystemEntryLookupMiss,
  writeReadableStreamToFileHandle,
} from './file-system-stream';

function createTargetHandle({
  write = vi.fn().mockResolvedValue(undefined),
}: {
  write?: ReturnType<typeof vi.fn>,
} = {}) {
  const writable = {
    write,
    close: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
  };
  const targetHandle = {
    createWritable: vi.fn().mockResolvedValue(writable),
  } as unknown as FileSystemFileHandle;
  return { targetHandle, writable };
}

describe('file-system-stream', () => {
  it('distinguishes lookup misses from permission failures', () => {
    expect(isFileSystemEntryLookupMiss({
      error: new DOMException('missing', 'NotFoundError'),
    })).toBe(true);
    expect(isFileSystemEntryLookupMiss({
      error: new Error("TypeMismatchError: Entry 'item' has another kind."),
    })).toBe(true);
    expect(isFileSystemEntryLookupMiss({
      error: new DOMException('permission denied', 'NotAllowedError'),
    })).toBe(false);
  });

  it('does not open the target when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled', 'AbortError'));
    const { targetHandle } = createTargetHandle();
    const source = new ReadableStream<Uint8Array>();

    await expect(writeReadableStreamToFileHandle({
      source,
      targetHandle,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(targetHandle.createWritable).not.toHaveBeenCalled();
  });

  it('cancels the source when opening the target fails', async () => {
    const openError = new Error('cannot open target');
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel });
    const targetHandle = {
      createWritable: vi.fn().mockRejectedValue(openError),
    } as unknown as FileSystemFileHandle;

    await expect(writeReadableStreamToFileHandle({
      source,
      targetHandle,
      signal: undefined,
    })).rejects.toBe(openError);

    expect(cancel).toHaveBeenCalledWith(openError);
  });

  it('writes chunks with backpressure and closes the target', async () => {
    const events: string[] = [];
    const { targetHandle, writable } = createTargetHandle({
      write: vi.fn(async () => {
        events.push('write');
      }),
    });
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]));
        controller.enqueue(Uint8Array.from([3]));
        controller.close();
      },
    });

    await writeReadableStreamToFileHandle({
      source,
      targetHandle,
      signal: undefined,
    });

    expect(events).toEqual(['write', 'write']);
    expect(writable.write).toHaveBeenCalledTimes(2);
    expect(writable.close).toHaveBeenCalledOnce();
    expect(writable.abort).not.toHaveBeenCalled();
  });

  it('copies a file through Blob.stream without reading the full ArrayBuffer', async () => {
    const arrayBuffer = vi.fn(async () => {
      throw new Error('full arrayBuffer must not be used');
    });
    const file = {
      arrayBuffer,
      stream: () => new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('streamed'));
          controller.close();
        },
      }),
    } as unknown as File;
    const sourceHandle = {
      getFile: vi.fn().mockResolvedValue(file),
    } as unknown as FileSystemFileHandle;
    const { targetHandle, writable } = createTargetHandle();

    await copyFileSystemFileHandle({
      sourceHandle,
      targetHandle,
      signal: undefined,
    });

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(writable.write).toHaveBeenCalled();
    expect(writable.close).toHaveBeenCalledOnce();
  });

  it('aborts the target when writing fails', async () => {
    const error = new Error('disk full');
    const { targetHandle, writable } = createTargetHandle({
      write: vi.fn().mockRejectedValue(error),
    });
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1]));
      },
    });

    await expect(writeReadableStreamToFileHandle({
      source,
      targetHandle,
      signal: undefined,
    })).rejects.toBe(error);

    expect(writable.abort).toHaveBeenCalledWith(error);
  });
  it('cancels an already-aborted input and releases its lock without opening a target', async () => {
    const lifetime = new AbortController();
    const reason = new DOMException('Cancelled before start', 'AbortError');
    lifetime.abort(reason);
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel });
    const { targetHandle } = createTargetHandle();
    await expect(writeReadableStreamToFileHandle({ source, targetHandle, signal: lifetime.signal })).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledWith(reason);
    expect(source.locked).toBe(false);
    expect(targetHandle.createWritable).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('cancels a pending read before its late %s and does not commit cancelled EOF', async outcome => {
    const lifetime = new AbortController();
    const reason = new DOMException('Cancelled pending read', 'AbortError');
    const late = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      async pull() {
        entered.resolve();
        await late.promise;
      },
      cancel,
    }, { highWaterMark: 0 });
    const { targetHandle, writable } = createTargetHandle();
    const operation = writeReadableStreamToFileHandle({ source, targetHandle, signal: lifetime.signal });
    const rejection = expect(operation).rejects.toBe(reason);
    await entered.promise;
    lifetime.abort(reason);
    await rejection;
    expect(cancel).toHaveBeenCalledWith(reason);
    expect(writable.write).not.toHaveBeenCalled();
    expect(writable.close).not.toHaveBeenCalled();
    expect(writable.abort).toHaveBeenCalledWith(reason);
    expect(source.locked).toBe(false);
    if (outcome === 'resolve') late.resolve();
    else late.reject(new Error('Late underlying read failure'));
  });

  it('aborts a writable acquired after cancellation instead of leaking or closing it', async () => {
    const lifetime = new AbortController();
    const reason = new DOMException('Cancelled while opening', 'AbortError');
    const { targetHandle, writable } = createTargetHandle();
    const acquired = Promise.withResolvers<FileSystemWritableFileStream>();
    vi.mocked(targetHandle.createWritable).mockReturnValue(acquired.promise);
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel });
    const operation = writeReadableStreamToFileHandle({ source, targetHandle, signal: lifetime.signal });
    const rejection = expect(operation).rejects.toBe(reason);
    lifetime.abort(reason);
    acquired.resolve(writable as unknown as FileSystemWritableFileStream);
    await rejection;
    expect(cancel).toHaveBeenCalledWith(reason);
    expect(writable.abort).toHaveBeenCalledWith(reason);
    expect(writable.write).not.toHaveBeenCalled();
    expect(writable.close).not.toHaveBeenCalled();
    expect(source.locked).toBe(false);
  });

  it('does not commit after the final pending write finishes in a cancelled operation', async () => {
    const lifetime = new AbortController();
    const entered = Promise.withResolvers<void>();
    const late = Promise.withResolvers<void>();
    const { targetHandle, writable } = createTargetHandle({ write: vi.fn(async () => {
      entered.resolve(); await late.promise;
    }) });
    const source = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array([255])); controller.close();
    } });
    const operation = writeReadableStreamToFileHandle({ source, targetHandle, signal: lifetime.signal });
    const rejection = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    lifetime.abort(new DOMException('Cancelled while writing', 'AbortError'));
    late.resolve();
    await rejection;
    expect(writable.close).not.toHaveBeenCalled();
    expect(writable.abort).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });

  it('keeps the initiating error when cancellation and writer cleanup also reject', async () => {
    const error = new Error('Write failed');
    const { targetHandle, writable } = createTargetHandle({ write: vi.fn().mockRejectedValue(error) });
    writable.abort.mockRejectedValue(new Error('Abort also failed'));
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        throw new Error('Source cancellation also failed');
      },
    });
    await expect(writeReadableStreamToFileHandle({ source, targetHandle, signal: undefined })).rejects.toBe(error);
    expect(writable.close).not.toHaveBeenCalled();
    expect(source.locked).toBe(false);
  });

});
