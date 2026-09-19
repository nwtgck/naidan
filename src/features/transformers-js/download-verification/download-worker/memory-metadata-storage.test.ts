// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createMemoryMetadataStorage } from './memory-metadata-storage';

it('starts empty and returns immutable complete metadata without an OPFS dependency', async () => {
  const memory = createMemoryMetadataStorage({ maximumByteLength: 8 });
  expect(await memory.storage.stat({ url: 'https://fixture/config.json' })).toBeUndefined();
  await memory.storage.write({ url: 'https://fixture/config.json', response: new Response('{}') });
  const read = await memory.storage.read({ url: 'https://fixture/config.json' });
  expect(read?.byteLength).toBe(2);
  expect(await read?.response.text()).toBe('{}');
  const snapshot = memory.snapshot();
  await memory.dispose();
  expect(await snapshot.get('https://fixture/config.json')?.text()).toBe('{}');
  await expect(memory.storage.stat({ url: 'https://fixture/config.json' })).rejects.toThrow('disposed');
});

it('does not replace a saved resource with a partial HTTP response', async () => {
  const memory = createMemoryMetadataStorage({ maximumByteLength: 8 });
  await memory.storage.write({ url: 'fixture', response: new Response('{}') });
  const cancel = vi.fn();
  await expect(memory.storage.write({ url: 'fixture', response: new Response(new ReadableStream({ cancel }), {
    status: 206, headers: { 'Content-Range': 'bytes 0-0/100' },
  }) })).rejects.toThrow('206');
  expect(cancel).toHaveBeenCalledOnce();
  expect(await memory.snapshot().get('fixture')?.text()).toBe('{}');
  await memory.dispose();
});

it('bounds combined saved metadata rather than granting the entire budget to each file', async () => {
  const memory = createMemoryMetadataStorage({ maximumByteLength: 3 });
  await memory.storage.write({ url: 'first', response: new Response('{}') });
  await expect(memory.storage.write({ url: 'second', response: new Response('{}') })).rejects.toThrow('budget');
  expect(memory.snapshot().size).toBe(1);
  await memory.storage.write({ url: 'third', response: new Response('1') });
  expect(memory.snapshot().size).toBe(2);
  await memory.dispose();
});

it('does not publish a short full-status response as complete metadata', async () => {
  const memory = createMemoryMetadataStorage({ maximumByteLength: 8 });
  await expect(memory.storage.write({ url: 'short', response: new Response('{}', {
    headers: { 'Content-Length': '3' },
  }) })).rejects.toThrow('byte length mismatch');
  expect(memory.snapshot().size).toBe(0);
  await memory.dispose();
});

it('does not publish a write that finishes after storage disposal', async () => {
  const memory = createMemoryMetadataStorage({ maximumByteLength: 8 });
  const entered = Promise.withResolvers<void>();
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({
    pull() {
      entered.resolve();
    }, cancel,
  }, { highWaterMark: 0 }));
  const result = memory.storage.write({ url: 'late', response }).then(() => 'saved', (error: unknown) => error);
  await entered.promise;
  await memory.dispose();
  expect(await result).toMatchObject({ message: 'Metadata memory storage is disposed' });
  expect(cancel).toHaveBeenCalledOnce();
  expect(() => memory.snapshot()).toThrow('disposed');
});

it('reserves memory for a pending writer before admitting a concurrent writer', async () => {
  const memory = createMemoryMetadataStorage({ maximumByteLength: 3 });
  const waiting = Promise.withResolvers<void>();
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  const first = memory.storage.write({ url: 'first', response: new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
      controller.enqueue(Uint8Array.of(1, 2));
    },
    pull() {
      waiting.resolve();
    },
  }, { highWaterMark: 0 })) });
  await waiting.promise;
  try {
    expect(await memory.storage.stat({ url: 'first' })).toBeUndefined();
    await expect(memory.storage.write({ url: 'second', response: new Response('{}') })).rejects.toThrow('budget');
  } finally {
    source!.close();
    await first;
  }
  expect(await memory.storage.stat({ url: 'first' })).toBe(2);
  expect(await memory.storage.stat({ url: 'second' })).toBeUndefined();
  await memory.dispose();
});
