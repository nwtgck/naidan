import { computed, hasInjectionContext, inject, ref, shallowRef, watch, type ComputedRef } from 'vue';
import { routerKey } from 'vue-router';
import { idToRaw } from '@/01-models/ids';
import type { Chat, Endpoint } from '@/01-models/types';
import type { ChatModelLaunch } from '@/01-models/llama-cpp-browser-model-launch';
import { storageService } from '@/00-storage/service';
import { useSettings } from '@/composables/useSettings';
import { parseRepository } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { modelLaunchViewHistoryKey, readModelLaunchView, modelLaunchViewState } from '@/features/llama-cpp-browser/model-launch/history';
import { restoreModelLaunchTarget } from '@/features/llama-cpp-browser/model-launch/restore';

export function useRestoredModelLaunch({ chat, resolved }: {
  chat: ComputedRef<Chat | null>, resolved: ComputedRef<{ endpoint: Endpoint, modelId: string | undefined } | undefined>,
}) {
  const router = hasInjectionContext() ? inject(routerKey, undefined) : undefined;
  const { settings } = useSettings();
  const launch = shallowRef<ChatModelLaunch>();
  const restoration = ref<'idle' | 'checking' | 'failed'>('idle');
  const retry = ref(0);
  // Split panes may retain another empty Chat. Only the active route owns this
  // navigation context and permission to prepare the model speculatively.
  const isCurrentRoute = computed(() => router === undefined || (chat.value !== null
    && router.currentRoute.value.path === `/chat/${idToRaw({ id: chat.value.id })}`));
  const view = computed(() => {
    const current = chat.value;
    if (!isCurrentRoute.value || current === null || resolved.value?.endpoint.type !== 'llama_cpp_browser' || router === undefined) return undefined;
    return readModelLaunchView({ state: router.options.history.state[modelLaunchViewHistoryKey], chatId: current.id, modelId: resolved.value.modelId });
  });
  function synchronize(): void {
    launch.value = chat.value === null ? undefined : storageService.getModelLaunch({ chatId: chat.value.id });
    if (isCurrentRoute.value && launch.value !== undefined && router !== undefined && chat.value !== null) {
      const { input, target } = launch.value;
      const history = router.options.history;
      try {
        history.replace(history.location, { ...history.state, [modelLaunchViewHistoryKey]: modelLaunchViewState({ chatId: chat.value.id, input, modelId: target.modelId, revision: target.selection.revision }) });
      } catch {
        // A history/quota failure must not discard an already usable Chat.
        // The coordinator handles the initial handoff; this refresh is optional.
      }
    }
  }
  watch([chat, () => resolved.value?.modelId, () => resolved.value?.endpoint.type, () => settings.value.storageType, isCurrentRoute, retry], async (_values, _previous, onCleanup) => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    synchronize();
    restoration.value = 'idle';
    const current = chat.value;
    const hint = view.value;
    if (launch.value !== undefined || current === null || hint === undefined || current.root.items.length > 0) return;
    const isStorageCurrent = storageService.captureModelLaunchStorage();
    restoration.value = 'checking';
    try {
      const target = await restoreModelLaunchTarget({ view: hint, signal: controller.signal });
      if (controller.signal.aborted || !isStorageCurrent()) return;
      const restored = await storageService.restoreModelLaunch({ chatId: current.id, input: hint.input, requestedVariant: parseRepository({ input: hint.input }).requestedVariant, target, signal: controller.signal });
      if (controller.signal.aborted || !isStorageCurrent()) return;
      if (restored === undefined) throw new Error('The model launch settings changed');
      launch.value = restored;
      restoration.value = 'idle';
    } catch {
      if (!controller.signal.aborted && isStorageCurrent()) restoration.value = 'failed';
    }
  }, { immediate: true });
  function retryRestoration(): void {
    retry.value++;
  }
  return {
    launch,
    view,
    isCurrentRoute,
    restoration,
    retryRestoration,
    synchronize,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}
export const TEST_ONLY = {
};
