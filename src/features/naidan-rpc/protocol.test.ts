// @vitest-environment node
import { encodeProtocolHeader } from './protocol-header';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NaidanRpcPeer, contract, expose, procedure, rpc } from '@/features/naidan-rpc';
import { FramedDuplex, frameSchema } from '@/features/naidan-rpc/framing';
import { encode, Reference } from '@/features/naidan-rpc/codec';
import { FRAME_BYTES, ITEM_FRAGMENT_BYTES, BYTE_PULL_BYTES, VALUE_BYTES } from './primitives';
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
  const transport = transportPair({ capacity: 1, fragmentBytes: 1031 }), controller = new AbortController();
  const peer = new NaidanRpcPeer({ transport: transport.a, exports: [], limits: { maxCalls: 1, maxCallTimeoutMs: 1000 }, signal: controller.signal });
  const iterator = transport.b.incomingStreams[Symbol.asyncIterator]();
  cleanups.push(() => {
    controller.abort(); transport.close();
  });
  const call = peer.client({ contract: definition }).get({ input: {}, on: {}, signal: undefined, timeoutMs: 1000 });
  const incoming = await iterator.next(); if (incoming.done) throw new Error('Missing duplex');
  const wire = new FramedDuplex({ onProtocolFailure: () => {}, duplex: incoming.value });
  expect(await wire.read()).toMatchObject({ type: 'open' });
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

