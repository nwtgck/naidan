import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { contract, expose, procedure } from './contract';
import { rpc } from './schema';
import { NaidanRpcPeer } from './peer';
import { transportPair } from './test-transport';

const definition = contract({
  name: 'test.late-result',
  methods: {
    run: procedure({ input: z.strictObject({}), result: z.strictObject({ image: rpc.byteStream(), events: rpc.stream({ item: z.number() }) }), notifications: {} }),
  },
});

it.each(['cancel', 'revoke'] as const)('owns unread result streams returned after %s until their cancellation settles', async mode => {
  const transport = transportPair({ capacity: 2, fragmentBytes: 113 });
  const ready = Promise.withResolvers<void>(), result = Promise.withResolvers<void>();
  const first = Promise.withResolvers<void>(), second = Promise.withResolvers<void>();
  const pull = vi.fn(), cancelImage = vi.fn(() => first.promise), cancelEvents = vi.fn(() => second.promise);
  const lifetime = new AbortController();
  const callee = new NaidanRpcPeer({
    transport: transport.b,
    exports: [expose({
      contract: definition,
      allowedMethods: ['run'],
      implementation: {
        async run() {
          ready.resolve(); await result.promise;
          return {
            image: new ReadableStream<Uint8Array>({ pull, cancel: cancelImage }, { highWaterMark: 0 }),
            events: new ReadableStream<number>({ pull, cancel: cancelEvents }, { highWaterMark: 0 }),
          };
        },
      },
    })],
    limits: { maxCalls: 2, maxCallTimeoutMs: undefined },
    signal: lifetime.signal,
  });
  const caller = new NaidanRpcPeer({ transport: transport.a, exports: [], limits: { maxCalls: 2, maxCallTimeoutMs: undefined }, signal: lifetime.signal });
  const call = caller.client({ contract: definition }).run({ input: {}, on: {}, signal: undefined, timeoutMs: undefined });
  void call.result.catch(() => {}); void call.closed.catch(() => {});
  try {
    await ready.promise;
    switch (mode) {
    case 'cancel': call.cancel({ reason: 'Stop before the handler returns' }); break;
    case 'revoke': callee.setAllowedMethods({ contract: definition, allowedMethods: [] }); break;
    default: { const exhaustive: never = mode; throw new Error(String(exhaustive)); }
    }
    await expect(call.result).rejects.toBeDefined();
    const retirement = callee.retire(); let retired = false;
    void retirement.then(() => {
      retired = true;
    });
    result.resolve();
    await vi.waitFor(() => {
      expect(cancelImage).toHaveBeenCalledOnce(); expect(cancelEvents).toHaveBeenCalledOnce();
    }, { timeout: 200 });
    expect(pull).not.toHaveBeenCalled(); expect(retired).toBe(false);
    first.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); expect(retired).toBe(false);
    second.resolve(); await retirement; expect(retired).toBe(true);
  } finally {
    result.resolve(); first.resolve(); second.resolve(); lifetime.abort(); transport.close();
    await Promise.all([caller.retire(), callee.retire()]);
  }
});

it('late source cancellation failure stays visible while other native cleanup is joined', async () => {
  const transport = transportPair({ capacity: 2, fragmentBytes: 113 });
  const ready = Promise.withResolvers<void>(), result = Promise.withResolvers<void>(), other = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<void>(), cleanupFailure = new Error('Late source cleanup failed');
  const lifetime = new AbortController();
  const callee = new NaidanRpcPeer({
    transport: transport.b,
    exports: [expose({
      contract: definition,
      allowedMethods: ['run'],
      implementation: {
        async run() {
          ready.resolve(); await result.promise;
          return {
            image: new ReadableStream<Uint8Array>({
              cancel() {
                failed.resolve(); throw cleanupFailure;
              },
            }, { highWaterMark: 0 }),
            events: new ReadableStream<number>({
              cancel() {
                return other.promise;
              },
            }, { highWaterMark: 0 }),
          };
        },
      },
    })],
    limits: { maxCalls: 2, maxCallTimeoutMs: undefined },
    signal: lifetime.signal,
  });
  const caller = new NaidanRpcPeer({ transport: transport.a, exports: [], limits: { maxCalls: 2, maxCallTimeoutMs: undefined }, signal: lifetime.signal });
  const call = caller.client({ contract: definition }).run({ input: {}, on: {}, signal: undefined, timeoutMs: undefined });
  void call.result.catch(() => {}); void call.closed.catch(() => {});
  try {
    await ready.promise; call.cancel({ reason: 'Stop while handler owns work' });
    await expect(call.result).rejects.toMatchObject({ code: 'CANCELLED' });
    result.resolve(); await failed.promise;
    expect((await callee.ended).error).toBe(cleanupFailure);
    let retired = false; const retirement = callee.retire();
    void retirement.then(() => {
      retired = true;
    }, () => {
      retired = true;
    });
    await Promise.resolve(); expect(retired).toBe(false);
    other.resolve(); await expect(retirement).rejects.toBe(cleanupFailure);
    await expect(call.closed).rejects.toMatchObject({ code: 'CANCELLED' });
  } finally {
    result.resolve(); other.resolve(); lifetime.abort(); transport.close();
    await Promise.allSettled([caller.retire(), callee.retire()]);
  }
});

