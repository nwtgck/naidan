import { methodNames } from '@/features/naidan-rpc/contract';
// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { contract, procedure, expose, rpc, NaidanRpcPeer, NaidanRpcPublicError } from '@/features/naidan-rpc';
import type { NaidanRpcExposure } from '@/features/naidan-rpc';
import { transportPair } from '@/features/naidan-rpc/test-transport';
import { promiseAllKeyed } from '@/utils/promise';
import { VALUE_BYTES } from './primitives';

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});
function peers({ aExports, bExports, capacity }: { aExports: NaidanRpcExposure[]; bExports: NaidanRpcExposure[]; capacity: number }) {
  const transport = transportPair({ capacity, fragmentBytes: 1021 }), stop = new AbortController();
  const a = new NaidanRpcPeer({ transport: transport.a, exports: aExports, limits: { maxCalls: capacity, maxCallTimeoutMs: 2000 }, signal: stop.signal });
  const b = new NaidanRpcPeer({ transport: transport.b, exports: bExports, limits: { maxCalls: capacity, maxCallTimeoutMs: 2000 }, signal: stop.signal });
  stops.push(() => {
    stop.abort(); transport.close();
  }); return { a, b, transport, stop };
}
async function collect<T>({ stream }: { stream: ReadableStream<T> }): Promise<T[]> {
  const result: T[] = [], reader = stream.getReader();
  for (;;) {
    const value = await reader.read(); if (value.done) return result; result.push(value.value);
  }
}
function source<T>({ items }: { items: T[] }): ReadableStream<T> {
  let index = 0;
  return new ReadableStream<T>({ pull(controller) {
    if (index === items.length) controller.close(); else controller.enqueue(items[index++]!);
  } }, { highWaterMark: 0 });
}
const arithmetic = contract({ name: 'example.math', methods: {
  sum: procedure({ input: z.object({ x: z.number(), y: z.number().optional() }), result: z.number(), notifications: {} }),
} });
const math = expose({ contract: arithmetic, allowedMethods: methodNames({ contract: arithmetic }), implementation: { sum: ({ input }) => input.x + (input.y ?? 0) } });

it('returns explicitly public error context while keeping ordinary exception text private', async () => {
  const details = { kind: 'test-failure', stage: 'computation', reason: 'failed' };
  const exports = expose({ contract: arithmetic, allowedMethods: ['sum'], implementation: { sum({ input }) {
    if (input.x === 0) throw new NaidanRpcPublicError({ code: 'HANDLER_FAILED', details });
    throw new Error('private-native-path-and-prompt');
  } } });
  const { a } = peers({ aExports: [], bExports: [exports], capacity: 2 });
  const publicCall = a.client({ contract: arithmetic }).sum({ input: { x: 0, y: undefined }, on: {}, signal: undefined, timeoutMs: 1500 });
  await expect(publicCall.result).rejects.toMatchObject({ code: 'HANDLER_FAILED', details });
  await expect(publicCall.closed).rejects.toMatchObject({ code: 'HANDLER_FAILED', details });
  const privateCall = a.client({ contract: arithmetic }).sum({ input: { x: 1, y: undefined }, on: {}, signal: undefined, timeoutMs: 1500 });
  await expect(privateCall.result).rejects.toMatchObject({ code: 'HANDLER_FAILED', message: 'HANDLER_FAILED' });
  await expect(privateCall.closed).rejects.toMatchObject({ code: 'HANDLER_FAILED', message: 'HANDLER_FAILED' });
});

it('preserves public context on a late stream failure and still completes retirement', async () => {
  const details = { stage: 'stream-delivery', reason: 'failed' };
  const definition = contract({ name: 'example.public-stream-error', methods: { run: procedure({ input: z.object({}), result: rpc.stream({ item: z.number() }), notifications: {} }) } });
  const exports = expose({ contract: definition, allowedMethods: ['run'], implementation: { run: () => new ReadableStream({ pull(controller) {
    controller.error(new NaidanRpcPublicError({ code: 'RESOURCE_EXHAUSTED', details }));
  } }, { highWaterMark: 0 }) } });
  const { a, transport } = peers({ aExports: [], bExports: [exports], capacity: 2 });
  const call = a.client({ contract: definition }).run({ input: {}, on: {}, signal: undefined, timeoutMs: 1500 });
  await expect((await call.result).getReader().read()).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED', details });
  await expect(call.closed).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED', details });
  expect(transport.stats().active).toBe(0);
});

