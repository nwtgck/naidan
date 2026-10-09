// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NaidanRpcPeer, NaidanRpcCallBudget, contract, expose, procedure } from './index';
import { transportPair } from './test-transport';

it('joins old network ownership without freeing a canceled native job or allowing a new shared call', async () => {
  const budget = new NaidanRpcCallBudget({ capacity: 1 });
  const definition = contract({ name: 'retirement.test', methods: { run: procedure({ input: z.object({}), result: z.number(), notifications: {} }) } });
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const handler = vi.fn(async () => {
    started.resolve(); await finish.promise; return 17;
  });
  const wire = transportPair({ capacity: 4, fragmentBytes: 256 }), nextWire = transportPair({ capacity: 4, fragmentBytes: 256 });
  const limits = { maxCalls: 4, maxCallTimeoutMs: undefined }, signal = new AbortController().signal;
  const old = new NaidanRpcPeer({ transport: wire.b, exports: [expose({ contract: definition, allowedMethods: ['run'], implementation: { run: handler } })], limits, signal, callBudget: budget });
  const caller = new NaidanRpcPeer({ transport: wire.a, exports: [], limits, signal });
  const next = new NaidanRpcPeer({ transport: nextWire.a, exports: [], limits, signal, callBudget: budget });
  const call = caller.client({ contract: definition }).run({ input: {}, on: {}, signal, timeoutMs: undefined });
  try {
    await started.promise;
    await old.retireNetwork();
    let fullyRetired = false; const retirement = old.retire().then(() => {
      fullyRetired = true;
    });
    await Promise.resolve(); expect(fullyRetired).toBe(false);
    expect(budget.reserve()).toBeUndefined();
    const blocked = next.client({ contract: definition }).run({ input: {}, on: {}, signal, timeoutMs: undefined });
    await expect(blocked.result).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' });
    await expect(blocked.closed).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' });
    expect(nextWire.stats().total).toBe(0);
    finish.resolve(); await retirement; expect(fullyRetired).toBe(true);
    const release = budget.reserve(); expect(release).toBeDefined(); release!(); release!();
    await expect(call.result).rejects.toBeDefined(); await expect(call.closed).rejects.toBeDefined();
    expect(handler).toHaveBeenCalledOnce();
  } finally {
    finish.resolve(); wire.close(); nextWire.close();
    await Promise.all([old.retire(), caller.retire(), next.retire()]);
  }
});

it('shares a single finite call budget with idempotent release', () => {
  const budget = new NaidanRpcCallBudget({ capacity: 2 });
  const first = budget.reserve()!, second = budget.reserve()!;
  expect(budget.reserve()).toBeUndefined();
  first(); first(); const third = budget.reserve()!;
  expect(budget.reserve()).toBeUndefined(); second(); third();
  expect(budget.reserve()).toBeDefined();
});

it('retains shared call capacity after late native cleanup failure instead of releasing it to a new peer', async () => {
  const { rpc } = await import('./index');
  const budget = new NaidanRpcCallBudget({ capacity: 1 });
  const definition = contract({ name: 'late.cleanup.test', methods: { stream: procedure({ input: z.object({}), result: rpc.byteStream(), notifications: {} }) } });
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const failure = new Error('Native cleanup failed');
  const wire = transportPair({ capacity: 2, fragmentBytes: 256 }), signal = new AbortController().signal;
  const caller = new NaidanRpcPeer({ transport: wire.a, exports: [], limits: { maxCalls: 2, maxCallTimeoutMs: undefined }, signal });
  const callee = new NaidanRpcPeer({
    transport: wire.b,
    callBudget: budget,
    limits: { maxCalls: 2, maxCallTimeoutMs: undefined },
    signal,
    exports: [expose({
      contract: definition,
      allowedMethods: ['stream'],
      implementation: {
        stream: () => new ReadableStream<Uint8Array>({
          pull() {
            started.resolve();
          },
          async cancel() {
            await finish.promise; throw failure;
          },
        }, { highWaterMark: 0 }),
      },
    })],
  });
  const call = caller.client({ contract: definition }).stream({ input: {}, on: {}, signal, timeoutMs: undefined });
  let retirement: Promise<void> | undefined;
  try {
    const reading = (await call.result).getReader().read(); void reading.catch(() => {});
    await started.promise; await callee.retireNetwork();
    retirement = callee.retire(); const rejected = expect(retirement).rejects.toBeDefined();
    expect(budget.reserve()).toBeUndefined();
    finish.resolve(); await rejected;
    expect(budget.reserve()).toBeUndefined();
    await expect(call.closed).rejects.toBeDefined();
  } finally {
    finish.resolve(); wire.close();
    await Promise.allSettled([caller.retire(), retirement ?? callee.retire()]);
  }
});
