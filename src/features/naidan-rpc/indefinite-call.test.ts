import { methodNames } from '@/features/naidan-rpc/contract';
// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { contract, procedure, expose, NaidanRpcPeer } from '@/features/naidan-rpc';
import { transportPair } from '@/features/naidan-rpc/test-transport';
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop(); vi.useRealTimers();
});
const definition = contract({ name: 'indefinite.work', methods: { compute: procedure({ input: z.object({}), result: z.number(), notifications: {} }) } });
function peers({ run, maximum }: { run: () => Promise<number>; maximum: number | undefined }) {
  const transport = transportPair({ capacity: 2, fragmentBytes: 1024 }), lifetime = new AbortController();
  const a = new NaidanRpcPeer({ transport: transport.a, exports: [], limits: { maxCalls: 2, maxCallTimeoutMs: maximum }, signal: lifetime.signal });
  const b = new NaidanRpcPeer({ transport: transport.b, exports: [expose({ contract: definition, allowedMethods: methodNames({ contract: definition }), implementation: { compute: run } })], limits: { maxCalls: 2, maxCallTimeoutMs: maximum }, signal: lifetime.signal });
  stops.push(() => {
    lifetime.abort(); transport.close();
  }); return { a, b, transport, lifetime };
}
it('an explicitly unbounded call does not expire after arbitrary hours of slow computation', async () => {
  vi.useFakeTimers(); const gate = Promise.withResolvers<number>(), started = Promise.withResolvers<void>();
  const { a, transport } = peers({
    run: () => {
      started.resolve(); return gate.promise;
    },
    maximum: undefined,
  });
  const call = a.client({ contract: definition }).compute({ input: {}, on: {}, signal: undefined, timeoutMs: undefined });
  await started.promise; let ended = false; void call.result.then(() => {
    ended = true;
  }, () => {
    ended = true;
  });
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000); expect(ended).toBe(false);
  gate.resolve(42); await expect(call.result).resolves.toBe(42); await call.closed; expect(transport.stats().active).toBe(0);
});
it('an unbounded call still responds to explicit caller cancellation without waiting for its producer', async () => {
  vi.useFakeTimers(); const gate = Promise.withResolvers<number>(), started = Promise.withResolvers<void>(), cancel = new AbortController();
  const { a } = peers({
    run: () => {
      started.resolve(); return gate.promise;
    },
    maximum: undefined,
  });
  const call = a.client({ contract: definition }).compute({ input: {}, on: {}, signal: cancel.signal, timeoutMs: undefined });
  await started.promise; const rejected = expect(call.result).rejects.toBeDefined(); cancel.abort(); await rejected;
  gate.resolve(1); await expect(call.closed).rejects.toBeDefined();
});
it('a caller that explicitly chooses a deadline still gets bounded failure', async () => {
  vi.useFakeTimers(); const gate = Promise.withResolvers<number>(), started = Promise.withResolvers<void>();
  const { a } = peers({
    run: () => {
      started.resolve(); return gate.promise;
    },
    maximum: undefined,
  });
  const call = a.client({ contract: definition }).compute({ input: {}, on: {}, signal: undefined, timeoutMs: 100 });
  const rejected = expect(call.result).rejects.toBeDefined(); await started.promise; await vi.advanceTimersByTimeAsync(100); await rejected;
  gate.resolve(1); await expect(call.closed).rejects.toBeDefined();
});
it('a locally configured peer maximum still applies when the caller requests no deadline', async () => {
  vi.useFakeTimers(); const gate = Promise.withResolvers<number>(), started = Promise.withResolvers<void>();
  const { a } = peers({
    run: () => {
      started.resolve(); return gate.promise;
    },
    maximum: 100,
  });
  const call = a.client({ contract: definition }).compute({ input: {}, on: {}, signal: undefined, timeoutMs: undefined });
  const rejected = expect(call.result).rejects.toBeDefined(); await started.promise; await vi.advanceTimersByTimeAsync(100); await rejected;
  gate.resolve(1); await expect(call.closed).rejects.toBeDefined();
});