it('transfers a valid typed item beyond the internal transfer piece size', async () => {
  const definition = contract({ name: 'example.item-limit', methods: { run: procedure({ input: z.object({}), result: rpc.stream({ item: z.string() }), notifications: {} }) } });
  const exports = expose({ contract: definition, allowedMethods: ['run'], implementation: { run: () => source({ items: ['x'.repeat(21848)] }) } });
  const { a } = peers({ aExports: [], bExports: [exports], capacity: 2 });
  const call = a.client({ contract: definition }).run({ input: {}, on: {}, signal: undefined, timeoutMs: 1500 });
  const reader = (await call.result).getReader();
  expect((await reader.read()).value).toBe('x'.repeat(21848));
  expect((await reader.read()).done).toBe(true);
  await call.closed;
});

it('transfers large finite input, reverse callback, notification and result without producer chunk tuning', async () => {
  const api = contract({ name: 'example.large-finite', methods: { run: procedure({ input: z.object({ text: z.string(), answer: rpc.callback({ input: z.string(), result: z.string() }) }), result: z.object({ text: z.string() }), notifications: { progress: z.object({ text: z.string() }) } }) } });
  const text = '🌲'.repeat(32768), notices: string[] = [];
  const { a } = peers({ aExports: [], bExports: [expose({ contract: api, allowedMethods: ['run'], implementation: { async run({ input, notify }) {
    notify.progress({ value: { text: input.text } });
    return { text: await input.answer(input.text) };
  } } })], capacity: 2 });
  const call = a.client({ contract: api }).run({ input: { text, answer: value => value }, on: { progress: ({ value }) => {
    notices.push(value.text);
  } }, signal: undefined, timeoutMs: undefined });
  expect(await call.result).toEqual({ text }); await call.closed; expect(notices).toEqual([text]);
});

it('two peers call concurrently and return finite values with optional field normalization', async () => {
  const { a, b, transport } = peers({ aExports: [math], bExports: [math], capacity: 8 });
  const calls = [a, b, a, b].map((peer, index) => peer.client({ contract: arithmetic }).sum({ input: { x: index, y: undefined }, on: {}, signal: undefined, timeoutMs: 1500 }));
  expect(await Promise.all(calls.map(call => call.result))).toEqual([0, 1, 2, 3]);
  await Promise.all(calls.map(call => call.closed)); expect(transport.stats()).toEqual({ active: 0, total: 4 });
});

it('unknown method fails explicitly without executing another method', async () => {
  const { a } = peers({ aExports: [], bExports: [math], capacity: 2 });
  const newer = contract({ name: 'example.math', methods: { sumv2: arithmetic.methods.sum } });
  const call = a.client({ contract: newer }).sumv2({ input: { x: 1, y: 2 }, on: {}, signal: undefined, timeoutMs: 500 });
  await expect(call.result).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
  await expect(call.closed).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
});

it('returned nested streams can be consumed before the root invocation finishes', async () => {
  const definition = contract({ name: 'example.streams', methods: {
    convert: procedure({ input: z.object({ values: rpc.stream({ item: z.number() }) }),
      result: z.object({ nested: z.object({ numbers: rpc.stream({ item: z.number() }), text: rpc.stream({ item: z.string() }) }) }), notifications: {} }),
  } });
  const implementation = expose({ contract: definition, allowedMethods: methodNames({ contract: definition }), implementation: { convert: ({ input, signal }) => ({ nested: {
    numbers: input.values.pipeThrough(new TransformStream<number, number>({ transform(value, controller) {
      signal.throwIfAborted(); controller.enqueue(value * 2);
    } }), { signal }),
    text: source({ items: ['a', 'b'] }),
  } }) } });
  const { a, transport } = peers({ aExports: [], bExports: [implementation], capacity: 2 });
  const call = a.client({ contract: definition }).convert({ input: { values: source({ items: [1, 2, 3] }) }, on: {}, signal: undefined, timeoutMs: 1500 });
  const result = await call.result;
  const values = await promiseAllKeyed({ numbers: collect({ stream: result.nested.numbers }), text: collect({ stream: result.nested.text }) });
  expect(values).toEqual({ numbers: [2, 4, 6], text: ['a', 'b'] });
  await call.closed; expect(transport.stats().active).toBe(0);
});

