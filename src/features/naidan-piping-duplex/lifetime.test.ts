// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { ConnectionLifetime, PipingRetirementError, RecordExhaustedError } from '@/features/naidan-piping-duplex/lifetime';
import { runDuplex } from '@/features/naidan-piping-duplex/runner';
import { sessionPair, useOfflineScope } from '@/features/naidan-piping-duplex/test-support';

useOfflineScope();
const pacing = { minimumMs: 2, idleResendIntervalMs: 100, retryBaseMs: 10, retryMaximumMs: 80 };
function cancelled({ signal }: { signal: AbortSignal }): Promise<never> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
}

it('commits one immutable logical end without waiting for promise listeners', async () => {
  const lifetime = new ConnectionLifetime(), error = new RecordExhaustedError();
  const first = lifetime.commit({ kind: 'record-exhausted', error });
  expect(lifetime.end).toBe(first); expect(Object.isFrozen(first)).toBe(true);
  expect(lifetime.commit({ kind: 'local-stop', error: new Error('Cleanup abort') })).toBe(first);
  await expect(lifetime.ended).resolves.toEqual({ kind: 'record-exhausted', error });
});

it('reports the original local exhausted cause while the runner still owns held cleanup', async () => {
  const { a } = await sessionPair(), cleanup = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const error = new RecordExhaustedError(), stop = new AbortController();
  vi.spyOn(a, 'makeCapsule').mockImplementation(async () => {
    await entered.promise; throw error;
  });
  const running = runDuplex({
    session: a,
    signal: stop.signal,
    pacing,
    onEvent: () => {},
    endpoint: {
      origin: 'https://relay.invalid',
      send: async () => {},
      repair: async () => {},
      async receive({ signal }) {
        entered.resolve();
        try {
          return await cancelled({ signal });
        } finally {
          await cleanup.promise;
        }
      },
    },
  });
  let retired = false; void running.then(() => {
    retired = true;
  }, () => {
    retired = true;
  });
  await expect(a.ended).resolves.toEqual({ kind: 'record-exhausted', error });
  a.abort({ reason: 'Cleanup' }); expect(a.failureReason).toBe(error);
  expect(retired).toBe(false); expect(() => a.claimTransport()).toThrow(error);
  cleanup.resolve(); await expect(running).rejects.toBe(error);
});

it('retains a later cleanup failure separately from an already committed logical cause', async () => {
  const { a } = await sessionPair(), entered = Promise.withResolvers<void>();
  const cause = new Error('Transport failed'), cleanupFailure = new PipingRetirementError({ cause: new Error('Unretired HTTP owner'), logicalError: undefined });
  vi.spyOn(a, 'makeCapsule').mockImplementation(async () => {
    await entered.promise; throw cause;
  });
  const running = runDuplex({
    session: a,
    signal: new AbortController().signal,
    pacing,
    onEvent: () => {},
    endpoint: {
      origin: 'https://relay.invalid',
      send: async () => {},
      repair: async () => {},
      async receive({ signal }) {
        entered.resolve();
        await cancelled({ signal }).catch(() => {});
        throw cleanupFailure;
      },
    },
  });
  await expect(a.ended).resolves.toEqual({ kind: 'transport-fatal', error: cause });
  await expect(running).rejects.toBeInstanceOf(PipingRetirementError);
  expect(a.failureReason).toBe(cause);
});

it('a native seal already in flight is joined after logical cancellation and cannot publish bytes', async () => {
  const { a } = await sessionPair(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (...args) => {
    const result = await encrypt(...args); entered.resolve(); await release.promise; return result;
  });
  const send = vi.fn(async () => {});
  const running = runDuplex({
    session: a,
    signal: new AbortController().signal,
    pacing,
    onEvent: () => {},
    endpoint: {
      origin: 'https://relay.invalid',
      send,
      receive: cancelled,
      repair: async () => {},
    },
  });
  let retired = false; void running.then(() => {
    retired = true;
  }, () => {
    retired = true;
  });
  await entered.promise; a.abort({ reason: 'Stop while crypto completes' });
  await expect(a.ended).resolves.toMatchObject({ kind: 'local-stop' });
  expect(retired).toBe(false); expect(send).not.toHaveBeenCalled();
  expect(() => a.claimTransport()).toThrow();
  release.resolve(); await expect(running).rejects.toBe(a.failureReason);
  expect(send).not.toHaveBeenCalled();
});
