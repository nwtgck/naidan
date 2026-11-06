import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import type { LlamaCppBrowserService } from '@/features/llama-cpp-browser/service-contract';
import { errorCode, type EngineState, type ErrorCode, type Progress } from '@/features/llama-cpp-browser/types';

/** Model ownership is independent of text revisions and of the automatic timer. */
export function useTranslationModelPreparation({ service, modelId, engine, generating, storageEpoch }: {
  service: Pick<LlamaCppBrowserService, 'prepareModel' | 'getOptions' | 'subscribeOptions' | 'getProfileState' | 'subscribeProfiles'>,
  modelId: Readonly<Ref<string | undefined>>,
  engine: Readonly<Ref<EngineState>>,
  generating: Readonly<Ref<boolean>>,
  storageEpoch: Readonly<Ref<number>>,
}) {
  const status = ref<'idle' | 'waiting' | 'preparing' | 'ready' | 'error'>('idle');
  const progress = shallowRef<Progress>();
  const failure = ref<ErrorCode>();
  const options = shallowRef(service.getOptions());
  const runtimeEpoch = ref(0);
  const identity = computed(() => {
    const { profile, contextTokens, visionBf16Storage, ...unhandled } = options.value;
    unhandled satisfies Record<PropertyKey, never>;
    return JSON.stringify({ modelId: modelId.value, profile, contextTokens, visionBf16Storage, storageEpoch: storageEpoch.value });
  });
  const key = computed(() => JSON.stringify({ identity: identity.value, runtimeEpoch: runtimeEpoch.value }));
  let active: { key: string, controller: AbortController } | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function clearRetry(): void {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  function scheduleRetry(): void {
    clearRetry();
    // The shared lane may be reserved even while its last progress says idle.
    // Never busy-loop or steal another feature's controller.
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void prepare();
    }, 500);
  }

  async function prepare(): Promise<void> {
    if (disposed || active || !modelId.value || status.value === 'ready' || status.value === 'error') {
      return;
    }
    clearRetry();
    if (generating.value) {
      status.value = 'waiting';
      return;
    }
    const engineState = engine.value;
    switch (engineState.status) {
    case 'working': status.value = 'waiting';
      return;
    case 'unavailable': status.value = 'error';
      failure.value = 'unavailable';
      return;
    case 'idle': case 'error': break;
    default: {
      const exhaustive: never = engineState;
      throw new Error(String(exhaustive));
    }
    }
    const accepted = { key: key.value, controller: new AbortController() };
    active = accepted;
    status.value = 'preparing';
    progress.value = undefined;
    failure.value = undefined;
    const current = () => !disposed && active === accepted && key.value === accepted.key && !accepted.controller.signal.aborted;
    try {
      const outcome = await service.prepareModel({
        modelId: modelId.value,
        signal: accepted.controller.signal,
        onProgress: ({ progress: next }) => {
          if (current()) {
            progress.value = next;
          }
        },
      });
      if (current()) {
        switch (outcome) {
        case 'ready': status.value = 'ready';
          break;
        case 'skipped-busy': status.value = 'waiting';
          scheduleRetry();
          break;
        default: {
          const exhaustive: never = outcome;
          throw new Error(String(exhaustive));
        }
        }
      }
    } catch (error) {
      if (current()) {
        status.value = 'error';
        failure.value = errorCode({ error });
      }
    } finally {
      if (active === accepted) {
        active = undefined;
        progress.value = undefined;
      }
      // A different model/configuration waits for retirement of the old one.
      if (!disposed && accepted.key !== key.value) {
        void prepare();
      }
    }
  }

  function invalidate(): void {
    clearRetry();
    active?.controller.abort();
    progress.value = undefined;
    failure.value = undefined;
    status.value = modelId.value ? 'waiting' : 'idle';
    void prepare();
  }

  watch(key, invalidate, { immediate: true, flush: 'sync' });
  watch([engine, generating], () => {
    if (disposed || active) {
      return;
    }
    if (engine.value.status === 'working' && !generating.value && status.value === 'ready') {
      // A foreign operation may replace the native model without replacing its Worker.
      status.value = 'waiting';
    }
    const currentStatus = status.value;
    switch (currentStatus) {
    case 'waiting': void prepare();
      break;
    case 'idle': case 'preparing': case 'ready': case 'error': break;
    default: {
      const exhaustive: never = currentStatus;
      throw new Error(String(exhaustive));
    }
    }
  }, { flush: 'sync' });
  const unsubscribeOptions = service.subscribeOptions({
    listener: ({ options: next }) => {
      options.value = next;
    },
  });
  let observedProfiles = service.getProfileState().status === 'ready';
  const unsubscribeProfiles = service.subscribeProfiles({
    listener: ({ state }) => {
      switch (state.status) {
      case 'ready': observedProfiles = true;
        break;
      case 'idle':
        if (observedProfiles) {
          observedProfiles = false;
          runtimeEpoch.value++;
        }
        break;
      case 'checking': case 'error': break;
      default: {
        const exhaustive: never = state;
        throw new Error(String(exhaustive));
      }
      }
    },
  });

  function retry(): void {
    if (!disposed && !active) {
      status.value = modelId.value ? 'waiting' : 'idle';
      failure.value = undefined;
      void prepare();
    }
  }

  onScopeDispose(() => {
    disposed = true;
    clearRetry();
    active?.controller.abort();
    unsubscribeOptions();
    unsubscribeProfiles();
  });
  return { status, progress, failure, identity, ready: computed(() => status.value === 'ready'), retry, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
