import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toChatId } from '@/01-models/ids';
import { createAutoTitleScheduler } from './auto-title-scheduler';

const chatA = toChatId({ raw: 'a' });
const chatB = toChatId({ raw: 'b' });
const onError = vi.fn();
let scheduler: ReturnType<typeof createAutoTitleScheduler>;

beforeEach(() => {
  vi.useFakeTimers();
  onError.mockReset();
  scheduler = createAutoTitleScheduler({ quietMs: 2500, now: () => Date.now(), onError });
});

afterEach(() => {
  scheduler.reset();
  vi.useRealTimers();
});

describe('automatic title scheduling', () => {
  it('waits for a complete quiet period without marking a title active', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    scheduler.schedule({ chatId: chatA, run });
    await vi.advanceTimersByTimeAsync(2499);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('restarts quiet time on activity and on the end of foreground work', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    scheduler.schedule({ chatId: chatA, run });
    await vi.advanceTimersByTimeAsync(2400);
    scheduler.noteActivity();
    await vi.advanceTimersByTimeAsync(2400);
    expect(run).not.toHaveBeenCalled();
    scheduler.setForeground({ state: 'busy' });
    await vi.advanceTimersByTimeAsync(10000);
    expect(run).not.toHaveBeenCalled();
    scheduler.setForeground({ state: 'idle' });
    await vi.advanceTimersByTimeAsync(2499);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('preempts globally but never waits for a provider to acknowledge abort', async () => {
    const done = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    const run = vi.fn(({ signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      return done.promise;
    });
    scheduler.schedule({ chatId: chatA, run });
    await vi.advanceTimersByTimeAsync(2500);
    scheduler.setForeground({ state: 'busy' });
    expect(signals[0]?.aborted).toBe(true);
    scheduler.setForeground({ state: 'idle' });
    await vi.advanceTimersByTimeAsync(10000);
    // No second automatic job overlaps a cancellation-ignoring first one.
    expect(run).toHaveBeenCalledTimes(1);
    done.resolve();
    await vi.advanceTimersByTimeAsync(2500);
    expect(run).toHaveBeenCalledTimes(2);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('keeps only the newest candidate per chat and prioritizes recent chats', async () => {
    const calls: string[] = [];
    scheduler.schedule({
      chatId: chatA,
      run: async () => {
        calls.push('old');
      },
    });
    scheduler.schedule({
      chatId: chatB,
      run: async () => {
        calls.push('b');
      },
    });
    scheduler.schedule({
      chatId: chatA,
      run: async () => {
        calls.push('a');
      },
    });
    await vi.advanceTimersByTimeAsync(2500);
    expect(calls).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(2500);
    expect(calls).toEqual(['a', 'b']);
  });

  it('does not requeue cancelled or reset work when its old promise settles', async () => {
    const done = Promise.withResolvers<void>();
    const run = vi.fn().mockReturnValue(done.promise);
    scheduler.schedule({ chatId: chatA, run });
    await vi.advanceTimersByTimeAsync(2500);
    scheduler.cancel({ chatId: chatA });
    scheduler.noteActivity();
    done.resolve();
    await vi.advanceTimersByTimeAsync(10000);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.schedule({ chatId: chatB, run });
    scheduler.reset();
    await vi.advanceTimersByTimeAsync(10000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('holds during sustained interaction and releases idempotently', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    scheduler.schedule({ chatId: chatA, run });
    const first = scheduler.hold();
    const second = scheduler.hold();
    await vi.advanceTimersByTimeAsync(10000);
    first(); first();
    await vi.advanceTimersByTimeAsync(10000);
    expect(run).not.toHaveBeenCalled();
    second();
    await vi.advanceTimersByTimeAsync(2499);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('isolates failures and does not automatically retry a failing endpoint', async () => {
    const error = new Error('unavailable');
    const run = vi.fn().mockRejectedValue(error);
    scheduler.schedule({ chatId: chatA, run });
    await vi.advanceTimersByTimeAsync(10000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith({ error });
  });

  it('observes synchronous failures as well as asynchronous rejections', async () => {
    const error = new Error('synchronous');
    scheduler.schedule({
      chatId: chatA,
      run: () => {
        throw error;
      },
    });
    await vi.advanceTimersByTimeAsync(2500);
    expect(onError).toHaveBeenCalledExactlyOnceWith({ error });
  });

  it('continues queued work even when the diagnostic callback throws', async () => {
    onError.mockImplementation(() => {
      throw new Error('diagnostics failed');
    });
    const completed = vi.fn().mockResolvedValue(undefined);
    scheduler.schedule({ chatId: chatA, run: completed });
    scheduler.schedule({
      chatId: chatB,
      run: async () => {
        throw new Error('endpoint failed');
      },
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(completed).toHaveBeenCalledOnce();
  });

  it('does not poll when there are no candidates', async () => {
    scheduler.noteActivity();
    scheduler.setForeground({ state: 'busy' });
    scheduler.setForeground({ state: 'idle' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
