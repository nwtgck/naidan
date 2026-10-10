// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NaidanRpcByteBudget, TEST_ONLY } from './byte-budget';
import { ByteAssembly } from './assembly';
import { FramedDuplex } from './framing';
import { encodeProtocolHeader } from './protocol-header';
import { NaidanRpcPeer, contract, procedure, expose, rpc } from './index';
import { transportPair } from './test-transport';

it('accounts full backing stores, descendant ownership and idempotent releases', () => {
  const budget = new NaidanRpcByteBudget({ capacity: 4096 }), root = budget.owner(), child = root.fork();
  const backing = new Uint8Array(2048);
  child.retain({ bytes: backing.subarray(0, 1) }); child.retain({ bytes: backing.subarray(100, 101) });
  expect(TEST_ONLY.retained({ budget })).toBe(2048);
  const bytes = root.allocate({ bytes: 2048 });
  expect(() => child.allocate({ bytes: 1 })).toThrowError(expect.objectContaining({ code: 'RESOURCE_EXHAUSTED' }));
  root.release({ bytes }); root.release({ bytes });
  expect(TEST_ONLY.retained({ budget })).toBe(2048);
  root.clear(); child.clear(); root.clear();
  expect(TEST_ONLY.retained({ budget })).toBe(0);
  expect(() => child.allocate({ bytes: 1 })).toThrowError(expect.objectContaining({ code: 'CANCELLED' }));
});

it('reserves a grown buffer while the old allocation is still retained', () => {
  const budget = new NaidanRpcByteBudget({ capacity: 2500 }), owner = budget.owner();
  const assembly = new ByteAssembly({ limit: 4096, memory: owner });
  assembly.append({ bytes: new Uint8Array(1000).fill(23) });
  expect(TEST_ONLY.retained({ budget })).toBe(1024);
  expect(() => assembly.append({ bytes: new Uint8Array(100) })).toThrowError(expect.objectContaining({ code: 'RESOURCE_EXHAUSTED' }));
  expect(assembly.byteLength).toBe(1000);
  expect(assembly.finish().every(byte => byte === 23)).toBe(true);
  expect(TEST_ONLY.retained({ budget })).toBe(1024);
  assembly.dispose(); owner.clear(); expect(TEST_ONLY.retained({ budget })).toBe(0);
});

it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid byte reservations (%s)', bytes => {
  const budget = new NaidanRpcByteBudget({ capacity: 100 });
  expect(() => budget.reserve({ bytes })).toThrow();
  expect(TEST_ONLY.retained({ budget })).toBe(0);
});

it('does not refund a pending writer after logical stop until the write settles', async () => {
  const budget = new NaidanRpcByteBudget({ capacity: 100000 }), owner = budget.owner();
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  let writes = 0;
  const framed = new FramedDuplex({
    memory: owner,
    onProtocolFailure: () => {},
    duplex: {
      readable: new ReadableStream<Uint8Array>(),
      writable: new WritableStream<Uint8Array>({
        write() {
          if (++writes > 1) {
            started.resolve(); return finish.promise;
          } return undefined;
        },
      }),
      closed: Promise.resolve(),
      abort: () => {},
    },
  });
  await framed.preambleSent;
  const sent = framed.send({ frame: { type: 'result', value: new Uint8Array(4096) } }); void sent.catch(() => {});
  await started.promise;
  const before = TEST_ONLY.retained({ budget });
  expect(before).toBeGreaterThanOrEqual(4096);
  let done = false;
  const stopping = framed.stop({ error: new Error('cancel') }).then(() => {
    done = true;
  });
  await Promise.resolve(); expect(done).toBe(false);
  expect(TEST_ONLY.retained({ budget })).toBe(before);
  finish.resolve(); await stopping; await expect(sent).rejects.toBeDefined();
  expect(TEST_ONLY.retained({ budget })).toBe(0); owner.clear();
});