it('reverse callbacks return values concurrently without acquiring another lower stream', async () => {
  const definition = contract({ name: 'example.callback', methods: {
    calculate: procedure({ input: z.object({ transform: rpc.callback({ input: z.object({ value: z.number() }), result: z.number() }) }),
      result: z.array(z.number()), notifications: {} }),
  } });
  const implementation = expose({ contract: definition, allowedMethods: methodNames({ contract: definition }), implementation: {
    calculate: async ({ input }) => Promise.all([1, 2, 3].map(value => input.transform({ value }))),
  } });
  const { a, transport } = peers({ aExports: [], bExports: [implementation], capacity: 1 });
  const call = a.client({ contract: definition }).calculate({ input: { transform: async ({ value }) => {
    await new Promise(resolve => setTimeout(resolve, (4 - value) * 2)); return value * 10;
  } }, on: {}, signal: undefined, timeoutMs: 1500 });
  expect(await call.result).toEqual([10, 20, 30]); await call.closed;
  expect(transport.stats()).toEqual({ active: 0, total: 1 });
});

it('old implementations decline unknown streams without reading their sources', async () => {
  const legacy = contract({ name: 'example.compat', methods: { run: procedure({ input: z.object({ value: z.number() }), result: z.number(), notifications: {} }) } });
  const newer = contract({ name: 'example.compat', methods: { run: procedure({ input: z.object({ value: z.number(), extra: rpc.byteStream() }), result: z.number(), notifications: {} }) } });
  let pulls = 0, cancels = 0;
  const upload = new ReadableStream<Uint8Array>({ pull() {
    pulls++;
  }, cancel() {
    cancels++;
  } }, { highWaterMark: 0 });
  const { a } = peers({ aExports: [], bExports: [expose({ contract: legacy, allowedMethods: methodNames({ contract: legacy }), implementation: { run: ({ input }) => input.value } })], capacity: 2 });
  const call = a.client({ contract: newer }).run({ input: { value: 7, extra: upload }, on: {}, signal: undefined, timeoutMs: 1500 });
  expect(await call.result).toBe(7); await call.closed;
  expect(pulls).toBe(0); expect(cancels).toBe(1);
});

it('one result stream cancellation does not cancel its independent sibling', async () => {
  const definition = contract({ name: 'example.cancel', methods: { run: procedure({ input: z.object({}),
    result: z.object({ discard: rpc.stream({ item: z.number() }), keep: rpc.stream({ item: z.number() }) }), notifications: {} }) } });
  let cancelled = 0;
  const { a } = peers({ aExports: [], bExports: [expose({ contract: definition, allowedMethods: methodNames({ contract: definition }), implementation: { run: () => ({
    discard: new ReadableStream<number>({ pull() {}, cancel() {
      cancelled++;
    } }, { highWaterMark: 0 }), keep: source({ items: [3, 7] }),
  }) } })], capacity: 2 });
  const call = a.client({ contract: definition }).run({ input: {}, on: {}, signal: undefined, timeoutMs: 1500 });
  const result = await call.result;
  await result.discard.cancel(); expect(await collect({ stream: result.keep })).toEqual([3, 7]);
  await call.closed; expect(cancelled).toBe(1);
});

it('raw byte streams transfer large source chunks through bounded item frames', async () => {
  const definition = contract({ name: 'example.bytes', methods: { echo: procedure({ input: z.object({ data: rpc.byteStream() }), result: rpc.byteStream(), notifications: {} }) } });
  const { a, transport } = peers({ aExports: [], bExports: [expose({ contract: definition, allowedMethods: methodNames({ contract: definition }), implementation: { echo: ({ input }) => input.data } })], capacity: 1 });
  const input = new Uint8Array(199999); for (let index = 0; index < input.length; index++) input[index] = index % 251;
  const call = a.client({ contract: definition }).echo({ input: { data: source({ items: [input] }) }, on: {}, signal: undefined, timeoutMs: 1500 });
  const values = await collect({ stream: await call.result });
  expect(Buffer.concat(values)).toEqual(Buffer.from(input)); expect(values.every(value => value.length <= 16384)).toBe(true);
  await call.closed; expect(transport.stats().total).toBe(1);
});