it('retains only arrived payload bytes when six peers declare maximum-sized frames and stall', async () => {
  const allocations: number[] = [], Original = Uint8Array;
  const channels: FramedDuplex[] = [], pending: Promise<unknown>[] = [];
  vi.stubGlobal('Uint8Array', new Proxy(Original, {
    construct(constructor, args) {
      if (typeof args[0] === 'number') {
        allocations.push(args[0]);
        if (args[0] > 1024) throw new Error('Declared length allocated before body arrival');
      }
      return Reflect.construct(constructor, args);
    },
  }));
  try {
    for (let index = 0; index < 6; index++) {
      const header = new Original(4); new DataView(header.buffer).setUint32(0, FRAME_BYTES, false);
      const wire = new FramedDuplex({
        onProtocolFailure: () => {},
        duplex: {
          readable: new ReadableStream({
            start(controller) {
              controller.enqueue(encodeProtocolHeader());
              controller.enqueue(header); controller.enqueue(new Original([1]));
            },
          }),
          writable: new WritableStream(),
          closed: new Promise(() => {}),
          abort: () => {},
        },
      });
      channels.push(wire); pending.push(wire.read().catch(error => error));
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(Math.max(...allocations)).toBeLessThanOrEqual(1024);
    expect(allocations.reduce((sum, size) => sum + size, 0)).toBeLessThan(8192);
  } finally {
    for (const channel of channels) await channel.stop({ error: new Error('Finished') });
    await Promise.all(pending); vi.unstubAllGlobals();
  }
});

it('a stalled maximum-sized item declaration does not reserve its sibling stream budget', async () => {
  const api = contract({ name: 'raw-assembly', methods: { run: procedure({ input: z.object({}), result: z.object({ large: rpc.stream({ item: z.string() }), sibling: rpc.stream({ item: z.string() }) }), notifications: {} }) } });
  const transport = transportPair({ capacity: 1, fragmentBytes: 101 });
  const peer = new NaidanRpcPeer({ transport: transport.a, exports: [], limits: { maxCalls: 1, maxCallTimeoutMs: 2000 }, signal: new AbortController().signal });
  cleanups.push(() => {
    peer.dispose(); transport.close();
  });
  const call = peer.client({ contract: api }).run({ input: {}, on: {}, signal: undefined, timeoutMs: undefined });
  const incoming = await transport.b.incomingStreams[Symbol.asyncIterator]().next(); if (incoming.done) throw new Error('Missing stream');
  const wire = new FramedDuplex({ onProtocolFailure: () => {}, duplex: incoming.value }); await wire.read();
  await wire.send({ frame: { type: 'accept', scope: 'input', ids: [] } });
  await wire.send({ frame: { type: 'result', value: { large: new Reference({ id: 2, mode: 'items' }), sibling: new Reference({ id: 4, mode: 'items' }) } } });
  const result = await call.result; await wire.read();
  const large = result.large.getReader(), sibling = result.sibling.getReader();
  const waiting = large.read(), reading = sibling.read(); await wire.read(); await wire.read();
  await wire.send({ frame: { type: 'item-fragment', id: 2, sequence: 1, total: VALUE_BYTES, offset: 0, data: new Uint8Array([1]) } });
  const text = 's'.repeat(ITEM_FRAGMENT_BYTES * 2), body = encode({ value: text, limit: VALUE_BYTES });
  for (let offset = 0; offset < body.length; offset += ITEM_FRAGMENT_BYTES) {
    await wire.send({ frame: { type: 'item-fragment', id: 4, sequence: 1, total: body.length, offset, data: body.subarray(offset, offset + ITEM_FRAGMENT_BYTES) } });
  }
  expect((await reading).value).toBe(text);
  const cancellation = large.cancel(); expect((await waiting).done).toBe(true); await wire.read();
  await wire.send({ frame: { type: 'stopped', id: 2 } }); await cancellation;
  const ended = sibling.read(); await wire.read(); await wire.send({ frame: { type: 'end', id: 4, sequence: 2 } });
  expect((await ended).done).toBe(true);
  await wire.send({ frame: { type: 'finish', code: undefined, details: undefined } }); await wire.read(); await wire.finish();
  await call.closed; await peer.retire(); wire.release();
});

it('repeating STOP while a producer cancellation waits cannot create unbounded cleanup work', async () => {
  const transport = transportPair({ capacity: 1, fragmentBytes: 101 }), controller = new AbortController();
  const peer = new NaidanRpcPeer({ transport: transport.a, exports: [], limits: { maxCalls: 1, maxCallTimeoutMs: 1000 }, signal: controller.signal });
  const waiting = Promise.withResolvers<void>(); let cancellations = 0;
  cleanups.push(() => {
    waiting.resolve(); controller.abort(); transport.close();
  });
  const definition = contract({ name: 'raw-stop', methods: { run: procedure({ input: rpc.byteStream(), result: z.number(), notifications: {} }) } });
  const call = peer.client({ contract: definition }).run({
    input: new ReadableStream<Uint8Array>({
      async cancel() {
        cancellations++; await waiting.promise;
      },
    }, { highWaterMark: 0 }),
    on: {},
    signal: undefined,
    timeoutMs: 1000,
  });
  const incoming = await transport.b.incomingStreams[Symbol.asyncIterator]().next(); if (incoming.done) throw new Error('Missing stream');
  const wire = new FramedDuplex({ onProtocolFailure: () => {}, duplex: incoming.value }); await wire.read();
  await wire.send({ frame: { type: 'accept', scope: 'input', ids: [1] } });
  await wire.send({ frame: { type: 'stop', id: 1 } });
  await wire.send({ frame: { type: 'stop', id: 1 } }).catch(() => {});
  await expect(call.closed).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' }); expect(cancellations).toBe(1);
});

it.each(['wrong-type', 'reference'] as const)('retires an awaiting callback after a malformed returned %s', async mode => {
  const api = contract({ name: 'raw-callback', methods: { run: procedure({ input: rpc.callback({ input: z.number(), result: z.number() }), result: z.number(), notifications: {} }) } });
  const transport = transportPair({ capacity: 1, fragmentBytes: 101 });
  const completed = Promise.withResolvers<void>();
  const peer = new NaidanRpcPeer({
    transport: transport.a,
    exports: [expose({
      contract: api,
      allowedMethods: ['run'],
      implementation: {
        async run({ input }) {
          try {
            return await input(3);
          } finally {
            completed.resolve();
          }
        },
      },
    })],
    limits: { maxCalls: 1, maxCallTimeoutMs: undefined },
    signal: new AbortController().signal,
  });
  cleanups.push(() => {
    peer.dispose(); transport.close();
  });
  const duplex = await transport.b.openStream({ signal: new AbortController().signal });
  const wire = new FramedDuplex({ onProtocolFailure: () => {}, duplex });
  await wire.send({ frame: { type: 'open', contract: api.name, method: 'run', value: new Reference({ id: 1, mode: 'callback' }) } });
  expect(await wire.read()).toEqual({ type: 'accept', scope: 'input', ids: [1] });
  const invocation = await wire.read();
  if (invocation?.type !== 'invoke') throw new Error('Expected callback invocation');
  await wire.send({ frame: { type: 'returned', invocation: invocation.invocation, value: mode === 'wrong-type' ? 'invalid-number' : new Reference({ id: 3, mode: 'items' }) } }).catch(() => {});
  await completed.promise;
  await peer.retire();
  wire.release();
});

it('strips finite envelope extensions after inspecting their raw capability references', async () => {
  const read = async ({ value }: { value: unknown }) => {
    const payload = encode({ value, limit: FRAME_BYTES }), bytes = new Uint8Array(payload.length + 4);
    new DataView(bytes.buffer).setUint32(0, payload.length, false); bytes.set(payload, 4);
    const wire = new FramedDuplex({
      onProtocolFailure: () => {},
      duplex: {
        readable: new ReadableStream({
          start(controller) {
            controller.enqueue(encodeProtocolHeader());
            controller.enqueue(bytes); controller.close();
          },
        }),
        writable: new WritableStream(),
        closed: Promise.resolve(),
        abort: () => {},
      },
    });
    try {
      return await wire.read();
    } finally {
      wire.release();
    }
  };
  await expect(read({ value: { type: 'accept', scope: 'input', ids: [], extension: { future: true } } })).resolves.toEqual({ type: 'accept', scope: 'input', ids: [] });
  await expect(read({ value: { type: 'result', value: new Reference({ id: 2, mode: 'items' }), future: new Reference({ id: 4, mode: 'items' }) } })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  await expect(read({ value: { type: 'result', value: new Reference({ id: 2, mode: 'items' }), future: new Reference({ id: 2, mode: 'items' }) } })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  await expect(read({ value: { type: 'accept', ids: [], extension: true } })).rejects.toBeDefined();
});

it('permits a sibling item and STOP while a large typed item is only partly delivered', async () => {
  const api = contract({ name: 'raw-fragment', methods: { run: procedure({ input: z.object({}), result: z.object({ large: rpc.stream({ item: z.string() }), small: rpc.stream({ item: z.number() }) }), notifications: {} }) } });
  const transport = transportPair({ capacity: 1, fragmentBytes: 101 });
  const peer = new NaidanRpcPeer({ transport: transport.a, exports: [], limits: { maxCalls: 1, maxCallTimeoutMs: 2000 }, signal: new AbortController().signal });
  cleanups.push(() => {
    peer.dispose(); transport.close();
  });
  const call = peer.client({ contract: api }).run({ input: {}, on: {}, signal: undefined, timeoutMs: undefined });
  const incoming = await transport.b.incomingStreams[Symbol.asyncIterator]().next(); if (incoming.done) throw new Error('Missing stream');
  const wire = new FramedDuplex({ onProtocolFailure: () => {}, duplex: incoming.value }); await wire.read();
  await wire.send({ frame: { type: 'accept', scope: 'input', ids: [] } });
  await wire.send({ frame: { type: 'result', value: { large: new Reference({ id: 2, mode: 'items' }), small: new Reference({ id: 4, mode: 'items' }) } } });
  const result = await call.result; await wire.read();
  const large = result.large.getReader(), small = result.small.getReader();
  const pending = large.read(), reading = small.read(); await wire.read(); await wire.read();
  const body = encode({ value: 'x'.repeat(ITEM_FRAGMENT_BYTES * 4), limit: FRAME_BYTES });
  await wire.send({ frame: { type: 'item-fragment', id: 2, sequence: 1, total: body.length, offset: 0, data: body.subarray(0, ITEM_FRAGMENT_BYTES) } });
  await wire.send({ frame: { type: 'item', id: 4, sequence: 1, value: 7 } });
  expect((await reading).value).toBe(7);
  const cancellation = large.cancel(); expect((await pending).done).toBe(true); expect(await wire.read()).toEqual({ type: 'stop', id: 2 });
  // A single already granted logical item may finish or be abandoned, never
  // allocate new discarded payloads or consume a second pull's credit.
  await wire.send({ frame: { type: 'item-fragment', id: 2, sequence: 1, total: body.length, offset: ITEM_FRAGMENT_BYTES, data: body.subarray(ITEM_FRAGMENT_BYTES, ITEM_FRAGMENT_BYTES * 2) } });
  await wire.send({ frame: { type: 'stopped', id: 2 } }); await cancellation;
  const ended = small.read(); expect(await wire.read()).toEqual({ type: 'pull', id: 4, sequence: 2 });
  await wire.send({ frame: { type: 'end', id: 4, sequence: 2 } }); expect((await ended).done).toBe(true);
  await wire.send({ frame: { type: 'finish', code: undefined, details: undefined } }); expect(await wire.read()).toEqual({ type: 'ack' });
  await wire.finish(); await call.closed; await peer.retire(); wire.release();
});

it('rejects a byte source that exceeds its granted per-pull limit', async () => {
  const bytesContract = contract({ name: 'raw.bytes', methods: { get: procedure({ input: z.object({}), result: rpc.byteStream(), notifications: {} }) } });
  const transport = transportPair({ capacity: 1, fragmentBytes: 8191 }), controller = new AbortController();
  const peer = new NaidanRpcPeer({ transport: transport.a, exports: [], limits: { maxCalls: 1, maxCallTimeoutMs: undefined }, signal: controller.signal });
  cleanups.push(() => {
    controller.abort(); transport.close();
  });
  const incoming = transport.b.incomingStreams[Symbol.asyncIterator]().next();
  const call = peer.client({ contract: bytesContract }).get({ input: {}, on: {}, signal: controller.signal, timeoutMs: undefined });
  const next = await incoming; if (next.done) throw new Error('Expected a stream');
  const wire = new FramedDuplex({ duplex: next.value, onProtocolFailure: () => {} });
  await wire.read(); await wire.send({ frame: { type: 'accept', scope: 'input', ids: [] } });
  await wire.send({ frame: { type: 'result', value: new Reference({ id: 2, mode: 'bytes' }) } });
  const reader = (await call.result).getReader(); await wire.read();
  const reading = reader.read(); const rejectedRead = expect(reading).rejects.toBeDefined();
  const rejectedCall = expect(call.closed).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  expect(await wire.read()).toMatchObject({ type: 'pull' });
  await wire.send({ frame: { type: 'item', id: 2, sequence: 1, value: new Uint8Array(BYTE_PULL_BYTES + 1) } }).catch(() => {});
  await rejectedRead; await rejectedCall; reader.releaseLock();
  await wire.stop({ error: new Error('Test complete') }); await peer.retire();
});
