import { effectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toChatId } from '@/01-models/ids';
import { autoTitleScheduler } from '@/composables/chat/global/auto-title-runtime';
import { useAutoTitleActivity } from './useAutoTitleActivity';

beforeEach(() => {
  vi.useFakeTimers(); autoTitleScheduler.reset();
});
afterEach(() => {
  autoTitleScheduler.reset(); vi.useRealTimers();
});

describe('input activity lifetime', () => {
  it('does not start a title during IME composition, even after a long pause', async () => {
    const scope = effectScope();
    const activity = scope.run(useAutoTitleActivity)!;
    const run = vi.fn().mockResolvedValue(undefined);
    autoTitleScheduler.schedule({ chatId: toChatId({ raw: 'ime' }), run });
    activity.beginComposition(); activity.beginComposition();
    await vi.advanceTimersByTimeAsync(10000);
    expect(run).not.toHaveBeenCalled();
    activity.endComposition(); activity.endComposition();
    await vi.advanceTimersByTimeAsync(2499);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    scope.stop();
  });

  it('ignores async continuations after the input scope has been disposed', async () => {
    const scope = effectScope();
    const activity = scope.run(useAutoTitleActivity)!;
    scope.stop();
    const run = vi.fn().mockResolvedValue(undefined);
    autoTitleScheduler.schedule({ chatId: toChatId({ raw: 'new-input' }), run });
    await vi.advanceTimersByTimeAsync(2400);
    const finishLateAttachment = activity.hold();
    activity.beginComposition();
    activity.noteActivity();
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(run).toHaveBeenCalledOnce();
    } finally {
      finishLateAttachment(); activity.endComposition();
    }
  });

  it('releases every sustained activity on unmount and tolerates late cleanup', async () => {
    const scope = effectScope();
    const activity = scope.run(useAutoTitleActivity)!;
    const run = vi.fn().mockResolvedValue(undefined);
    const finishAttachment = activity.hold();
    activity.beginComposition();
    autoTitleScheduler.schedule({ chatId: toChatId({ raw: 'unmount' }), run });
    await vi.advanceTimersByTimeAsync(10000);
    expect(run).not.toHaveBeenCalled();
    scope.stop();
    finishAttachment(); activity.endComposition();
    await vi.advanceTimersByTimeAsync(2500);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
