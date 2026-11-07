import { describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { flushPromises } from '@vue/test-utils';
import type { LlamaCppBrowserService } from '@/features/llama-cpp-browser/service-contract';
import { LlamaCppBrowserError, type EngineState, type RuntimeOptions } from '@/features/llama-cpp-browser/types';
import type { ProfileState } from '@/features/llama-cpp-browser/runtime/profile-capabilities';
import { useTranslationModelPreparation } from './useTranslationModelPreparation';

function fixture() {
  vi.useFakeTimers();
  const scope = effectScope();
  const modelId = ref<string>();
  const engine = ref<EngineState>({ status: 'idle' });
  const generating = ref(false), storageEpoch = ref(0);
  const prepare = vi.fn<LlamaCppBrowserService['prepareModel']>().mockResolvedValue('ready');
  let optionsListener: (({ options }: { options: RuntimeOptions }) => void) | undefined;
  let profilesListener: (({ state }: { state: ProfileState }) => void) | undefined;
  const unsubscribeOptions = vi.fn(), unsubscribeProfiles = vi.fn();
  const preparation = scope.run(() => useTranslationModelPreparation({
    service: {
      prepareModel: prepare,
      getOptions: () => ({ profile: 'auto' }),
      subscribeOptions: ({ listener }) => {
        optionsListener = listener;
        listener({ options: { profile: 'auto' } });
        return unsubscribeOptions;
      },
      getProfileState: () => ({ status: 'idle' }),
      subscribeProfiles: ({ listener }) => {
        profilesListener = listener;
        listener({ state: { status: 'idle' } });
        return unsubscribeProfiles;
      },
    },
    modelId,
    engine,
    generating,
    storageEpoch,
  }))!;
  return {
    preparation,
    prepare,
    modelId,
    engine,
    generating,
    storageEpoch,
    scope,
    unsubscribeOptions,
    unsubscribeProfiles,
    setOptions({ options }: { options: RuntimeOptions }) {
      optionsListener?.({ options });
    },
    setProfiles({ state }: { state: ProfileState }) {
      profilesListener?.({ state });
    },
    [Symbol.dispose]() {
      scope.stop();
      vi.useRealTimers();
    },
  };
}

describe('translation model preparation ownership', () => {
  it('starts as soon as a verified model is selected, with no text requirement', async () => {
    using f = fixture();
    expect(f.prepare).not.toHaveBeenCalled();
    f.modelId.value = 'one';
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.preparation.status.value).toBe('preparing');
    await flushPromises();
    expect(f.preparation.ready.value).toBe(true);
    expect(f.prepare.mock.calls[0]?.[0].signal?.aborted).toBe(false);
  });

  it('keeps its own loading controller through progress and generation intent changes', async () => {
    using f = fixture();
    const pending = Promise.withResolvers<'ready' | 'skipped-busy'>();
    f.prepare.mockReturnValueOnce(pending.promise);
    f.modelId.value = 'one';
    const request = f.prepare.mock.calls[0]![0];
    request.onProgress?.({ progress: { phase: 'loading', completed: 2, total: 8 } });
    f.engine.value = { status: 'working', progress: { phase: 'loading', completed: 3, total: 8 } };
    f.generating.value = true;
    f.generating.value = false;
    await nextTick();
    expect(request.signal?.aborted).toBe(false);
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.preparation.progress.value?.completed).toBe(2);
    pending.resolve('ready');
    await flushPromises();
    expect(f.preparation.ready.value).toBe(true);
    request.onProgress?.({ progress: { phase: 'loading', completed: 7, total: 8 } });
    expect(f.preparation.progress.value).toBeUndefined();
  });

  it('retires the old preparation before loading the newest model and ignores old progress', async () => {
    using f = fixture();
    const old = Promise.withResolvers<'ready' | 'skipped-busy'>();
    f.prepare.mockReturnValueOnce(old.promise);
    f.modelId.value = 'one';
    const request = f.prepare.mock.calls[0]![0];
    f.modelId.value = 'two';
    f.modelId.value = 'three';
    expect(request.signal?.aborted).toBe(true);
    expect(f.prepare).toHaveBeenCalledOnce();
    request.onProgress?.({ progress: { phase: 'loading', completed: 99, total: 100 } });
    expect(f.preparation.progress.value).toBeUndefined();
    old.resolve('ready');
    await flushPromises();
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(f.prepare.mock.calls[1]?.[0].modelId).toBe('three');
    expect(f.preparation.ready.value).toBe(true);
  });

  it('changes ownership only for actual runtime configuration or storage changes', async () => {
    using f = fixture();
    f.modelId.value = 'one';
    await flushPromises();
    f.setOptions({ options: { profile: 'auto' } });
    await flushPromises();
    expect(f.prepare).toHaveBeenCalledOnce();
    f.setOptions({ options: { profile: 'cpu-wasm32', contextTokens: 8192 } });
    await flushPromises();
    expect(f.prepare).toHaveBeenCalledTimes(2);
    f.storageEpoch.value++;
    await flushPromises();
    expect(f.prepare).toHaveBeenCalledTimes(3);
  });

  it('does not reprepare on its own generation but rechecks after a foreign operation', async () => {
    using f = fixture();
    f.modelId.value = 'one';
    await flushPromises();
    f.generating.value = true;
    f.engine.value = { status: 'working', progress: { phase: 'prefill', completed: 0, total: 0 } };
    f.engine.value = { status: 'idle' };
    f.generating.value = false;
    await flushPromises();
    expect(f.prepare).toHaveBeenCalledOnce();
    f.engine.value = { status: 'working', progress: { phase: 'loading', completed: 0, total: 0 } };
    expect(f.preparation.status.value).toBe('waiting');
    f.engine.value = { status: 'idle' };
    await flushPromises();
    expect(f.prepare).toHaveBeenCalledTimes(2);
  });

  it('waits for occupied lanes and retries a skipped reservation without a busy loop', async () => {
    using f = fixture();
    f.engine.value = { status: 'working', progress: { phase: 'generating', completed: 0, total: 0 } };
    f.modelId.value = 'one';
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.prepare).not.toHaveBeenCalled();
    f.prepare.mockResolvedValueOnce('skipped-busy');
    f.engine.value = { status: 'idle' };
    await flushPromises();
    expect(f.preparation.status.value).toBe('waiting');
    await vi.advanceTimersByTimeAsync(499);
    expect(f.prepare).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(f.preparation.ready.value).toBe(true);
  });

  it('requires an explicit retry after a failure instead of continuously restarting a broken model', async () => {
    using f = fixture();
    f.prepare.mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'invalid-gguf' }));
    f.modelId.value = 'one';
    await flushPromises();
    expect(f.preparation.failure.value).toBe('invalid-gguf');
    f.engine.value = { status: 'idle' };
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.prepare).toHaveBeenCalledOnce();
    f.preparation.retry();
    await flushPromises();
    expect(f.preparation.ready.value).toBe(true);
  });

  it('revalidates released workers without changing the text retry identity', async () => {
    using f = fixture();
    f.modelId.value = 'one';
    await flushPromises();
    const identity = f.preparation.identity.value;
    f.setProfiles({ state: { status: 'ready', capabilities: { profiles: [], recommended: undefined } } });
    f.setProfiles({ state: { status: 'idle' } });
    await flushPromises();
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(f.preparation.identity.value).toBe(identity);
  });

  it('does not start a new model after disposal even when an obsolete promise settles', async () => {
    using f = fixture();
    const pending = Promise.withResolvers<'ready' | 'skipped-busy'>();
    f.prepare.mockReturnValueOnce(pending.promise);
    f.modelId.value = 'one';
    f.modelId.value = 'two';
    f.scope.stop();
    pending.resolve('ready');
    await flushPromises();
    f.preparation.retry();
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.prepare.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(f.unsubscribeOptions).toHaveBeenCalledOnce();
    expect(f.unsubscribeProfiles).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
