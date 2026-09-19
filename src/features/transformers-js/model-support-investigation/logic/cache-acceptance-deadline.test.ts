import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheAcceptanceTimeoutError, withCacheAcceptanceDeadline } from './cache-acceptance-deadline';

afterEach(() => vi.useRealTimers());
describe('cache acceptance deadline', () => {
  it('aborts the Worker owner on expiry and returns even when a remote never settles', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const stopped = vi.fn();
    controller.signal.addEventListener('abort', stopped);
    const result = withCacheAcceptanceDeadline({
      start: () => new Promise<never>(() => undefined), controller, timeoutMs: 100,
    }).catch(error => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBeInstanceOf(CacheAcceptanceTimeoutError);
    expect(controller.signal.reason).toBe(await result);
    expect(stopped).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its deadline after success without aborting the completed operation', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    expect(await withCacheAcceptanceDeadline({ start: async () => 7, controller, timeoutMs: 100 })).toBe(7);
    await vi.advanceTimersByTimeAsync(200);
    expect(controller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves user cancellation and never starts an already cancelled operation', async () => {
    const controller = new AbortController();
    const start = vi.fn(async () => 7);
    const reason = new Error('User stopped');
    controller.abort(reason);
    await expect(withCacheAcceptanceDeadline({ start, controller, timeoutMs: 100 })).rejects.toBe(reason);
    expect(start).not.toHaveBeenCalled();
  });
});
