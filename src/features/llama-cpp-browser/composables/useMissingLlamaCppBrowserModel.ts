import { computed, onScopeDispose, ref, shallowRef, watch, type ComputedRef } from 'vue';
import type { Chat, Endpoint } from '@/01-models/types';
import type { ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import { storageService } from '@/00-storage/service';
import { useSettings } from '@/composables/useSettings';
import { scheduleIdleTask, type ScheduledIdleTask } from '@/utils/idle-task';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import { getDownloadQueue, jobIsBusy } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { selectionKey } from '@/features/llama-cpp-browser/hugging-face/download-plan';
import { installedSelection } from '@/features/llama-cpp-browser/hugging-face/storage';
import { readModelLaunchReference } from '@/features/llama-cpp-browser/model-launch/reference';
import { localModelAvailability, type ModelAvailability } from '@/features/llama-cpp-browser/model-recovery/availability';
import { resolveRecoveryDownload } from '@/features/llama-cpp-browser/model-recovery/download-target';

/** Ordinary-chat recovery, not model-link onboarding. Do not create/retarget
 * Chats or chat groups, write defaults/history, hide the composer, or warm up
 * the runtime. The effective Chat -> chat group -> Global settings own this. */
export function useMissingLlamaCppBrowserModel({ chat, resolved, enabled }: {
  chat: ComputedRef<Chat | null>, resolved: ComputedRef<{ endpoint: Endpoint, modelId: string | undefined } | undefined>, enabled: ComputedRef<boolean>,
}) {
  const { settings } = useSettings();
  const queue = getDownloadQueue();
  const modelId = computed(() => enabled.value && chat.value !== null && resolved.value?.endpoint.type === 'llama_cpp_browser' ? resolved.value.modelId : undefined);
  const context = computed(() => modelId.value === undefined ? undefined : JSON.stringify([chat.value?.id, modelId.value, settings.value.storageType]));
  const availability = ref<ModelAvailability | 'checking' | 'inactive'>('inactive');
  const verification = ref<'idle' | 'checking'>('idle');
  const operation = ref<'idle' | 'reviewing' | 'starting'>('idle');
  const target = shallowRef<ModelLaunchTarget>();
  const failure = ref(false);
  const reference = computed(() => readModelLaunchReference({ modelId: modelId.value }));
  const canDownload = computed(() => reference.value !== undefined);
  const job = computed(() => {
    const source = reference.value;
    if (source === undefined) return undefined;
    const matching = queue.jobs.value.filter(candidate => candidate.selection?.repository === source.repository
      && candidate.selection.files.some(file => file.path === source.mainFilePath));
    return matching.find(candidate => jobIsBusy({ job: candidate })) ?? matching.at(-1);
  });
  const busy = computed(() => operation.value !== 'idle' || jobIsBusy({ job: job.value }));
  const visible = computed(() => context.value !== undefined && (availability.value === 'missing' || availability.value === 'unreadable'));
  const maySend = computed(() => context.value === undefined || availability.value === 'available');
  let disposed = false;
  let generation = 0;
  let scheduled: ScheduledIdleTask | undefined;
  let actionController: AbortController | undefined;

  function refresh(): void {
    scheduled?.cancel();
    const current = context.value;
    const id = modelId.value;
    const request = ++generation;
    if (current === undefined || id === undefined) {
      availability.value = 'inactive'; verification.value = 'idle'; return;
    }
    const isStorageCurrent = storageService.captureModelLaunchStorage();
    verification.value = 'checking';
    // Yield to the Chat's initial paint. Never make navigation await disk IO or
    // initialize an inference Worker just to decide whether a notice is needed.
    scheduled = scheduleIdleTask({
      timeoutMs: 250,
      fallbackDelayMs: 0,
      task: async () => {
      const result = await localModelAvailability.check({ modelId: id });
      if (disposed || request !== generation || current !== context.value) return;
      if (!isStorageCurrent()) {
        availability.value = 'unreadable'; verification.value = 'idle'; target.value = undefined; return;
      }
      availability.value = result; verification.value = 'idle';
      switch (result) {
      case 'available': target.value = undefined; failure.value = false; break;
      case 'missing': case 'unreadable': break;
      default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
      }
    },
    });
  }
  watch(context, () => {
    actionController?.abort(); operation.value = 'idle'; target.value = undefined; failure.value = false;
    availability.value = context.value === undefined ? 'inactive' : 'checking';
    refresh();
  }, { immediate: true });
  watch(localModelAvailability.revision, refresh);
  // Queue.changed is a terminal transition, not each byte-progress update.
  watch(queue.changed, () => localModelAvailability.invalidate());
  const unsubscribeModels = llamaCppBrowserService.subscribeModelList({ listener: () => localModelAvailability.invalidate() });
  const unsubscribeState = llamaCppBrowserService.subscribe({
    listener: ({ state }) => {
    if (state.status === 'error' && state.code === 'missing-model') localModelAvailability.invalidate();
  },
  });
  function onFocus(): void {
    if (context.value !== undefined && document.visibilityState !== 'hidden') localModelAvailability.invalidate();
  }
  if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onFocus);
  function retry(): void {
    localModelAvailability.invalidate();
  }

  async function runAction({ kind }: { kind: 'review' | 'download' }): Promise<void> {
    const id = modelId.value;
    const current = context.value;
    if (id === undefined || current === undefined || availability.value !== 'missing' || !canDownload.value || busy.value || verification.value === 'checking') return;
    const isStorageCurrent = storageService.captureModelLaunchStorage();
    const controller = new AbortController(); actionController = controller;
    const isCurrent = () => !disposed && !controller.signal.aborted && current === context.value && isStorageCurrent();
    switch (kind) {
    case 'review': operation.value = 'reviewing'; break;
    case 'download': operation.value = 'starting'; break;
    default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
    }
    failure.value = false;
    try {
      switch (kind) {
      case 'review': {
        const plan = await resolveRecoveryDownload({ modelId: id, signal: controller.signal });
        if (isCurrent()) target.value = plan;
        return;
      }
      case 'download': break;
      default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
      }
      const plan = target.value ?? (job.value?.selection === undefined || reference.value === undefined ? undefined : {
        modelId: id,
        mainFilePath: reference.value.mainFilePath,
        selection: job.value.selection,
      });
      if (plan === undefined || plan.modelId !== id) return;
      // Another tab may have installed the same files since the notice appeared.
      // This check is after the explicit click and does not stall Chat opening.
      const installed = await installedSelection({ selection: plan.selection });
      if (!isCurrent()) return;
      if (installed?.id === id) {
        localModelAvailability.invalidate(); return;
      }
      const queued = queue.enqueue({ key: selectionKey({ selection: plan.selection }), repository: plan.selection.repository, source: 'repository', prepare: async () => plan.selection });
      // Once explicitly started, download lifetime belongs to the page queue,
      // not to this Chat. Completion never submits a draft or changes settings.
      void queued.done.then(() => localModelAvailability.invalidate());
    } catch {
      if (isCurrent()) failure.value = true;
    } finally {
      if (actionController === controller) {
        actionController = undefined; operation.value = 'idle';
      }
    }
  }
  function review(): Promise<void> {
    return runAction({ kind: 'review' });
  }
  function download(): Promise<void> {
    return runAction({ kind: 'download' });
  }
  onScopeDispose(() => {
    disposed = true; generation++; scheduled?.cancel(); actionController?.abort(); unsubscribeModels(); unsubscribeState();
    if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onFocus);
  });
  return {
    modelId,
    availability,
    verification,
    operation,
    target,
    failure,
    canDownload,
    job,
    busy,
    visible,
    maySend,
    retry,
    review,
    download,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}
export type MissingLlamaCppBrowserModelUi = ReturnType<typeof useMissingLlamaCppBrowserModel>;
export const TEST_ONLY = {
};