it('input scalar metadata is snapshotted before awaiting a lower stream', async () => {
  const { a } = peers({ aExports: [], bExports: [math], capacity: 2 });
  const input = { x: 3, y: 4 };
  const call = a.client({ contract: arithmetic }).sum({ input, on: {}, signal: undefined, timeoutMs: 1000 });
  input.x = 99; expect(await call.result).toBe(7); await call.closed;
});

it('a declared callback error is an invocation error that application code can catch', async () => {
  const definition = contract({ name: 'example.cb-error', methods: { run: procedure({ input: z.object({ action: rpc.callback({ input: z.object({}), result: z.string() }) }), result: z.string(), notifications: {} }) } });
  const { a } = peers({ aExports: [], bExports: [expose({ contract: definition, allowedMethods: methodNames({ contract: definition }), implementation: { run: async ({ input }) => {
    try {
      return await input.action({});
    } catch {
      return 'recovered';
    }
  } } })], capacity: 1 });
  const call = a.client({ contract: definition }).run({ input: { action: () => {
    throw new Error('Private local failure');
  } }, on: {}, signal: undefined, timeoutMs: 1000 });
  expect(await call.result).toBe('recovered'); await call.closed;
});

it('a callback remains valid while a returned lazy stream still uses it', async () => {
  const definition = contract({ name: 'example.lazy-callback', methods: { run: procedure({ input: z.object({ transform: rpc.callback({ input: z.object({ value: z.number() }), result: z.number() }) }), result: rpc.stream({ item: z.number() }), notifications: {} }) } });
  const { a } = peers({ aExports: [], bExports: [expose({ contract: definition, allowedMethods: methodNames({ contract: definition }), implementation: { run: ({ input }) => {
    let at = 0;
    return new ReadableStream<number>({ async pull(controller) {
      if (at === 3) controller.close(); else controller.enqueue(await input.transform({ value: ++at }));
    } }, { highWaterMark: 0 });
  } } })], capacity: 1 });
  const call = a.client({ contract: definition }).run({ input: { transform: ({ value }) => value * 4 }, on: {}, signal: undefined, timeoutMs: 1000 });
  expect(await collect({ stream: await call.result })).toEqual([4, 8, 12]); await call.closed;
});

it('a call timeout fails pending streams without cancelling another parallel call', async () => {
  const definition = contract({ name: 'example.deadline', methods: { stream: procedure({ input: z.object({}), result: rpc.stream({ item: z.number() }), notifications: {} }) } });
  const { a } = peers({ aExports: [], bExports: [math, expose({ contract: definition, allowedMethods: methodNames({ contract: definition }), implementation: { stream: () => new ReadableStream<number>({ pull() {} }, { highWaterMark: 0 }) } })], capacity: 3 });
  const call = a.client({ contract: definition }).stream({ input: {}, on: {}, signal: undefined, timeoutMs: 100 });
  const result = await call.result, reading = result.getReader().read();
  await expect(reading).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
  await expect(call.closed).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
  const other = a.client({ contract: arithmetic }).sum({ input: { x: 5, y: 7 }, on: {}, signal: undefined, timeoutMs: 1000 });
  expect(await other.result).toBe(12); await other.closed;
});

it('new result fields containing streams are declined by old callers without source reads', async () => {
  const old = contract({ name: 'example.output-compat', methods: { run: procedure({ input: z.object({}), result: z.object({ value: z.number() }), notifications: {} }) } });
  const modern = contract({ name: 'example.output-compat', methods: { run: procedure({ input: z.object({}), result: z.object({ value: z.number(), extra: rpc.byteStream() }), notifications: {} }) } });
  let pulls = 0, cancellations = 0;
  const { a } = peers({ aExports: [], bExports: [expose({ contract: modern, allowedMethods: methodNames({ contract: modern }), implementation: { run: () => ({ value: 9,
    extra: new ReadableStream<Uint8Array>({ pull() {
      pulls++;
    }, cancel() {
      cancellations++;
    } }, { highWaterMark: 0 }),
  }) } })], capacity: 2 });
  const call = a.client({ contract: old }).run({ input: {}, on: {}, signal: undefined, timeoutMs: 1000 });
  expect(await call.result).toEqual({ value: 9 }); await call.closed;
  expect(pulls).toBe(0); expect(cancellations).toBe(1);
});