it('fails a second partial frame without waiting for the first frame to free capacity', async () => {
  const budget = new NaidanRpcByteBudget({ capacity: 8000 }), first = budget.owner(), second = budget.owner();
  const prefix = new Uint8Array(encodeProtocolHeader().length + 4 + 2048);
  prefix.set(encodeProtocolHeader()); new DataView(prefix.buffer).setUint32(13, 32768, false);
  const make = (memory: typeof first) => new FramedDuplex({
    memory,
    onProtocolFailure: () => {},
    duplex: {
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(prefix.slice());
        },
      }),
      writable: new WritableStream<Uint8Array>(),
      closed: Promise.resolve(),
      abort: () => {},
    },
  });
  const a = make(first), b = make(second);
  await Promise.all([a.preambleSent, b.preambleSent]);
  const reading = a.read(); void reading.catch(() => {});
  await vi.waitFor(() => expect(TEST_ONLY.retained({ budget })).toBeGreaterThan(4000));
  await expect(b.read()).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' });
  expect(TEST_ONLY.retained({ budget })).toBeLessThanOrEqual(8000);
  await Promise.all([a.stop({ error: new Error('done') }), b.stop({ error: new Error('done') })]);
  first.clear(); second.clear(); expect(TEST_ONLY.retained({ budget })).toBe(0);
});

it('rejects oversized caller input before opening a stream and refunds failed encoding', async () => {
  const budget = new NaidanRpcByteBudget({ capacity: 2048 }), wire = transportPair({ capacity: 2, fragmentBytes: 512 });
  const definition = contract({ name: 'bytes.admission', methods: { run: procedure({ input: z.instanceof(Uint8Array), result: z.number(), notifications: {} }) } });
  const signal = new AbortController().signal;
  const peer = new NaidanRpcPeer({ transport: wire.a, exports: [], byteBudget: budget, signal, limits: { maxCalls: 2, maxCallTimeoutMs: undefined } });
  try {
    const call = peer.client({ contract: definition }).run({ input: new Uint8Array(4096), on: {}, signal, timeoutMs: undefined });
    await expect(call.result).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' });
    await expect(call.closed).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' });
    expect(wire.stats().total).toBe(0);
    await peer.retire(); expect(TEST_ONLY.retained({ budget })).toBe(0);
  } finally {
    wire.close(); await peer.retire();
  }
});

it('keeps old native inputs charged after network retirement and refunds only full retirement', async () => {
  const budget = new NaidanRpcByteBudget({ capacity: 256 * 1024 }), wire = transportPair({ capacity: 2, fragmentBytes: 8192 });
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const signal = new AbortController().signal, limits = { maxCalls: 2, maxCallTimeoutMs: undefined };
  const definition = contract({ name: 'bytes.retirement', methods: { run: procedure({ input: z.instanceof(Uint8Array), result: z.number(), notifications: {} }) } });
  const caller = new NaidanRpcPeer({ transport: wire.a, exports: [], signal, limits });
  const callee = new NaidanRpcPeer({
    transport: wire.b,
    byteBudget: budget,
    signal,
    limits,
    exports: [expose({
      contract: definition,
      allowedMethods: ['run'],
      implementation: {
        run: async ({ input }) => {
          entered.resolve(); await finish.promise; return input[0]!;
        },
      },
    })],
  });
  try {
    const call = caller.client({ contract: definition }).run({ input: new Uint8Array(8192).fill(73), on: {}, signal, timeoutMs: undefined });
    await entered.promise; await callee.retireNetwork();
    const retained = TEST_ONLY.retained({ budget }); expect(retained).toBeGreaterThanOrEqual(8192);
    const next = budget.owner();
    expect(() => next.allocate({ bytes: 256 * 1024 - retained + 1 })).toThrowError(expect.objectContaining({ code: 'RESOURCE_EXHAUSTED' }));
    next.clear(); finish.resolve(); await callee.retire();
    expect(TEST_ONLY.retained({ budget })).toBe(0);
    await expect(call.result).rejects.toBeDefined(); await expect(call.closed).rejects.toBeDefined();
  } finally {
    finish.resolve(); wire.close(); await Promise.all([caller.retire(), callee.retire()]);
  }
});

