import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleIdleTask } from './idle-task';

describe('scheduleIdleTask', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('uses requestIdleCallback with the requested timeout', async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const requestIdleCallback = vi.fn().mockReturnValue(17);
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback);

    const scheduled = scheduleIdleTask({ task, timeoutMs: 2_000, fallbackDelayMs: 500 });
    const callback = requestIdleCallback.mock.calls[0]![0];
    callback();
    await vi.waitFor(() => {
      expect(task).toHaveBeenCalledOnce();
    });
    scheduled.cancel();

    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 2_000 });
    expect(cancelIdleCallback).toHaveBeenCalledWith(17);
  });


  it('prevents execution when only requestIdleCallback is available', () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const requestIdleCallback = vi.fn().mockReturnValue(29);
    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', undefined);

    const scheduled = scheduleIdleTask({
      task,
      timeoutMs: 2_000,
      fallbackDelayMs: 500,
    });
    const callback = requestIdleCallback.mock.calls[0]![0];

    expect(() => scheduled.cancel()).not.toThrow();
    callback();

    expect(task).not.toHaveBeenCalled();
  });

  it('uses a cancellable timeout fallback', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);
    const task = vi.fn().mockResolvedValue(undefined);

    const scheduled = scheduleIdleTask({ task, timeoutMs: 2_000, fallbackDelayMs: 500 });
    scheduled.cancel();
    vi.advanceTimersByTime(500);

    expect(task).not.toHaveBeenCalled();
  });

  it('observes rejected idle tasks', async () => {
    const error = new Error('idle task failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const requestIdleCallback = vi.fn().mockReturnValue(23);
    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', vi.fn());

    scheduleIdleTask({
      task: async () => {
        throw error;
      },
      timeoutMs: 2_000,
      fallbackDelayMs: 500,
    });
    const callback = requestIdleCallback.mock.calls[0]![0];
    callback();

    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith('Scheduled idle task failed:', error);
    });
  });
});
