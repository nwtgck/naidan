import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import type { HttpEndpoint } from '@/01-models/types';
import type { FakeLmDebugModeStatus } from '@/features/fake-lm/runtime/fakeLmDebugMode';
import { isLoopbackModelConnectionUrl, modelConnectionHttpEndpoint } from '@/logic/model-connection';
import { naturalSort } from '@/utils/string';

type ModelListState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'failed', reason: 'invalid-url' | 'request' };

/** An uncommitted connection owns its requests and list, independently of global settings. */
export function useModelConnectionSelection({ active, type, url, headers, getFakeLmDebugModeStatus }: {
  active: Readonly<Ref<boolean>>,
  type: Readonly<Ref<HttpEndpoint['type'] | 'browser_provided_lm'>>,
  url: Readonly<Ref<string>>,
  headers: Readonly<Ref<[string, string][]>>,
  getFakeLmDebugModeStatus(): FakeLmDebugModeStatus,
}) {
  const models = ref<string[]>([]);
  const modelId = ref<string>();
  const state = ref<ModelListState>({ status: 'idle' });
  const endpoint = computed(() => {
    const kind = type.value;
    switch (kind) {
    case 'browser_provided_lm': return undefined;
    case 'openai':
    case 'ollama': return modelConnectionHttpEndpoint({ type: kind, url: url.value, headers: headers.value });
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled connection type: ${exhaustive}`);
    }
    }
  });
  let request: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function cancel(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    request?.abort();
    request = undefined;
    const current = state.value;
    switch (current.status) {
    case 'loading': state.value = { status: 'idle' };
      break;
    case 'idle':
    case 'ready':
    case 'failed': break;
    default: {
      const exhaustive: never = current;
      throw new Error(`Unhandled model list state: ${String(exhaustive)}`);
    }
    }
  }

  function isCurrent({ controller }: { controller: AbortController }): boolean {
    return !disposed && active.value && request === controller && !controller.signal.aborted;
  }

  async function refresh(): Promise<void> {
    if (!active.value || disposed || type.value === 'browser_provided_lm') {
      return;
    }
    cancel();
    const target = endpoint.value;
    if (target === undefined) {
      state.value = { status: 'failed', reason: 'invalid-url' };
      return;
    }
    const controller = new AbortController();
    request = controller;
    state.value = { status: 'loading' };
    try {
      const { loadLmProvider } = await import('@/features/lm/providerFactory');
      if (!isCurrent({ controller })) {
        return;
      }
      const provider = await loadLmProvider({ endpoint: target, fakeLmDebugModeStatus: getFakeLmDebugModeStatus() });
      if (!isCurrent({ controller })) {
        return;
      }
      const found = await provider.listModels({ signal: controller.signal });
      if (!isCurrent({ controller })) {
        return;
      }
      models.value = naturalSort({ values: [...new Set(found.filter(id => id.trim().length > 0))] });
      if (modelId.value === undefined || !models.value.includes(modelId.value)) {
        modelId.value = models.value[0];
      }
      state.value = { status: 'ready' };
    } catch {
      if (isCurrent({ controller })) {
        // Provider failures can contain request details. Keep credentials out of UI/logs.
        state.value = { status: 'failed', reason: 'request' };
      }
    } finally {
      if (request === controller) {
        request = undefined;
      }
    }
  }

  watch([endpoint, active], () => {
    cancel();
    models.value = [];
    modelId.value = undefined;
    state.value = { status: 'idle' };
    const target = endpoint.value;
    if (active.value && target !== undefined && isLoopbackModelConnectionUrl({ url: target.url })) {
      // Only loopback discovery is automatic. Remote lists require refresh().
      timer = setTimeout(() => {
        timer = undefined;
        void refresh();
      }, 250);
    }
  }, { immediate: true, flush: 'sync' });

  onScopeDispose(() => {
    disposed = true;
    cancel();
  });

  return {
    endpoint,
    models,
    modelId,
    state,
    refresh,
    cancel,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

export const TEST_ONLY = {
};