it('retains bytes after failed late native cleanup instead of treating a retired network as success', async () => {
  const budget = new NaidanRpcByteBudget({ capacity: 256 * 1024 }), wire = transportPair({ capacity: 2, fragmentBytes: 8192 });
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const signal = new AbortController().signal, limits = { maxCalls: 2, maxCallTimeoutMs: undefined };
  const definition = contract({ name: 'bytes.cleanup', methods: { run: procedure({ input: z.instanceof(Uint8Array), result: rpc.byteStream(), notifications: {} }) } });
  const caller = new NaidanRpcPeer({ transport: wire.a, exports: [], signal, limits });
  const callee = new NaidanRpcPeer({
    transport: wire.b,
    byteBudget: budget,
    signal,
    limits,
    exports: [expose({
      contract: definition,
      allowedMethods: ['run'],
      implementation: {
        run: ({ input }) => new ReadableStream<Uint8Array>({
          pull() {
            void input; started.resolve();
          },
          async cancel() {
            await finish.promise; throw new Error('native cleanup failed');
          },
        }, { highWaterMark: 0 }),
      },
    })],
  });
  try {
    const call = caller.client({ contract: definition }).run({ input: new Uint8Array(8192), on: {}, signal, timeoutMs: undefined });
    const read = (await call.result).getReader().read(); void read.catch(() => {});
    await started.promise; await callee.retireNetwork();
    const retirement = callee.retire(), rejected = expect(retirement).rejects.toBeDefined();
    expect(TEST_ONLY.retained({ budget })).toBeGreaterThanOrEqual(8192);
    finish.resolve(); await rejected;
    expect(TEST_ONLY.retained({ budget })).toBeGreaterThanOrEqual(8192);
    await expect(call.closed).rejects.toBeDefined();
  } finally {
    finish.resolve(); wire.close(); await Promise.allSettled([caller.retire(), callee.retire()]);
  }
});

it('releases frame, stream item and copied-result reservations across repeated successful calls', async () => {
  const aBudget = new NaidanRpcByteBudget(), bBudget = new NaidanRpcByteBudget();
  const wire = transportPair({ capacity: 2, fragmentBytes: 8192 });
  const signal = new AbortController().signal, limits = { maxCalls: 2, maxCallTimeoutMs: undefined };
  const definition = contract({ name: 'bytes.reuse', methods: { run: procedure({ input: z.object({}), result: rpc.byteStream(), notifications: {} }) } });
  const caller = new NaidanRpcPeer({ transport: wire.a, byteBudget: aBudget, exports: [], signal, limits });
  const callee = new NaidanRpcPeer({
    transport: wire.b,
    byteBudget: bBudget,
    signal,
    limits,
    exports: [expose({
      contract: definition,
      allowedMethods: ['run'],
      implementation: {
        run: () => new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(16384).fill(37)); controller.close();
          },
        }, { highWaterMark: 0 }),
      },
    })],
  });
  try {
    for (let index = 0; index < 8; index++) {
      const call = caller.client({ contract: definition }).run({ input: {}, on: {}, signal, timeoutMs: undefined });
      const reader = (await call.result).getReader();
      let count = 0;
      for (;;) {
        const item = await reader.read(); if (item.done) break; count += item.value.length; expect(item.value.every(byte => byte === 37)).toBe(true);
      }
      reader.releaseLock(); expect(count).toBe(16384); await call.closed;
      await vi.waitFor(() => {
        expect(TEST_ONLY.retained({ budget: aBudget })).toBe(0); expect(TEST_ONLY.retained({ budget: bBudget })).toBe(0);
      });
    }
  } finally {
    wire.close(); await Promise.all([caller.retire(), callee.retire()]);
  }
});