it('unused input is stopped after finite result and input aliasing fails before opening a transport', async () => {
  const definition = contract({ name: 'example.input', methods: { run: procedure({ input: z.object({ a: rpc.byteStream(), b: rpc.byteStream() }), result: z.number(), notifications: {} }) } });
  const { a, transport } = peers({ aExports: [], bExports: [expose({ contract: definition, allowedMethods: methodNames({ contract: definition }), implementation: { run: () => 4 } })], capacity: 2 });
  let cancelled = 0;
  const stream = () => new ReadableStream<Uint8Array>({ cancel() {
    cancelled++;
  } }, { highWaterMark: 0 });
  const same = stream();
  const invalid = a.client({ contract: definition }).run({ input: { a: same, b: same }, on: {}, signal: undefined, timeoutMs: 1000 });
  await expect(invalid.result).rejects.toBeDefined(); await expect(invalid.closed).rejects.toBeDefined();
  expect(transport.stats().total).toBe(0);
  const valid = a.client({ contract: definition }).run({ input: { a: stream(), b: stream() }, on: {}, signal: undefined, timeoutMs: 1000 });
  expect(await valid.result).toBe(4); await valid.closed; expect(cancelled).toBe(2);
});

it('an uncooperative handler keeps its admission reservation after cancellation', async () => {
  const definition = contract({ name: 'example.capacity', methods: { run: procedure({ input: z.object({}), result: z.number(), notifications: {} }) } });
  let invoked = 0, release: (() => void) | undefined;
  const started = Promise.withResolvers<void>();
  const { a } = peers({ aExports: [], bExports: [expose({ contract: definition, allowedMethods: methodNames({ contract: definition }), implementation: { run: async () => {
    invoked++; started.resolve(); await new Promise<void>(resolve => {
      release = resolve;
    }); return 1;
  } } })], capacity: 1 });
  const first = a.client({ contract: definition }).run({ input: {}, on: {}, signal: undefined, timeoutMs: 1000 });
  await started.promise; first.cancel({ reason: 'Caller cancelled' }); await expect(first.closed).rejects.toBeDefined();
  await new Promise(resolve => setTimeout(resolve, 5));
  const next = a.client({ contract: definition }).run({ input: {}, on: {}, signal: undefined, timeoutMs: 200 });
  await expect(next.closed).rejects.toBeDefined(); expect(invoked).toBe(1); release?.();
});

it('notifications are latest-value signals and slow observers do not block response parsing', async () => {
  const definition = contract({ name: 'example.progress', methods: { run: procedure({ input: z.object({}), result: z.number(), notifications: { progress: z.number() } }) } });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); const seen: number[] = [];
  const { a } = peers({ aExports: [], bExports: [expose({ contract: definition, allowedMethods: methodNames({ contract: definition }), implementation: { run: async ({ notify }) => {
    notify.progress({ value: 1 }); await entered.promise;
    for (let value = 2; value <= 100; value++) notify.progress({ value });
    return 42;
  } } })], capacity: 2 });
  const call = a.client({ contract: definition }).run({ input: {}, on: { progress: async ({ value }) => {
    seen.push(value); entered.resolve(); await release.promise;
  } }, signal: undefined, timeoutMs: 1000 });
  expect(await call.result).toBe(42); await call.closed; expect(seen).toEqual([1]); release.resolve();
});

it('byte streams skip empty chunks while retaining correct content and termination', async () => {
  const definition = contract({ name: 'example.empty-bytes', methods: { run: procedure({ input: z.object({}), result: rpc.byteStream(), notifications: {} }) } });
  const { a } = peers({ aExports: [], bExports: [expose({ contract: definition, allowedMethods: methodNames({ contract: definition }), implementation: { run: () => source({ items: [new Uint8Array(), new Uint8Array([5, 7]), new Uint8Array()] }) } })], capacity: 1 });
  const call = a.client({ contract: definition }).run({ input: {}, on: {}, signal: undefined, timeoutMs: 1000 });
  expect(Buffer.concat(await collect({ stream: await call.result }))).toEqual(Buffer.from([5, 7])); await call.closed;
});

