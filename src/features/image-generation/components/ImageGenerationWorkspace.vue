<script setup lang="ts">
import ImagePendingRuns from './ImagePendingRuns.vue';
import { computed, defineAsyncComponent, onScopeDispose, ref, useId, watch } from 'vue';
import { useElementSize } from '@vueuse/core';
import { onBeforeRouteLeave } from 'vue-router';
import { RefreshCwIcon, MessageSquareIcon, DownloadIcon, InfoIcon } from 'lucide-vue-next';
import { useConfirm } from '@/composables/useConfirm';
import { storageService } from '@/00-storage/service';
import { idToRaw, type ImageGenerationSessionId } from '@/01-models/ids';
import { IMAGE_GENERATION_MAX_RUN_IMAGES } from '@/01-models/image-generation';
import { ensureStrings, lazyStrings } from '@/strings';
import { downloadReadableStream } from '@/utils/stream-download';
import type { ImageGenerationView } from '@/features/image-generation/use-image-generation-types';
import { useImageGenerationWorkspace } from '@/features/image-generation/composables/use-image-generation-workspace';
import { registerImageGenerationNavigation } from '@/features/image-generation/session/navigation';
import { createImageGenerationArchive } from '@/features/image-generation/session/export';
import ImageGenerationEditor from './ImageGenerationEditor.vue';
import ImageGenerationResults from './ImageGenerationResults.vue';
import ImageGenerationGallery from './ImageGenerationGallery.vue';
import ImageGenerationAssetViewer from './ImageGenerationAssetViewer.vue';
import ImageSettingsSection from './ImageSettingsSection.vue';
import ImageGenerationDebugToggle from './ImageGenerationDebugToggle.vue';
import ImageGenerationMonitor from './ImageGenerationMonitor.vue';
const ImageGenerationTranslationButton = defineAsyncComponent(() => import('./ImageGenerationTranslationButton.vue'));
const ImageGenerationAssistant = defineAsyncComponent(() => import('./ImageGenerationAssistant.vue'));
const props = defineProps<{ generation: ImageGenerationView, active: boolean, sessionId?: ImageGenerationSessionId }>();
const emit = defineEmits<{ models: [], diagnostics: [], workspace: [] }>();
const requestedSessionId = computed(() => props.sessionId);
const view = useImageGenerationWorkspace({ generation: props.generation, requestedSessionId });
// Keep only the latest deep-link request while an earlier restore is settling.
let pendingSession: { id: ImageGenerationSessionId } | undefined;
watch(requestedSessionId, id => {
  pendingSession = id ? { id } : undefined;
  void drainSessionRoute();
}, { immediate: true });
watch([view.initialized, view.busy], () => {
  void drainSessionRoute();
});
async function drainSessionRoute(): Promise<void> {
  if (!view.initialized.value || view.busy.value || !pendingSession) return;
  const request = pendingSession; pendingSession = undefined;
  await view.selectSession({ sessionId: request.id });
}
const { count } = view;
const countHelpOpen = ref(false);
const container = ref<HTMLElement>();
const { width } = useElementSize(container);
const assistantPresentation = computed(() => view.assistantLayout.value === 'docked' && width.value >= 960 ? 'docked' as const : 'floating' as const);
const assistantOpen = computed(() => view.assistantVisibility.value === 'open');
const inputId = useId(), exporting = ref(false), exportFailure = ref('');
const assistantVisited = ref(false);
watch(assistantOpen, value => {
  if (value) assistantVisited.value = true;
}, { immediate: true });
async function setAssistantOpen({ open }: { open: boolean }): Promise<void> {
  await view.updatePreferences({ change: { type: 'assistant-visibility', visibility: open ? 'open' : 'closed' } });
}
const { showConfirm } = useConfirm();
let exportAbort: AbortController | undefined;
const unregister = registerImageGenerationNavigation({ navigation: { view, openModels: () => emit('models'), openDiagnostics: () => emit('diagnostics'), openGeneration: () => emit('workspace') } });
const draftLabel = computed(() => {
  switch (view.draftStatus.value) {
  case 'saved': return lazyStrings.imageGeneration__draft_saved();
  case 'dirty': return lazyStrings.imageGeneration__draft_dirty();
  case 'saving': return lazyStrings.imageGeneration__draft_saving();
  case 'failed': return lazyStrings.imageGeneration__draft_failed();
  default: { const exhaustive: never = view.draftStatus.value; throw new Error(String(exhaustive)); }
  }
});
function editCount({ event }: { event: Event }): void {
  if (!(event.target instanceof HTMLInputElement)) return;
  const value = event.target.valueAsNumber;
  if (Number.isInteger(value) && value >= 1 && value <= IMAGE_GENERATION_MAX_RUN_IMAGES) count.value = value;
  event.target.value = String(count.value);
}
async function exportSession(): Promise<void> {
  const store = view.store.value, session = view.currentSession.value;
  if (!store || !session || exporting.value || props.generation.busy.value) return;
  if (!await showConfirm({ title: await ensureStrings.imageGeneration__export_session(), message: await ensureStrings.imageGeneration__export_notice() })) return;
  if (view.store.value?.storeId !== store.storeId || view.selectedSessionId.value !== session.id) return;
  exporting.value = true; exportFailure.value = '';
  const abort = new AbortController(); exportAbort = abort;
  try {
    if (!await view.flushDraft()) throw new Error(await ensureStrings.imageGeneration__saving_required());
    const snapshot = await storageService.captureImageGenerationExport({ store, sessionId: session.id });
    abort.signal.throwIfAborted();
    const archive = createImageGenerationArchive({ snapshot, exportedAt: Date.now() });
    await downloadReadableStream({ stream: archive.stream, filename: `naidan-session-${idToRaw({ id: session.id })}.zip`, size: undefined, signal: abort.signal });
    await archive.completed;
  } catch (error) {
    exportFailure.value = abort.signal.aborted ? await ensureStrings.imageGeneration__export_cancelled() : error instanceof Error ? error.message : String(error);
  } finally {
    if (exportAbort === abort) {
      exportAbort = undefined; exporting.value = false;
    }
  }
}
const unsafeToLeave = computed(() => props.generation.busy.value || view.hasPendingSave.value || exporting.value || view.draftStatus.value !== 'saved');
onBeforeRouteLeave(async to => {
  // All nested model, diagnostic and session locations share this runtime owner.
  if (to.matched.some(record => record.path === '/image-generation')) return true;
  await view.flushDraft();
  return !unsafeToLeave.value || await showConfirm({ message: await ensureStrings.imageGeneration__leave_warning() });
});
function beforeUnload({ event }: { event: BeforeUnloadEvent }): void {
  if (unsafeToLeave.value) event.preventDefault();
}
// eslint-disable-next-line local-rules-named-args/require-named-args -- DOM EventListener callback signature is external.
const onUnload = (event: BeforeUnloadEvent) => beforeUnload({ event });
window.addEventListener('beforeunload', onUnload);
onScopeDispose(() => {
  unregister(); exportAbort?.abort(); window.removeEventListener('beforeunload', onUnload);
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: { view, assistantOpen } }) || {}) });
</script>
<template>
  <section ref="container" tw-class="flex h-full min-h-0 min-w-0 text-gray-800 dark:text-gray-100" data-testid="image-generation">
    <div tw-class="min-w-0 flex-1 overflow-y-auto overflow-x-hidden @container/workspace" data-testid="workspace-scroll">
      <div tw-class="p-4 sm:p-5 space-y-3">
        <header tw-class="flex flex-wrap items-center justify-between gap-2">
          <div tw-class="min-w-0"><h2 tw-class="text-base font-bold tracking-tight truncate">{{ view.currentSession.value?.title || lazyStrings.imageGeneration__new_session() }}</h2><p v-if="view.currentSession.value" role="status" tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ draftLabel }}</p></div>
          <div tw-class="flex items-center flex-wrap gap-1.5">
            <button type="button" @click="view.reload" :disabled="view.busy.value || view.loading.value" :title="lazyStrings.imageGeneration__refresh()" :aria-label="lazyStrings.imageGeneration__refresh()" tw-class="min-h-8 min-w-8 rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><RefreshCwIcon tw-class="w-4 h-4" /></button>
            <button type="button" @click="exportSession" :disabled="!view.currentSession.value || view.busy.value || generation.busy.value || view.hasPendingSave.value || exporting" tw-class="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><DownloadIcon tw-class="w-3.5 h-3.5" />{{ exporting ? lazyStrings.imageGeneration__exporting() : lazyStrings.imageGeneration__export_session() }}</button>
            <button v-if="exporting" type="button" @click="exportAbort?.abort()" tw-class="min-h-8 px-2 py-1.5 rounded-lg text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">{{ lazyStrings.SHARED__cancel() }}</button>
            <button type="button" @click="setAssistantOpen({ open: !assistantOpen })" :disabled="view.busy.value" data-testid="workspace-open-chat" :aria-expanded="assistantOpen" :aria-controls="inputId + '-assistant'" :tw-class="['inline-flex min-h-8 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', assistantOpen ? 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800']"><MessageSquareIcon tw-class="w-3.5 h-3.5" />{{ assistantOpen ? lazyStrings.imageGeneration__close_chat() : view.currentSession.value?.assistantChatId ? lazyStrings.imageGeneration__show_connected_chat() : lazyStrings.imageGeneration__open_assistant_chat() }}</button>
          </div>
        </header>
        <p v-if="!view.available.value" role="status" tw-class="rounded-xl border border-amber-200 dark:border-amber-900 p-3 text-xs text-amber-800 dark:text-amber-300">{{ lazyStrings.imageGeneration__storage_required() }}</p>
        <button v-if="view.storageUnavailable.value" type="button" :disabled="view.busy.value || generation.busy.value" @click="view.useTemporary" data-testid="workspace-use-temporary" tw-class="rounded-lg border border-amber-300 dark:border-amber-800 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 disabled:opacity-40">{{ lazyStrings.ImageGenerationWorkspace__generate_without_saving() }}</button>
        <p v-if="view.failure.value || exportFailure" role="alert" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ view.failure.value || exportFailure }}</p>
        <div v-if="view.warnings.value.length" tw-class="rounded-xl border border-amber-200 dark:border-amber-900 p-3 text-xs text-amber-800 dark:text-amber-300"><p v-for="warning in view.warnings.value" :key="warning" tw-class="break-words">{{ warning }}</p></div>
        <div v-if="view.draftStatus.value === 'failed'" role="alert" tw-class="rounded-xl border border-amber-200 dark:border-amber-900 p-3 text-xs space-y-2"><p tw-class="break-words">{{ view.draftFailure.value }}</p><button type="button" @click="view.saveDraft" tw-class="text-blue-600 dark:text-blue-400 font-semibold rounded-lg px-2 py-1 hover:bg-blue-50 dark:hover:bg-blue-900/20">{{ lazyStrings.imageGeneration__save_retry() }}</button></div>
        <div tw-class="grid grid-cols-1 @min-[42rem]/workspace:grid-cols-[minmax(18rem,0.85fr)_minmax(0,1.15fr)] gap-5 min-w-0 items-start" data-testid="workspace-columns">
          <div tw-class="min-w-0 space-y-3" data-testid="workspace-settings-column">
            <div tw-class="rounded-xl border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs">
              <div tw-class="flex flex-wrap items-center gap-2">
                <label :for="inputId + '-count'" tw-class="text-xs font-medium">{{ lazyStrings.imageGeneration__images() }}</label>
                <input :id="inputId + '-count'" :value="view.available.value ? count : 1" @change="editCount({ event: $event })" type="number" min="1" :max="IMAGE_GENERATION_MAX_RUN_IMAGES" step="1" :disabled="view.editor.formDisabled.value || !view.available.value" data-testid="workspace-image-count" tw-class="w-16 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-40" />
                <button type="button" @click="countHelpOpen = !countHelpOpen" :aria-expanded="countHelpOpen" :aria-controls="inputId + '-count-help'" :title="lazyStrings.imageGeneration__count_help()" :aria-label="lazyStrings.imageGeneration__count_help()" data-testid="workspace-count-help-toggle" tw-class="min-h-8 min-w-8 rounded-lg p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><InfoIcon aria-hidden="true" tw-class="w-4 h-4" /></button>
                <div tw-class="ml-auto shrink-0"><ImageGenerationDebugToggle :view="view.editor" /></div>
              </div>
              <p v-if="countHelpOpen" :id="inputId + '-count-help'" tw-class="mt-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__count_help() }}</p>
            </div>
            <p v-if="!view.editorReady.value" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__viewing_other() }}</p>
            <ImageGenerationEditor :view="view.editor" :active="active" @manage-models="emit('models')"><template #prompt-actions="{ field, text }"><ImageGenerationTranslationButton :workspace="view" :text="text" :field="field" :active="active" /></template></ImageGenerationEditor>
            <ImageSettingsSection :open="!!generation.failure.value || !view.available.value" :title="lazyStrings.imageGeneration__more_execution()" :summary="undefined" compact>
              <ImageGenerationResults :view="generation" :active="active" :presentation="view.available.value ? 'settings' : 'full'" persistence="workspace" @prepare="emit('models')" />
            </ImageSettingsSection>
          </div>
          <!-- One independent right column: gallery follows the preview immediately,
           regardless of how many model/parameter sections are open on the left. -->
          <div tw-class="min-w-0 space-y-3" data-testid="workspace-results-column">
            <ImagePendingRuns />
            <div data-testid="workspace-preview-column" tw-class="min-w-0"><ImageGenerationMonitor :workspace="view" :generation="generation" :active="active" :compact="false" /></div>
            <section v-if="view.experimentalNoticeVisible.value" role="status" data-testid="workspace-experimental-notice" tw-class="rounded-xl border border-blue-200 dark:border-blue-900 bg-blue-50/60 dark:bg-blue-950/20 px-3 py-2.5 text-xs space-y-1.5">
              <p tw-class="font-semibold text-blue-800 dark:text-blue-200">{{ lazyStrings.imageGeneration__notice_title() }}</p>
              <p tw-class="leading-relaxed text-gray-600 dark:text-gray-300">{{ lazyStrings.imageGeneration__notice_body() }}</p>
              <button type="button" @click="view.updatePreferences({ change: { type: 'dismiss-notice' } })" :disabled="view.busy.value" data-testid="workspace-dismiss-notice" tw-class="rounded-lg px-2 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/30 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.imageGeneration__notice_dismiss() }}</button>
            </section>
            <ImageGenerationGallery :view="view" />
          </div>
        </div>
      </div>
    </div>
    <ImageGenerationAssetViewer :view="view" :active="active" />
    <ImageGenerationAssistant v-if="assistantVisited" :id="inputId + '-assistant'" :workspace="view" :presentation="assistantPresentation" :active="active && assistantOpen" @close="setAssistantOpen({ open: false })" />
  </section>
</template>
