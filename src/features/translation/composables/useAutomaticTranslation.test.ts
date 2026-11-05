import { describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { useAutomaticTranslation } from './useAutomaticTranslation';

function fixture() {
  vi.useFakeTimers();
  const scope = effectScope();
  const key = ref('first');
  const enabled = ref(true), ready = ref(false), busy = ref(false), composing = ref(false);
  const run = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const invalidate = vi.fn(), stop = vi.fn();
  const actions = scope.run(() => useAutomaticTranslation({ key, enabled, ready, busy, composing, run, invalidate, stop }))!;
  return {
    key,
    enabled,
    ready,
    busy,
    composing,
    run,
    invalidate,
    stop,
    actions,
    scope,
    async settle() {
      await nextTick();
      await vi.advanceTimersByTimeAsync(600);
      await nextTick();
    },
    [Symbol.dispose]() {
      scope.stop();
      vi.useRealTimers();
    },
  };
}

describe('automatic translation scheduling', () => {
  it('debounces a burst into one latest request', async () => {
    using f = fixture();
    f.ready.value = true;
    f.key.value = 'one';
    await nextTick();
    await vi.advanceTimersByTimeAsync(450);
    f.key.value = 'two';
    await vi.advanceTimersByTimeAsync(599);
    expect(f.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.run).toHaveBeenCalledOnce();
    await f.settle();
    expect(f.run).toHaveBeenCalledOnce();
  });

  it('does not submit composing text and waits again after composition ends', async () => {
    using f = fixture();
    f.ready.value = true;
    f.composing.value = true;
    f.key.value = '仮';
    await f.settle();
    await f.actions.runManually();
    expect(f.run).not.toHaveBeenCalled();
    f.composing.value = false;
    f.key.value = '確定';
    await vi.advanceTimersByTimeAsync(599);
    expect(f.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.run).toHaveBeenCalledOnce();
  });

  it('waits for cancellation to settle, then uses the latest intent only', async () => {
    using f = fixture();
    f.ready.value = true;
    f.busy.value = true;
    f.key.value = 'one';
    await f.settle();
    f.key.value = 'two';
    await f.settle();
    expect(f.invalidate).toHaveBeenCalledTimes(2);
    expect(f.run).not.toHaveBeenCalled();
    f.busy.value = false;
    await f.settle();
    expect(f.run).toHaveBeenCalledOnce();
  });

  it('keeps an explicit stop stopped through readiness and busy notifications', async () => {
    using f = fixture();
    f.ready.value = true;
    f.key.value = 'one';
    await f.settle();
    f.busy.value = true;
    f.actions.stopManually();
    f.ready.value = false;
    await nextTick();
    f.busy.value = false;
    f.ready.value = true;
    await f.settle();
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.stop).toHaveBeenCalledOnce();
    f.key.value = 'edited';
    await f.settle();
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it('allows an explicit retry of the same stopped or failed input', async () => {
    using f = fixture();
    f.ready.value = true;
    f.key.value = 'one';
    await f.settle();
    f.actions.stopManually();
    await f.actions.runManually();
    expect(f.run).toHaveBeenCalledTimes(2);
    await f.settle();
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it('does not retry the same failed operation when the runtime becomes idle', async () => {
    using f = fixture();
    f.ready.value = true;
    f.key.value = 'one';
    await f.settle();
    f.busy.value = true;
    f.ready.value = false;
    await nextTick();
    f.busy.value = false;
    f.ready.value = true;
    await f.settle();
    expect(f.run).toHaveBeenCalledOnce();
  });

  it('cancels a pending timer when disabled and leaves manual execution available', async () => {
    using f = fixture();
    f.ready.value = true;
    f.key.value = 'one';
    f.enabled.value = false;
    await f.settle();
    expect(f.run).not.toHaveBeenCalled();
    await f.actions.runManually();
    expect(f.run).toHaveBeenCalledOnce();
    f.key.value = 'two';
    await f.settle();
    expect(f.run).toHaveBeenCalledOnce();
  });

  it('starts again after explicitly re-enabling automatic translation', async () => {
    using f = fixture();
    f.ready.value = true;
    f.actions.stopManually();
    f.enabled.value = false;
    await nextTick();
    f.enabled.value = true;
    await f.settle();
    expect(f.run).toHaveBeenCalledOnce();
  });

  it('defers work while a model picker or external operation blocks readiness', async () => {
    using f = fixture();
    f.key.value = 'one';
    await f.settle();
    expect(f.run).not.toHaveBeenCalled();
    f.ready.value = true;
    await f.settle();
    expect(f.run).toHaveBeenCalledOnce();
  });

  it('does not duplicate a manual run with an already scheduled automatic run', async () => {
    using f = fixture();
    f.ready.value = true;
    f.key.value = 'one';
    await f.actions.runManually();
    await f.settle();
    expect(f.run).toHaveBeenCalledOnce();
  });

  it('cannot run or keep timers after disposal', async () => {
    using f = fixture();
    f.ready.value = true;
    f.key.value = 'one';
    await nextTick();
    f.scope.stop();
    await f.settle();
    await f.actions.runManually();
    expect(f.run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
