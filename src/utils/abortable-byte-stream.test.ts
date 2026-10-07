// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createAbortableByteStream } from './abortable-byte-stream';

async function promptly<T>({ operation }: { operation: Promise<T> }): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Cancellation waited for producer cleanup')), 100);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

describe('abortable byte stream ownership', () => {
  it('releases a pending read and its source lock without waiting for the cancel hook', async () => {
    const cleanup = Promise.withResolvers<void>();
    const cancel = vi.fn(() => cleanup.promise);
    const source = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => undefined);
      },
      cancel,
    }, { highWaterMark: 0 });
    const stream = createAbortableByteStream({ stream: source, signal: new AbortController().signal, onCancel: undefined });
    const reader = stream.getReader();
    const pending = reader.read();
    const reason = new Error('Consumer no longer needs bytes');
    try {
      await promptly({ operation: reader.cancel(reason) });
      expect(await pending).toEqual({ value: undefined, done: true });
      expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
      expect(source.locked).toBe(false);
    } finally {
      cleanup.resolve(); reader.releaseLock();
    }
  });

  it('reports a destination error even when producer cleanup never finishes', async () => {
    const cleanup = Promise.withResolvers<void>();
    const cancel = vi.fn(() => cleanup.promise);
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel,
    }, { highWaterMark: 0 });
    const stream = createAbortableByteStream({ stream: source, signal: new AbortController().signal, onCancel: undefined });
    const failure = new Error('Disk full');
    try {
      await expect(promptly({
        operation: stream.pipeTo(new WritableStream({
          write() {
            throw failure;
          },
        })),
      })).rejects.toBe(failure);
      expect(source.locked).toBe(false);
      expect(cancel).toHaveBeenCalledExactlyOnceWith(failure);
    } finally {
      cleanup.resolve();
    }
  });

  it('does not replace a destination error with a rejecting cleanup hook', async () => {
    const cancel = vi.fn(async () => {
      throw new Error('Cleanup failed');
    });
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel,
    }, { highWaterMark: 0 });
    const stream = createAbortableByteStream({ stream: source, signal: new AbortController().signal, onCancel: undefined });
    const failure = new Error('Invalid output size');
    await expect(stream.pipeTo(new WritableStream({
      write() {
        throw failure;
      },
    }))).rejects.toBe(failure);
    expect(source.locked).toBe(false);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it('cleans up the source even when the cancellation notification throws', async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const failure = new Error('Cancellation notification failed');
    const stream = createAbortableByteStream({
      stream: source,
      signal: new AbortController().signal,
      onCancel: () => {
        throw failure;
      },
    });
    await expect(stream.cancel('stop')).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledExactlyOnceWith('stop');
    expect(source.locked).toBe(false);
  });

  it('releases the source lock on signal abort while its asynchronous cleanup is pending', async () => {
    const abort = new AbortController();
    const cleanup = Promise.withResolvers<void>();
    const cancel = vi.fn(() => cleanup.promise);
    const source = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const stream = createAbortableByteStream({ stream: source, signal: abort.signal, onCancel: undefined });
    const reader = stream.getReader();
    const read = reader.read();
    const reason = new Error('Stopped');
    try {
      abort.abort(reason);
      await expect(read).rejects.toBe(reason);
      expect(source.locked).toBe(false);
      expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
    } finally {
      cleanup.resolve(); reader.releaseLock();
    }
  });

  it('keeps EOF and cancellation of a completed stream distinct', async () => {
    const cancel = vi.fn();
    const notification = vi.fn();
    const abort = new AbortController();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
      cancel,
    });
    const stream = createAbortableByteStream({ stream: source, signal: abort.signal, onCancel: notification });
    expect(await new Response(stream).text()).toBe('');
    abort.abort();
    expect(source.locked).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(notification).not.toHaveBeenCalled();
  });
});
