import { computed, onScopeDispose, ref, watch, type ComputedRef } from 'vue';
import type { Chat, Endpoint } from '@/01-models/types';
import { storageService } from '@/00-storage/service';
import { useSettings } from '@/composables/useSettings';
import { scheduleIdleTask, type ScheduledIdleTask } from '@/utils/idle-task';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import { getDownloadQueue } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { localModelAvailability, type ModelAvailability } from '@/features/llama-cpp-browser/model-recovery/availability';

/** Ordinary-chat recovery, not model-link onboarding. Do not create/retarget
 * Chats or chat groups, write defaults/history, hide the composer, or warm up
 * the runtime. The effective Chat -> chat group -> Global settings own this. */
export function useMissingLlamaCppBrowserModel({ chat, resolved, enabled }: {
  chat: ComputedRef<Chat | null>, resolved: ComputedRef<{ endpoint: Endpoint, modelId: string | undefined } | undefined>, enabled: ComputedRef<boolean>,
}) {
  const { settings } = useSettings();
  const queue = getDownloadQueue();
  const modelId = computed(() => enabled.value && chat.value !== null && resolved.value?.endpoint.type === 'llama_cpp_browser' ? resolved.value.modelId || undefined : undefined);
  const context = computed(() => modelId.value === undefined ? undefined : JSON.stringify([chat.value?.id, modelId.value, settings.value.storageType]));
  const availability = ref<ModelAvailability | 'checking' | 'inactive'>('inactive');
  const visible = computed(() => context.value !== undefined && (availability.value === 'missing' || availability.value === 'unreadable'));
  const maySend = computed(() => context.value === undefined || availability.value === 'available');
  let disposed = false;
  let generation = 0;
  let scheduled: ScheduledIdleTask | undefined;

  function refresh(): void {
    scheduled?.cancel();
    const current = context.value;
    const id = modelId.value;
    const request = ++generation;
    if (current === undefined || id === undefined) {
      availability.value = 'inactive';
      return;
    }
    const isStorageCurrent = storageService.captureModelLaunchStorage();
    // Yield to the Chat's initial paint. Never make navigation await disk IO or
    // initialize an inference Worker just to decide whether a notice is needed.
    scheduled = scheduleIdleTask({
      timeoutMs: 250,
      fallbackDelayMs: 0,
      task: async () => {
        const result = await localModelAvailability.check({ modelId: id });
        if (disposed || request !== generation || current !== context.value) {
          return;
        }
        if (!isStorageCurrent()) {
          availability.value = 'unreadable';
          return;
        }
        availability.value = result;
      },
    });
  }
  watch(context, () => {
    availability.value = context.value === undefined ? 'inactive' : 'checking';
    refresh();
  }, { immediate: true });
  watch(localModelAvailability.revision, refresh);
  // Queue.changed is a terminal transition, not each byte-progress update.
  watch(queue.changed, () => localModelAvailability.invalidate());
  const unsubscribeModels = llamaCppBrowserService.subscribeModelList({ listener: () => localModelAvailability.invalidate() });
  const unsubscribeState = llamaCppBrowserService.subscribe({
    listener: ({ state }) => {
      if (state.status === 'error' && state.code === 'missing-model') {
        localModelAvailability.invalidate();
      }
    },
  });
  function onFocus(): void {
    if (context.value !== undefined && document.visibilityState !== 'hidden') {
      localModelAvailability.invalidate();
    }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onFocus);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onFocus);
  }
  function retry(): void {
    localModelAvailability.invalidate();
  }

  onScopeDispose(() => {
    disposed = true;
    generation++;
    scheduled?.cancel();
    unsubscribeModels();
    unsubscribeState();
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', onFocus);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onFocus);
    }
  });
  return {
    modelId,
    availability,
    visible,
    maySend,
    retry,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

export const TEST_ONLY = {
};