it.each(['before', 'after'] as const)('retires returned sources %s an oversized field when packing cannot obtain memory', async order => {
  const budget = new NaidanRpcByteBudget({ capacity: 16384 }), wire = transportPair({ capacity: 2, fragmentBytes: 8192 });
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const cancel = vi.fn(() => {
    started.resolve(); return finish.promise;
  });
  const signal = new AbortController().signal, limits = { maxCalls: 2, maxCallTimeoutMs: undefined };
  const fields = order === 'before' ? { source: rpc.byteStream(), data: z.instanceof(Uint8Array) } : { data: z.instanceof(Uint8Array), source: rpc.byteStream() };
  const definition = contract({ name: 'bytes.failed-result', methods: { run: procedure({ input: z.object({}), result: z.object(fields), notifications: {} }) } });
  const caller = new NaidanRpcPeer({ transport: wire.a, exports: [], signal, limits });
  const callee = new NaidanRpcPeer({
    transport: wire.b,
    byteBudget: budget,
    signal,
    limits,
    exports: [expose({
      contract: definition,
      allowedMethods: ['run'],
      implementation: {
        run: () => ({ data: new Uint8Array(32768), source: new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 }) }),
      },
    })],
  });
  try {
    const call = caller.client({ contract: definition }).run({ input: {}, on: {}, signal, timeoutMs: undefined });
    await started.promise; expect(cancel).toHaveBeenCalledOnce();
    let complete = false; const retirement = callee.retire().then(() => {
      complete = true;
    });
    await Promise.resolve(); expect(complete).toBe(false);
    finish.resolve(); await retirement;
    await expect(call.result).rejects.toBeDefined(); await expect(call.closed).rejects.toBeDefined();
    expect(TEST_ONLY.retained({ budget })).toBe(0);
  } finally {
    finish.resolve(); wire.close(); await Promise.allSettled([caller.retire(), callee.retire()]);
  }
});

it('does not release an observer input until the observer actually returns', async () => {
  const budget = new NaidanRpcByteBudget({ capacity: 256 * 1024 }), wire = transportPair({ capacity: 2, fragmentBytes: 8192 });
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(), done = Promise.withResolvers<void>();
  const signal = new AbortController().signal, limits = { maxCalls: 2, maxCallTimeoutMs: undefined };
  const definition = contract({ name: 'bytes.observer', methods: { run: procedure({ input: z.object({}), result: z.number(), notifications: { progress: z.instanceof(Uint8Array) } }) } });
  const caller = new NaidanRpcPeer({ transport: wire.a, exports: [], byteBudget: budget, signal, limits });
  const callee = new NaidanRpcPeer({
    transport: wire.b,
    signal,
    limits,
    exports: [expose({
      contract: definition,
      allowedMethods: ['run'],
      implementation: {
        run: async ({ notify }) => {
          notify.progress({ value: new Uint8Array(8192).fill(71) }); await done.promise; return 1;
        },
      },
    })],
  });
  try {
    const call = caller.client({ contract: definition }).run({
      input: {},
      signal,
      timeoutMs: undefined,
      on: {
        progress: async ({ value }) => {
          entered.resolve(); await finish.promise; expect(value[0]).toBe(71);
        },
      },
    });
    await entered.promise; await caller.retireNetwork();
    expect(TEST_ONLY.retained({ budget })).toBeGreaterThanOrEqual(8192);
    let returned = false; const retirement = caller.retire().then(() => {
      returned = true;
    });
    await Promise.resolve(); expect(returned).toBe(false); finish.resolve(); await retirement;
    expect(TEST_ONLY.retained({ budget })).toBe(0);
    await expect(call.result).rejects.toBeDefined(); await expect(call.closed).rejects.toBeDefined();
  } finally {
    finish.resolve(); done.resolve(); wire.close(); await Promise.all([caller.retire(), callee.retire()]);
  }
});
