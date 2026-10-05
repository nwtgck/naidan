import { computed, inject, ref, watch, type Ref } from 'vue';
import { routerKey, START_LOCATION } from 'vue-router';
import { resolveInitialRoute } from '@/logic/startup/startup-route';
import { toChatId } from '@/01-models/ids';
import { MODEL_LAUNCH_QUERY } from '@/features/llama-cpp-browser/model-launch/entry-state';

/** Presentation-only: never marks onboarding permanently complete. */
export function useModelLaunchOnboardingBypass({ initialized, storageType }: { initialized: Readonly<Ref<boolean>>, storageType: Readonly<Ref<string>> }): Readonly<Ref<boolean>> {
  const router = inject(routerKey, undefined);
  const restoredChatBypass = ref(false);
  const route = computed(() => router === undefined ? undefined : router.currentRoute.value === START_LOCATION ? resolveInitialRoute({ router }) : router.currentRoute.value);
  watch([route, initialized, storageType], async ([current, ready], _previous, onCleanup) => {
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });
    restoredChatBypass.value = false;
    if (!ready || current === undefined) return;
    const match = /^\/chat\/([A-Za-z0-9_-]+)$/.exec(current.path);
    if (match === null) return;
    // Avoid briefly presenting a blocking modal while the saved chat is read.
    restoredChatBypass.value = true;
    try {
      const { storageService } = await import('@/00-storage/service');
      const isStorageCurrent = storageService.captureModelLaunchStorage();
      const meta = await storageService.loadChatMeta({ id: toChatId({ raw: match[1]! }) });
      const chatGroup = meta?.groupId == null ? undefined : await storageService.loadChatGroup({ id: meta.groupId });
      const endpoint = meta?.endpoint ?? chatGroup?.endpoint;
      const modelId = meta?.modelId ?? chatGroup?.modelId;
      if (!cancelled && isStorageCurrent()) restoredChatBypass.value = endpoint?.type === 'llama_cpp_browser' && typeof modelId === 'string' && modelId.length > 0;
    } catch {
      if (!cancelled) restoredChatBypass.value = false;
    }
  }, { immediate: true });
  return computed(() => (route.value?.path === '/' && route.value.query[MODEL_LAUNCH_QUERY] !== undefined) || restoredChatBypass.value);
}
export const TEST_ONLY = {
};