it('a late handler rejection cannot impersonate an owned retirement failure', async () => {
  const { RpcRetirementError } = await import('./stream-retirement');
  const transport = transportPair({ capacity: 2, fragmentBytes: 113 });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const stop = new AbortController();
  const callee = new NaidanRpcPeer({
    transport: transport.b,
    exports: [expose({
      contract: definition,
      allowedMethods: ['run'],
      implementation: {
        async run() {
          entered.resolve(); await release.promise; throw new RpcRetirementError({ cause: new Error('Application-owned failure') });
        },
      },
    })],
    limits: { maxCalls: 2, maxCallTimeoutMs: undefined },
    signal: stop.signal,
  });
  const caller = new NaidanRpcPeer({ transport: transport.a, exports: [], limits: { maxCalls: 2, maxCallTimeoutMs: undefined }, signal: stop.signal });
  const call = caller.client({ contract: definition }).run({ input: {}, on: {}, signal: undefined, timeoutMs: undefined });
  void call.result.catch(() => {}); void call.closed.catch(() => {});
  try {
    await entered.promise; call.cancel({ reason: 'Stop' });
    await expect(call.result).rejects.toMatchObject({ code: 'CANCELLED' });
    const retirement = callee.retire(); release.resolve(); await expect(retirement).resolves.toBeUndefined();
  } finally {
    release.resolve(); stop.abort(); transport.close(); await Promise.allSettled([caller.retire(), callee.retire()]);
  }
});

it('a STOPPED write failure cannot impersonate source cleanup failure', async () => {
  const { FramedDuplex } = await import('./framing');
  const { RpcRetirementError } = await import('./stream-retirement');
  const original = FramedDuplex.prototype.send, failed = Promise.withResolvers<void>();
  const send = vi.spyOn(FramedDuplex.prototype, 'send').mockImplementation(function (this: InstanceType<typeof FramedDuplex>, { frame }) {
    if (frame.type === 'stopped') {
      failed.resolve(); return Promise.reject(new RpcRetirementError({ cause: new Error('Wire-owned error') }));
    }
    return original.call(this, { frame });
  });
  const transport = transportPair({ capacity: 2, fragmentBytes: 113 }), stop = new AbortController();
  const callee = new NaidanRpcPeer({
    transport: transport.b,
    exports: [expose({
      contract: definition,
      allowedMethods: ['run'],
      implementation: {
        async run() {
          return { image: new ReadableStream<Uint8Array>(), events: new ReadableStream<number>() };
        },
      },
    })],
    limits: { maxCalls: 2, maxCallTimeoutMs: undefined },
    signal: stop.signal,
  });
  const caller = new NaidanRpcPeer({ transport: transport.a, exports: [], limits: { maxCalls: 2, maxCallTimeoutMs: undefined }, signal: stop.signal });
  const call = caller.client({ contract: definition }).run({ input: {}, on: {}, signal: undefined, timeoutMs: undefined });
  void call.closed.catch(() => {});
  try {
    const value = await call.result;
    const cancelled = value.image.cancel(); void cancelled.catch(() => {});
    await failed.promise; await Promise.allSettled([cancelled]);
    await expect(callee.retire()).resolves.toBeUndefined();
  } finally {
    stop.abort(); transport.close(); await Promise.allSettled([caller.retire(), callee.retire()]); send.mockRestore();
  }
});
