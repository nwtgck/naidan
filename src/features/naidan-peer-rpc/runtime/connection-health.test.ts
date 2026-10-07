// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { monitorRpcConnection } from './connection-health';
import type { RpcResponseConfirmation } from './connection-health';

const stops: AbortController[] = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(async () => {
  for (const stop of stops.splice(0)) stop.abort();
  await vi.advanceTimersByTimeAsync(0); vi.useRealTimers(); vi.restoreAllMocks();
});
function fixture() {
  const stop = new AbortController(); stops.push(stop);
  let idle: number | undefined = 0;
  const attempts: { signal: AbortSignal; start(): void; confirm(): void }[] = [];
  const confirmation = vi.fn<RpcResponseConfirmation>(({ signal, onRequestStarted }) => new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => signal.removeEventListener('abort', abort);
    attempts.push({
      signal,
      start: onRequestStarted,
      confirm: () => {
        cleanup(); resolve();
      },
    });
    if (signal.aborted) abort();
  }));
  const changed = vi.fn(), unresponsive = vi.fn<({ revision }: { revision: number }) => 'retiring' | 'observe-again'>(() => 'retiring');
  const task = monitorRpcConnection({
    signal: stop.signal,
    confirmResponse: confirmation,
    idleRevision: () => idle,
    policy: { intervalMs: 100, responseMs: 200, missedResponses: 3, suspensionToleranceMs: 50 },
    changed,
    unresponsive,
  });
  return {
    stop,
    task,
    attempts,
    changed,
    unresponsive,
    idle: ({ revision }: { revision: number | undefined }) => {
      idle = revision;
    },
  };
}

it('keeps an unstarted request unbounded and owns only one confirmation', async () => {
  const health = fixture(); await vi.advanceTimersByTimeAsync(10000);
  expect(health.attempts).toHaveLength(1); expect(health.attempts[0]!.signal.aborted).toBe(false); expect(health.unresponsive).not.toHaveBeenCalled();
  health.stop.abort(); await health.task; expect(vi.getTimerCount()).toBe(0);
});
it('counts started idle windows, resets on success and retires after three consecutive misses', async () => {
  const health = fixture();
  health.attempts[0]!.start(); await vi.advanceTimersByTimeAsync(200);
  expect(health.changed).toHaveBeenLastCalledWith({ state: 'checking' });
  await vi.advanceTimersByTimeAsync(100); health.attempts[1]!.confirm(); await vi.advanceTimersByTimeAsync(0);
  expect(health.changed).toHaveBeenLastCalledWith({ state: 'responsive' });
  await vi.advanceTimersByTimeAsync(100);
  for (let index = 2; index < 5; index++) {
    health.attempts[index]!.start(); await vi.advanceTimersByTimeAsync(200);
    if (index < 4) await vi.advanceTimersByTimeAsync(100);
  }
  await health.task; expect(health.unresponsive).toHaveBeenCalledExactlyOnceWith({ revision: 0 }); expect(vi.getTimerCount()).toBe(0);
});
it('does not count an active call, a completed intervening call, or native cleanup as an idle miss', async () => {
  const health = fixture(); health.attempts[0]!.start(); health.idle({ revision: undefined });
  await vi.advanceTimersByTimeAsync(200); expect(health.changed).toHaveBeenLastCalledWith({ state: 'responsive' });
  await vi.advanceTimersByTimeAsync(1000); expect(health.attempts).toHaveLength(1);
  health.idle({ revision: 1 }); await vi.advanceTimersByTimeAsync(100); health.attempts[1]!.start();
  health.idle({ revision: 2 }); await vi.advanceTimersByTimeAsync(200);
  expect(health.unresponsive).not.toHaveBeenCalled(); expect(health.changed).toHaveBeenLastCalledWith({ state: 'responsive' });
  health.stop.abort(); await health.task;
});
it('cancels the old observation on hidden/freeze and resumes with a fresh request', async () => {
  const health = fixture(); health.attempts[0]!.start();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(0); expect(health.attempts[0]!.signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(1000); expect(health.unresponsive).not.toHaveBeenCalled();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible'); window.dispatchEvent(new Event('pageshow'));
  await vi.advanceTimersByTimeAsync(0); expect(health.attempts).toHaveLength(2);
  health.attempts[1]!.start(); document.dispatchEvent(new Event('freeze'));
  await vi.advanceTimersByTimeAsync(1000); expect(health.attempts).toHaveLength(2);
  document.dispatchEvent(new Event('resume')); await vi.advanceTimersByTimeAsync(0); expect(health.attempts).toHaveLength(3);
  health.stop.abort(); await health.task;
});
it('invalidates a delayed or clock-shifted timer instead of counting suspended time', async () => {
  const health = fixture(); health.attempts[0]!.start();
  vi.setSystemTime(Date.now() + 10000); await vi.advanceTimersByTimeAsync(200);
  expect(health.changed).toHaveBeenLastCalledWith({ state: 'responsive' }); expect(health.unresponsive).not.toHaveBeenCalled();
  health.stop.abort(); await health.task;
});
it('keeps monitoring if final retirement loses an idle generation race', async () => {
  const health = fixture(); health.unresponsive.mockReturnValueOnce('observe-again');
  for (let index = 0; index < 3; index++) {
    health.attempts[index]!.start(); await vi.advanceTimersByTimeAsync(200); await vi.advanceTimersByTimeAsync(100);
  }
  expect(health.attempts).toHaveLength(4); health.attempts[3]!.confirm(); await vi.advanceTimersByTimeAsync(0);
  expect(health.changed).toHaveBeenLastCalledWith({ state: 'responsive' }); health.stop.abort(); await health.task;
});

export const TEST_ONLY = {
};
