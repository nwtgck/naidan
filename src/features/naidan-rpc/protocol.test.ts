// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { NaidanRpcPeer, contract, procedure, rpc } from '@/features/naidan-rpc';
import { FramedDuplex, frameSchema } from '@/features/naidan-rpc/framing';
import { Reference } from '@/features/naidan-rpc/codec';
import { transportPair } from '@/features/naidan-rpc/test-transport';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const definition = contract({ name: 'raw', methods: { get: procedure({ input: z.object({}), result: rpc.stream({ item: z.number() }), notifications: {} }) } });

it('bounds public failure details and rejects details on successful completion', () => {
  const frame = { type: 'finish', code: 'HANDLER_FAILED', details: { stage: 'sampling' } };
  expect(frameSchema.safeParse(frame).success).toBe(true);
  expect(frameSchema.safeParse({ ...frame, details: { stage: 'x'.repeat(513) } }).success).toBe(false);
  expect(frameSchema.safeParse({ ...frame, details: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`field${i}`, i])) }).success).toBe(false);
  expect(frameSchema.safeParse({ ...frame, details: { nested: { unbounded: 'value' } } }).success).toBe(false);
  expect(frameSchema.safeParse({ ...frame, code: undefined }).success).toBe(false);
});
async function opened() {
  const transport = transportPair({ capacity: 1, fragmentBytes: 3 }), controller = new AbortController();
  const peer = new NaidanRpcPeer({ transport: transport.a, exports: [], limits: { maxCalls: 1, maxCallTimeoutMs: 1000 }, signal: controller.signal });
  const iterator = transport.b.incomingStreams[Symbol.asyncIterator]();
  cleanups.push(() => {
    controller.abort(); transport.close();
  });
  const call = peer.client({ contract: definition }).get({ input: {}, on: {}, signal: undefined, timeoutMs: 1000 });
  const incoming = await iterator.next(); if (incoming.done) throw new Error('Missing duplex');
  const wire = new FramedDuplex({ duplex: incoming.value });
  expect(await wire.read()).toMatchObject({ type: 'open', version: 1 });
  await wire.send({ frame: { type: 'accept', scope: 'input', ids: [] } });
  return { call, wire, duplex: incoming.value };
}

it('data cannot be sent before a readable requests its single bounded item', async () => {
  const { call, wire } = await opened();
  await wire.send({ frame: { type: 'result', value: new Reference({ id: 2, mode: 'items' }) } });
  const stream = await call.result; expect((await wire.read())?.type).toBe('accept');
  await wire.send({ frame: { type: 'item', id: 2, sequence: 1, value: 5 } }).catch(() => {});
  await expect(call.closed).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  await expect(stream.getReader().read()).rejects.toBeDefined();
});

it('STOP permits at most its one already granted item, never unlimited discarded items', async () => {
  const { call, wire } = await opened();
  await wire.send({ frame: { type: 'result', value: new Reference({ id: 2, mode: 'items' }) } });
  const reader = (await call.result).getReader(); expect((await wire.read())?.type).toBe('accept');
  const reading = reader.read(); expect(await wire.read()).toEqual({ type: 'pull', id: 2, sequence: 1 });
  const cancelled = reader.cancel(); void cancelled.catch(() => {}); expect((await wire.read())?.type).toBe('stop');
  expect((await reading).done).toBe(true);
  await wire.send({ frame: { type: 'item', id: 2, sequence: 1, value: 8 } });
  await wire.send({ frame: { type: 'item', id: 2, sequence: 1, value: 9 } }).catch(() => {});
  await expect(call.closed).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
});

it('a received capability uses the remote direction and cannot alias two result fields', async () => {
  const { call, wire } = await opened();
  await wire.send({ frame: { type: 'result', value: new Reference({ id: 1, mode: 'items' }) } }).catch(() => {});
  await expect(call.result).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
});

it('a lower EOF without the call finish handshake is failure even after an early result', async () => {
  const { call, wire } = await opened();
  await wire.send({ frame: { type: 'result', value: new Reference({ id: 2, mode: 'items' }) } });
  await call.result; await wire.read();
  await wire.finish().catch(() => {});
  await expect(call.closed).rejects.toBeDefined();
});

it('a declared huge frame is rejected before the payload is read or allocated', async () => {
  const { call, duplex, wire } = await opened();
  wire.release();
  const writer = duplex.writable.getWriter();
  const header = new Uint8Array(4); new DataView(header.buffer).setUint32(0, 0xffffffff, false);
  await writer.write(header).catch(() => {});
  await expect(call.closed).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
});

it('repeating STOP while a producer cancellation waits cannot create unbounded cleanup work', async () => {
  const transport = transportPair({ capacity: 1, fragmentBytes: 101 }), controller = new AbortController();
  const peer = new NaidanRpcPeer({ transport: transport.a, exports: [], limits: { maxCalls: 1, maxCallTimeoutMs: 1000 }, signal: controller.signal });
  const waiting = Promise.withResolvers<void>(); let cancellations = 0;
  cleanups.push(() => {
    waiting.resolve(); controller.abort(); transport.close();
  });
  const definition = contract({ name: 'raw-stop', methods: { run: procedure({ input: rpc.byteStream(), result: z.number(), notifications: {} }) } });
  const call = peer.client({ contract: definition }).run({ input: new ReadableStream<Uint8Array>({ async cancel() {
    cancellations++; await waiting.promise;
  } }, { highWaterMark: 0 }),
  on: {}, signal: undefined, timeoutMs: 1000 });
  const incoming = await transport.b.incomingStreams[Symbol.asyncIterator]().next(); if (incoming.done) throw new Error('Missing stream');
  const wire = new FramedDuplex({ duplex: incoming.value }); await wire.read();
  await wire.send({ frame: { type: 'accept', scope: 'input', ids: [1] } });
  await wire.send({ frame: { type: 'stop', id: 1 } });
  await wire.send({ frame: { type: 'stop', id: 1 } }).catch(() => {});
  await expect(call.closed).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' }); expect(cancellations).toBe(1);
});
