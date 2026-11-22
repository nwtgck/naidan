import { assert, describe, expect, it } from 'vitest';
import { createReadHandleFromStream } from './stream';

describe('Wesh stream input references', () => {
  it('delivers queued bytes to a read submitted before the descriptor closed', async () => {
    const root = createReadHandleFromStream({
      source: new ReadableStream({
        start(controller) {
          controller.enqueue(Uint8Array.of(65, 66));
          controller.close();
        },
      }),
    });
    const cloned = root.cloneReference?.();
    assert(cloned !== undefined);
    await using _close = {
      async [Symbol.asyncDispose]() {
        await cloned.close();
        await root.close();
      },
    };
    const first = new Uint8Array(1);
    const second = new Uint8Array(1);

    const queuedRead = cloned.read({ buffer: first });
    await cloned.close();

    await expect(queuedRead).resolves.toEqual({ bytesRead: 1 });
    await expect(root.read({ buffer: second })).resolves.toEqual({ bytesRead: 1 });
    expect(first).toEqual(Uint8Array.of(65));
    expect(second).toEqual(Uint8Array.of(66));
  });

  it('lets another descriptor read a chunk that arrives after the waiting descriptor closed', async () => {
    const controller = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const root = createReadHandleFromStream({
      source: new ReadableStream({ start: controller.resolve }),
    });
    const cloned = root.cloneReference?.();
    assert(cloned !== undefined);
    await using _close = {
      async [Symbol.asyncDispose]() {
        await cloned.close();
        await root.close();
      },
    };
    const abandoned = new Uint8Array(1);
    const remaining = new Uint8Array(2);
    const reader = cloned.read({ buffer: abandoned });
    await cloned.close();
    await expect(reader).resolves.toEqual({ bytesRead: 0 });

    const stream = await controller.promise;
    const survivingRead = root.read({ buffer: remaining });
    stream.enqueue(Uint8Array.of(65, 66));
    stream.close();

    await expect(survivingRead).resolves.toEqual({ bytesRead: 2 });
    expect(abandoned).toEqual(Uint8Array.of(0));
    expect(remaining).toEqual(Uint8Array.of(65, 66));
    await expect(root.read({ buffer: remaining })).resolves.toEqual({ bytesRead: 0 });
  });

  it('preserves an accepted read when the last descriptor closes', async () => {
    const root = createReadHandleFromStream({
      source: new ReadableStream({
        start(controller) {
          controller.enqueue(Uint8Array.of(65, 66));
        },
      }),
    });
    const buffer = new Uint8Array(1);

    const queuedRead = root.read({ buffer });
    await root.close();

    await expect(queuedRead).resolves.toEqual({ bytesRead: 1 });
    expect(buffer).toEqual(Uint8Array.of(65));
    await expect(root.read({ buffer })).resolves.toEqual({ bytesRead: 0 });
  });

  it('keeps a shared stream failure observable after the original reader closes', async () => {
    const controller = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const root = createReadHandleFromStream({
      source: new ReadableStream({ start: controller.resolve }),
    });
    const cloned = root.cloneReference?.();
    assert(cloned !== undefined);
    await using _close = {
      async [Symbol.asyncDispose]() {
        await cloned.close();
        await root.close().catch(() => {});
      },
    };
    const buffer = new Uint8Array(1);
    const waiting = cloned.read({ buffer });
    await cloned.close();
    await expect(waiting).resolves.toEqual({ bytesRead: 0 });

    const stream = await controller.promise;
    const failure = new Error('input failed');
    stream.error(failure);
    await Promise.resolve();

    await expect(root.read({ buffer })).rejects.toBe(failure);
  });
});
