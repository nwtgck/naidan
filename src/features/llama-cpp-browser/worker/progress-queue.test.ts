import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgressQueue } from './progress-queue';

type NumericProgress = Parameters<ReturnType<typeof createProgressQueue>['send']>[0]['progress'];
function deferred() {
  let resolve: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<void>((done, fail) => {
    resolve = done; reject = fail;
  });
  return { promise, resolve, reject };
}
function update({ phase, completed }: { phase: NumericProgress['phase'], completed: number }): NumericProgress {
  return { phase, completed, total: 10000 };
}
afterEach(() => vi.restoreAllMocks());

describe('bounded text progress delivery', () => {
  it('sends the first snapshot immediately and drains only the latest of a large blocked burst', async () => {
    const first = deferred(); const last = deferred(); const seen: number[] = [];
    const queue = createProgressQueue({ signal: new AbortController().signal, deliver: ({ progress }) => {
      seen.push(progress.completed);
      return seen.length === 1 ? first.promise : last.promise;
    } });
    for (let completed = 1; completed <= 10000; completed++) queue.send({ progress: update({ phase: 'generating', completed }) });
    expect(seen).toEqual([1]);
    let finished = false;
    const finish = queue.finish().then(() => {
      finished = true;
    });
    expect(finished).toBe(false);
    first.resolve(); await vi.waitFor(() => expect(seen).toEqual([1, 10000]));
    expect(finished).toBe(false);
    last.resolve(); await finish;
    expect(queue.counters).toEqual({ received: 10000, sent: 2, settled: 2, coalesced: 9998,
      discarded: 0, callbackFailures: 0, peakInFlight: 1, peakPending: 1 });
  });
  it.each(['prefill-first', 'generating-first'] as const)('does not replay old-phase pending progress when %s settles', async order => {
    const prefill = deferred(); const generating = deferred(); const last = deferred();
    const seen: string[] = [];
    const queue = createProgressQueue({ signal: new AbortController().signal, deliver: ({ progress }) => {
      seen.push(`${progress.phase}:${progress.completed}`);
      if (progress.phase === 'prefill') return prefill.promise;
      return progress.completed === 1 ? generating.promise : last.promise;
    } });
    for (const completed of [1, 2, 3]) queue.send({ progress: update({ phase: 'prefill', completed }) });
    for (const completed of [1, 2, 3]) queue.send({ progress: update({ phase: 'generating', completed }) });
    expect(seen).toEqual(['prefill:1', 'generating:1']);
    let finished = false;
    const finishing = queue.finish().then(() => {
      finished = true;
    });
    switch (order) {
    case 'prefill-first': prefill.resolve(); await vi.waitFor(() => expect(queue.counters.settled).toBe(1)); generating.resolve(); break;
    case 'generating-first': generating.resolve(); break;
    default: { const exhaustive: never = order; throw new Error(exhaustive); }
    }
    await vi.waitFor(() => expect(seen).toEqual(['prefill:1', 'generating:1', 'generating:3']));
    last.resolve(); await Promise.resolve(); expect(finished).toBe(false);
    prefill.resolve(); await finishing;
    expect(queue.counters).toMatchObject({ received: 6, sent: 3, settled: 3,
      coalesced: 2, discarded: 1, peakInFlight: 2, peakPending: 1 });
  });
  it('keeps the queued snapshot independent of a reused caller object', async () => {
    const blocked = deferred(); const seen: NumericProgress[] = [];
    const queue = createProgressQueue({ signal: new AbortController().signal, deliver: ({ progress }) => {
      seen.push({ ...progress }); return seen.length === 1 ? blocked.promise : undefined;
    } });
    const progress = update({ phase: 'prefill', completed: 1 }); queue.send({ progress });
    progress.completed = 20; queue.send({ progress });
    progress.completed = 999; progress.total = 999;
    blocked.resolve(); await queue.finish();
    expect(seen.map(item => item.completed)).toEqual([1, 20]); expect(seen[1]!.total).toBe(10000);
  });
  it('does not let a callback change its in-flight ownership key', async () => {
    const queue = createProgressQueue({ signal: new AbortController().signal, deliver: ({ progress }) => {
      progress.phase = 'generating';
    } });
    queue.send({ progress: update({ phase: 'prefill', completed: 1 }) });
    await queue.finish(); expect(queue.counters.settled).toBe(1);
  });
  it.each(['send', 'finish', 'ack'] as const)('discards unsent progress on cancellation observed by %s', async observation => {
    const blocked = deferred(); const controller = new AbortController(); const deliver = vi.fn(() => blocked.promise);
    const queue = createProgressQueue({ signal: controller.signal, deliver });
    queue.send({ progress: update({ phase: 'generating', completed: 1 }) });
    queue.send({ progress: update({ phase: 'generating', completed: 2 }) });
    controller.abort();
    switch (observation) {
    case 'send': queue.send({ progress: update({ phase: 'generating', completed: 3 }) }); break;
    case 'finish': void queue.finish(); break;
    case 'ack': blocked.resolve(); await Promise.resolve(); break;
    default: { const exhaustive: never = observation; throw new Error(exhaustive); }
    }
    blocked.resolve(); await queue.finish();
    expect(deliver).toHaveBeenCalledOnce(); expect(queue.counters.discarded).toBe(observation === 'send' ? 2 : 1);
  });
  it('does not start a callback for an already cancelled request', async () => {
    const deliver = vi.fn(); const queue = createProgressQueue({ signal: AbortSignal.abort(), deliver });
    queue.send({ progress: update({ phase: 'prefill', completed: 1 }) }); await queue.finish();
    expect(deliver).not.toHaveBeenCalled(); expect(queue.counters).toMatchObject({ received: 1, sent: 0, discarded: 1 });
  });
  it.each(['sync', 'async', 'thenable'] as const)('sanitizes %s callback failure and consumes all rejection paths', async kind => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const queue = createProgressQueue({ signal: new AbortController().signal, deliver: () => {
      const error = new Error('private callback payload');
      switch (kind) {
      case 'sync': throw error;
      case 'async': return Promise.reject(error);
      case 'thenable': return { get then() {
        throw error;
      } } as unknown as Promise<void>;
      default: { const exhaustive: never = kind; throw new Error(exhaustive); }
      }
    } });
    queue.send({ progress: update({ phase: 'prefill', completed: 1 }) });
    queue.send({ progress: update({ phase: 'prefill', completed: 2 }) });
    await expect(queue.finish()).rejects.toThrow('worker-failed');
    expect(queue.counters).toMatchObject({ received: 2, sent: 1, settled: 1, discarded: 1, callbackFailures: 1 });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private callback payload');
  });
  it('drains the other phase before reporting a rejected callback', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const prefill = deferred(); const generating = deferred();
    const deliver = vi.fn(({ progress }: { progress: NumericProgress }) => progress.phase === 'prefill' ? prefill.promise : generating.promise);
    const queue = createProgressQueue({ signal: new AbortController().signal, deliver });
    queue.send({ progress: update({ phase: 'prefill', completed: 1 }) });
    queue.send({ progress: update({ phase: 'generating', completed: 1 }) });
    queue.send({ progress: update({ phase: 'generating', completed: 2 }) });
    let done = false;
    const finishing = queue.finish().catch(error => {
      done = true; return error;
    });
    prefill.reject(new Error('private rejected progress')); await vi.waitFor(() => expect(queue.counters.callbackFailures).toBe(1));
    expect(done).toBe(false); expect(deliver).toHaveBeenCalledTimes(2);
    generating.resolve(); expect(await finishing).toMatchObject({ message: 'llama.cpp browser: worker-failed' });
    expect(queue.counters).toMatchObject({ sent: 2, settled: 2, discarded: 1 });
  });
  it('publishes ownership before reentrant synchronous delivery', async () => {
    const first = deferred(); const seen: number[] = [];
    const queue = createProgressQueue({ signal: new AbortController().signal, deliver: ({ progress }) => {
      seen.push(progress.completed);
      if (progress.completed === 1) {
        queue.send({ progress: update({ phase: 'generating', completed: 2 }) });
        queue.send({ progress: update({ phase: 'generating', completed: 3 }) });
        return first.promise;
      }
      return undefined;
    } });
    queue.send({ progress: update({ phase: 'generating', completed: 1 }) });
    expect(seen).toEqual([1]); first.resolve(); await queue.finish(); expect(seen).toEqual([1, 3]);
    expect(queue.counters.peakInFlight).toBe(1);
  });
  it('ignores late sends after finish starts while draining previously accepted progress', async () => {
    const blocked = deferred(); const seen: number[] = [];
    const queue = createProgressQueue({ signal: new AbortController().signal, deliver: ({ progress }) => {
      seen.push(progress.completed); return progress.completed === 1 ? blocked.promise : undefined;
    } });
    queue.send({ progress: update({ phase: 'prefill', completed: 1 }) });
    queue.send({ progress: update({ phase: 'prefill', completed: 2 }) });
    const finishing = queue.finish();
    queue.send({ progress: update({ phase: 'generating', completed: 3 }) }); blocked.resolve(); await finishing;
    const counters = { ...queue.counters };
    queue.send({ progress: update({ phase: 'generating', completed: 4 }) }); await queue.finish();
    expect(seen).toEqual([1, 2]); expect(queue.counters).toEqual(counters);
  });
  it('needs neither timer scheduling nor a performance clock', async () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout'); const clock = vi.spyOn(performance, 'now');
    const queue = createProgressQueue({ signal: new AbortController().signal, deliver: () => {} });
    queue.send({ progress: update({ phase: 'generating', completed: 1 }) }); await queue.finish();
    expect(timeout).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled();
  });
});
