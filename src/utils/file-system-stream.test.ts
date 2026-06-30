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
});
