import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { contract, expose, procedure } from './contract';
import { rpc } from './schema';
import { NaidanRpcPeer } from './peer';
import { transportPair } from './test-transport';

const definition = contract({ name: 'test.late-result', methods: {
  run: procedure({ input: z.strictObject({}), result: z.strictObject({ image: rpc.byteStream(), events: rpc.stream({ item: z.number() }) }), notifications: {} }),
} });

it.each(['cancel', 'revoke'] as const)('owns unread result streams returned after %s until their cancellation settles', async mode => {
  const transport = transportPair({ capacity: 2, fragmentBytes: 113 });
  const ready = Promise.withResolvers<void>(), result = Promise.withResolvers<void>();
  const first = Promise.withResolvers<void>(), second = Promise.withResolvers<void>();
  const pull = vi.fn(), cancelImage = vi.fn(() => first.promise), cancelEvents = vi.fn(() => second.promise);
  const lifetime = new AbortController();
  const callee = new NaidanRpcPeer({ transport: transport.b, exports: [expose({ contract: definition, allowedMethods: ['run'], implementation: {
    async run() {
      ready.resolve(); await result.promise;
      return { image: new ReadableStream<Uint8Array>({ pull, cancel: cancelImage }, { highWaterMark: 0 }),
        events: new ReadableStream<number>({ pull, cancel: cancelEvents }, { highWaterMark: 0 }) };
    },
  } })], limits: { maxCalls: 2, maxCallTimeoutMs: undefined }, signal: lifetime.signal });
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