it('oversized finite metadata fails without opening a lower stream or starting a handler', async () => {
  const definition = contract({ name: 'example.metadata', methods: { run: procedure({ input: z.string(), result: z.number(), notifications: {} }) } });
  let called = 0;
  const { a, transport } = peers({ aExports: [], bExports: [expose({ contract: definition, allowedMethods: methodNames({ contract: definition }), implementation: { run: () => {
    called++; return 1;
  } } })], capacity: 1 });
  const call = a.client({ contract: definition }).run({ input: 'x'.repeat(VALUE_BYTES + 1), on: {}, signal: undefined, timeoutMs: 500 });
  await expect(call.result).rejects.toBeDefined(); await expect(call.closed).rejects.toBeDefined();
  expect(called).toBe(0); expect(transport.stats()).toEqual({ active: 0, total: 0 });
});
it('pausing admission preserves an admitted invocation but denies new calls until reopened', async () => {
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<number>();
  const definition = contract({ name: 'test.pause', methods: { run: procedure({ input: z.object({}), result: z.number(), notifications: {} }) } });
  const implementation = expose({ contract: definition, allowedMethods: ['run'], implementation: { run: () => {
    started.resolve(); return finish.promise;
  } } });
  const { a, b } = peers({ aExports: [], bExports: [implementation], capacity: 4 });
  const active = a.client({ contract: definition }).run({ input: {}, on: {}, signal: undefined, timeoutMs: 1500 });
  await started.promise; b.setIncomingAdmission({ status: 'suspended' });
  const denied = a.client({ contract: definition }).run({ input: {}, on: {}, signal: undefined, timeoutMs: 1500 });
  await expect(denied.result).rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED' }); await expect(denied.closed).rejects.toBeDefined();
  finish.resolve(42); expect(await active.result).toBe(42); await active.closed;
  b.setIncomingAdmission({ status: 'open' });
  const resumed = a.client({ contract: definition }).run({ input: {}, on: {}, signal: undefined, timeoutMs: 1500 });
  expect(await resumed.result).toBe(42); await resumed.closed;
});

it('a suspended admission exception does not grant revoked methods or survive disposal', async () => {
  let invocations = 0;
  const definition = contract({ name: 'test.discovery', methods: {
    status: procedure({ input: z.object({}), result: z.number(), notifications: {} }),
    infer: procedure({ input: z.object({}), result: z.number(), notifications: {} }),
  } });
  const { a, b } = peers({ aExports: [], bExports: [expose({ contract: definition, allowedMethods: ['status', 'infer'], implementation: {
    status: () => 42, infer: () => {
      invocations++; return 7;
    },
  } })], capacity: 4 });
  b.allowIncomingWhileSuspended({ contract: definition, allowedMethods: ['status'] });
  b.setIncomingAdmission({ status: 'suspended' });
  const client = a.client({ contract: definition });
  const status = client.status({ input: {}, on: {}, signal: undefined, timeoutMs: 1000 });
  expect(await status.result).toBe(42); await status.closed;
  const infer = client.infer({ input: {}, on: {}, signal: undefined, timeoutMs: 1000 });
  await expect(infer.result).rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED' }); await expect(infer.closed).rejects.toBeDefined();
  expect(invocations).toBe(0);
  b.setAllowedMethods({ contract: definition, allowedMethods: ['infer'] });
  const revoked = client.status({ input: {}, on: {}, signal: undefined, timeoutMs: 1000 });
  await expect(revoked.result).rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED' }); await expect(revoked.closed).rejects.toBeDefined();
  expect(() => b.allowIncomingWhileSuspended({ contract: contract({ ...definition }), allowedMethods: ['status'] })).toThrow();
  b.dispose(); expect(() => b.allowIncomingWhileSuspended({ contract: definition, allowedMethods: ['status'] })).toThrow();
});
