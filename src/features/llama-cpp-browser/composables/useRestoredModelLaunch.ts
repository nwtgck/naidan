import { computed, hasInjectionContext, inject, ref, shallowRef, watch, type ComputedRef } from 'vue';
import { routerKey } from 'vue-router';
import { idToRaw } from '@/01-models/ids';
import type { Chat, Endpoint } from '@/01-models/types';
import type { ChatModelLaunch } from '@/01-models/llama-cpp-browser-model-launch';
import { storageService } from '@/00-storage/service';
import { useSettings } from '@/composables/useSettings';
import { observeLegacyModelDownload, type ObservedLegacyModelDownload } from '@/features/llama-cpp-browser/model-launch/restore';

export function useRestoredModelLaunch({ chat, resolved }: {
  chat: ComputedRef<Chat | null>, resolved: ComputedRef<{ endpoint: Endpoint, modelId: string | undefined } | undefined>,
}) {
  const router = hasInjectionContext() ? inject(routerKey, undefined) : undefined;
  const { settings } = useSettings();
  const launch = shallowRef<ChatModelLaunch>();
  const observedDownload = shallowRef<ObservedLegacyModelDownload>();
  const restoration = ref<'idle' | 'checking' | 'failed'>('idle');
  const retry = ref(0);
  // Split panes may retain another empty Chat. Only the active route owns this
  // navigation context and permission to prepare the model speculatively.
  const isCurrentRoute = computed(() => router === undefined || (chat.value !== null
    && router.currentRoute.value.path === `/chat/${idToRaw({ id: chat.value.id })}`));
  function synchronize(): void {
    launch.value = chat.value === null ? undefined : storageService.getModelLaunch({ chatId: chat.value.id });
    if (launch.value !== undefined) {
      observedDownload.value = undefined;
    }
  }
  watch([chat, () => resolved.value?.modelId, () => resolved.value?.endpoint.type, () => settings.value.storageType, isCurrentRoute, retry], async (_values, _previous, onCleanup) => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    synchronize();
    observedDownload.value = undefined;
    restoration.value = 'idle';
    const current = chat.value;
    const binding = resolved.value;
    if (launch.value !== undefined || current === null || !isCurrentRoute.value || binding?.endpoint.type !== 'llama_cpp_browser'
      || !binding.modelId || current.root.items.length > 0) {
      return;
    }
    const isStorageCurrent = storageService.captureModelLaunchStorage();
    restoration.value = 'checking';
    try {
      const observed = await observeLegacyModelDownload({ modelId: binding.modelId, signal: controller.signal });
      if (controller.signal.aborted || !isStorageCurrent()) {
        return;
      }
      // Only a legacy aggregate journal explains the whole interrupted plan.
      // Modern per-file sidecars lack that plan: use ordinary Chat recovery,
      // never recreate the former Start/defaults/chat-group write authority.
      observedDownload.value = observed;
      restoration.value = 'idle';
    } catch {
      if (!controller.signal.aborted && isStorageCurrent()) {
        restoration.value = 'failed';
      }
    }
  }, { immediate: true });
  function retryRestoration(): void {
    retry.value++;
  }
  return {
    launch,
    observedDownload,
    isCurrentRoute,
    restoration,
    retryRestoration,
    synchronize,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

export const TEST_ONLY = {
};
