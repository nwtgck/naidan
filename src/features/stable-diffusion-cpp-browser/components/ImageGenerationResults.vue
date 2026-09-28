<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import ImageGenerationProgress from './ImageGenerationProgress.vue';
import ImageSettingsSection from './ImageSettingsSection.vue';
import { AlertCircleIcon, ChevronDownIcon, FolderOpenIcon, ImageIcon, ImagesIcon, SquareIcon } from 'lucide-vue-next';
import ImageGenerationViewer from './ImageGenerationViewer.vue';
import ImageDownloadMenu from './ImageDownloadMenu.vue';
import { lazyStrings } from '@/strings';
import type { ImageGenerationId } from '@/01-models/ids';
import type { ImageGenerationView } from '@/features/stable-diffusion-cpp-browser/use-image-generation-types';
import ImageGenerationPreview from './ImageGenerationPreview.vue';
import ImageEngineState from './ImageEngineState.vue';
const props = defineProps<{ view: ImageGenerationView, active: boolean }>();
const emit = defineEmits<{ openHistory: [value: { id: ImageGenerationId | undefined }], prepare: [] }>();
const saveHistory = props.view.historySaving.enabled;
const historyHelpOpen = ref(false);
const historyHelpId = useId();
const { maxResults, results, supported, clearResults, diagnosticStatus, diagnosticText, diagnosticFeedback, copyDiagnostics, saveDiagnostics, failure } = props.view;
// Typing a larger limit must not release images at an intermediate digit.
// Keep the draft across renders when another generated image arrives.
const resultLimitDraft = ref(String(maxResults.value));
watch(maxResults, value => {
  resultLimitDraft.value = String(value);
});
function editResultLimit({ event }: { event: Event }): void {
  if (event.target instanceof HTMLInputElement) resultLimitDraft.value = event.target.value;
}
function commitResultLimit({ event }: { event: Event }): void {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  if (Number.isFinite(input.valueAsNumber)) maxResults.value = Math.min(100, Math.max(1, Math.trunc(input.valueAsNumber)));
  resultLimitDraft.value = String(maxResults.value);
  input.value = resultLimitDraft.value;
}
const run = props.view.latestRun;
const currentResultArrived = computed(() => run.value?.status === 'succeeded');
const pendingImage = computed(() => props.view.busy.value && supported.value && run.value?.status === 'running');
const failedImage = computed(() => run.value?.status === 'failed');
const cancelledImage = computed(() => run.value?.status === 'cancelled');
const unfinishedImage = computed(() => failedImage.value || cancelledImage.value);
// Form validation/reuse may clear the general error without starting another
// run. Keep this card linked to the failure that produced it.
const displayedFailure = computed(() => {
  const current = run.value;
  if (!current) return failure.value;
  switch (current.status) {
  case 'failed': return current.failure;
  case 'running': case 'succeeded': case 'cancelled': return failure.value;
  default: { const exhaustive: never = current; throw new Error(String(exhaustive)); }
  }
});
const diagnosticsOpen = ref(false);
const diagnosticsRegion = ref<HTMLElement>();
async function showDiagnostics(): Promise<void> {
  diagnosticsOpen.value = true;
  await nextTick();
  diagnosticsRegion.value?.scrollIntoView({ block: 'start' });
  diagnosticsRegion.value?.focus({ preventScroll: true });
}
const viewerIndex = ref<number>();
watch(() => props.active, active => {
  if (!active) viewerIndex.value = undefined;
});
watch(() => props.view.historySaving.supported.value, () => {
  viewerIndex.value = undefined;
});
watch(results, (current, previous) => {
  if (viewerIndex.value === undefined) return;
  const selected = previous[viewerIndex.value];
  const nextIndex = current.findIndex(item => item.id === selected?.id);
  viewerIndex.value = nextIndex < 0 ? undefined : nextIndex;
});
function formatElapsed({ elapsedMs }: { elapsedMs: number }): string {
  return `${(elapsedMs / 1000).toFixed(elapsedMs >= 10000 ? 0 : 1)} s`;
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="min-w-0 flex flex-col gap-5" data-testid="image-results-workspace">
    <section tw-class="space-y-3">
      <div v-if="!results.length && !pendingImage && !unfinishedImage" tw-class="min-h-64 flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/20 p-8 text-center" data-testid="image-results-empty">
        <ImageIcon tw-class="w-10 h-10 text-gray-300 dark:text-gray-600" />
        <p tw-class="text-sm text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__no_images_yet() }}</p>
        <button v-if="!view.library.main.value && !view.files.value.model && !view.files.value.diffusion" type="button" @click="emit('prepare')" data-testid="image-results-prepare" tw-class="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 text-sm font-bold shadow-md shadow-blue-500/20 transition-all active:scale-[0.98] motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/30"><FolderOpenIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.ImageGenerationEditor__prepare_model() }}</button>
      </div>
      <div tw-class="grid grid-cols-2 gap-3" data-testid="image-result-grid">
        <article v-if="pendingImage && run" data-testid="image-pending-result" tw-class="col-span-2 min-w-0 bg-white dark:bg-gray-800/40 rounded-2xl border border-gray-100 dark:border-gray-800 overflow-hidden shadow-sm">
          <ImageGenerationProgress :busy="view.busy.value" :supported="supported" :active="active" :stopping="view.stopping.value" :progress="view.progress.value" :width="run.width" :height="run.height" :image="view.livePreview.value" />
        </article>
        <article v-if="unfinishedImage" :role="failedImage ? 'alert' : 'status'" :data-testid="failedImage ? 'image-failed-result' : 'image-cancelled-result'" tw-class="col-span-2 min-w-0 flex flex-col items-center gap-3 rounded-2xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 px-5 py-8 text-center">
          <AlertCircleIcon v-if="failedImage" aria-hidden="true" tw-class="h-8 w-8 text-gray-500 dark:text-gray-400" />
          <SquareIcon v-else aria-hidden="true" tw-class="h-8 w-8 text-gray-500 dark:text-gray-400" />
          <p tw-class="text-sm font-bold text-gray-800 dark:text-gray-100">{{ failedImage ? lazyStrings.ImageGenerationResults__image_generation_failed() : lazyStrings.stableDiffusionCppBrowser__cancelled() }}</p>
          <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationResults__no_final_image_was_created() }}</p>
          <button v-if="failedImage" type="button" @click="showDiagnostics" data-testid="image-failure-diagnostics" tw-class="inline-flex min-h-10 items-center justify-center rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-xs font-bold text-blue-600 dark:text-blue-400 shadow-sm transition-colors hover:bg-blue-50 dark:hover:bg-blue-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.ImageGenerationResults__view_diagnostics() }}</button>
        </article>
        <p v-if="unfinishedImage && results.length" data-testid="image-previous-results" tw-class="col-span-2 text-xs font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationResults__previous_results() }}</p>
        <article data-testid="image-generated-result" v-for="(result, index) in results" :key="result.id" :tw-class="['min-w-0 bg-white dark:bg-gray-800/40 rounded-2xl border border-gray-100 dark:border-gray-800 overflow-hidden shadow-sm', index === 0 && !pendingImage && !unfinishedImage ? 'col-span-2' : '']">
          <button type="button" @click="viewerIndex = index" :aria-label="lazyStrings.ImageGenerationViewer__image_preview()" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 block w-full">
            <div :style="{ aspectRatio: `${result.parameters.width} / ${result.parameters.height}`, maxWidth: `min(${result.parameters.width}px, ${65 * result.parameters.width / result.parameters.height}vh)` }" data-testid="image-result-canvas" tw-class="relative w-full mx-auto">
              <img :src="result.url" :alt="result.parameters.prompt" :width="result.parameters.width" :height="result.parameters.height" tw-class="absolute inset-0 w-full h-full object-contain bg-gray-50 dark:bg-gray-950" />
            </div>
          </button>
          <div tw-class="p-4 space-y-2">
            <p v-if="result.uniformOutput" role="status" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.stableDiffusionCppBrowser__uniform_image_warning() }}</p>
            <p tw-class="text-sm line-clamp-2 break-words">{{ result.parameters.prompt }}</p>
            <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ result.modelVersion }} · {{ result.parameters.width }} × {{ result.parameters.height }} · {{ lazyStrings.stableDiffusionCppBrowser__seed() }}: {{ result.parameters.seed }} · {{ lazyStrings.stableDiffusionCppBrowser__generation_time() }} {{ formatElapsed({ elapsedMs: result.elapsedMs }) }}</p>
            <div tw-class="flex flex-wrap items-center gap-3 text-sm">
              <!-- Exporting retained pixels does not depend on the selected inference profile. -->
              <ImageDownloadMenu :preferences="view.imageDownloadPreferences" :on-preferences-change="view.setImageDownloadPreferences" :active="active" :disabled="false" :on-download="options => view.downloadResult({ resultId: result.id, ...options })" data-testid="image-result-download" />
              <button v-if="view.savedHistoryId({ resultId: result.id })" type="button" :disabled="!view.history.available.value" @click="emit('openHistory', { id: view.savedHistoryId({ resultId: result.id }) })" data-testid="image-result-view-saved" tw-class="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 min-h-10 text-xs font-bold text-blue-600 dark:text-blue-400 shadow-sm transition-colors hover:border-blue-200 dark:hover:border-blue-900/50 hover:bg-blue-50 dark:hover:bg-blue-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"><ImagesIcon aria-hidden="true" tw-class="w-4 h-4" />{{ lazyStrings.ImageGenerationResults__view_in_my_images() }}</button>
            </div>
          </div>
        </article>
      </div>
    </section>
    <ImageGenerationPreview :view="view" :active="active" :live-placement="pendingImage || currentResultArrived ? 'result' : 'panel'" />
    <section tw-class="rounded-2xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 px-3" data-testid="image-history-saving">
      <div tw-class="flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-1.5">
        <label tw-class="inline-flex min-h-10 cursor-pointer items-center gap-2 text-xs font-medium leading-tight">
          <input v-model="saveHistory" :disabled="view.busy.value || !view.historySaving.supported.value" type="checkbox" role="switch" data-testid="image-save-history" tw-class="sr-only peer" /><span aria-hidden="true" tw-class="relative h-6 w-10 shrink-0 rounded-full bg-gray-200 dark:bg-gray-700 transition-colors peer-checked:bg-blue-600 peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-offset-gray-900 peer-disabled:opacity-40 peer-disabled:cursor-not-allowed after:content-[''] after:absolute after:top-1 after:left-1 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-4 motion-reduce:transition-none motion-reduce:after:transition-none" /><span>{{ lazyStrings.ImageGenerationResults__save_generation_history() }}</span></label>
        <button type="button" :aria-expanded="historyHelpOpen" :aria-controls="historyHelpId" data-testid="image-history-help-toggle" @click="historyHelpOpen = !historyHelpOpen" tw-class="inline-flex min-h-10 items-center self-center gap-1.5 rounded-lg px-2 text-xs font-medium leading-tight text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
          {{ lazyStrings.ImageGenerationResults__about_saved_history() }}
          <ChevronDownIcon aria-hidden="true" :tw-class="['h-4 w-4 transition-transform motion-reduce:transition-none', historyHelpOpen ? 'rotate-180' : '']" />
        </button>
      </div>
      <div v-show="historyHelpOpen || !view.historySaving.supported.value || view.historySaving.status.value !== 'idle' || view.historySaving.pendingCount.value > 0" tw-class="space-y-2 px-1 pt-2 pb-3">
        <p v-if="!view.historySaving.supported.value" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationHistory__opfs_required() }}</p>
        <h3 v-if="view.historySaving.status.value === 'saved' || view.historySaving.status.value === 'failed'" tw-class="text-xs font-medium">{{ lazyStrings.ImageGenerationResults__latest_generation() }}</h3>
        <p v-if="view.historySaving.status.value === 'saving'" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationResults__saving_history() }}</p>
        <p v-if="view.historySaving.status.value === 'saved'" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationResults__saved_to_history() }}</p>
        <div v-if="view.historySaving.status.value === 'failed'" role="alert" tw-class="text-xs text-amber-700 dark:text-amber-300 space-y-2" data-testid="image-history-save-failed">
          <p>{{ lazyStrings.ImageGenerationResults__history_save_failed_download_image() }}</p>
          <p tw-class="break-words">{{ view.historySaving.error.value }}</p>
        </div>
        <div v-if="view.historySaving.pendingCount.value > 0" tw-class="flex flex-wrap items-center gap-2 text-xs" data-testid="image-history-pending-saves">
          <span>{{ lazyStrings.ImageGenerationResults__unsaved_generations() }}: {{ view.historySaving.pendingCount.value }}</span>
          <button type="button" @click="view.historySaving.retry()" :disabled="!view.historySaving.supported.value || view.historySaving.status.value === 'saving'" data-testid="image-history-retry-save" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-xs font-bold text-blue-600 dark:text-blue-400 shadow-sm transition-colors hover:border-blue-200 dark:hover:border-blue-900/50 hover:bg-blue-50 dark:hover:bg-blue-900/20 min-h-10 disabled:opacity-40 disabled:cursor-not-allowed">{{ lazyStrings.ImageGenerationResults__retry_saving() }}</button>
          <p v-if="!view.historySaving.supported.value" tw-class="w-full text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationResults__return_to_opfs_to_retry() }}</p>
        </div>
        <div :id="historyHelpId" v-show="historyHelpOpen" :inert="historyHelpOpen ? undefined : true" tw-class="space-y-1 border-t border-gray-200 dark:border-gray-700 pt-3 pb-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
          <p>{{ lazyStrings.ImageGenerationHistory__experimental_history_notice() }}</p>
          <p>{{ lazyStrings.ImageGenerationHistory__backup_does_not_include_history() }}</p>
        </div>
      </div>
    </section>
    <ImageSettingsSection :title="lazyStrings.ImageGenerationResults__display_settings()" :summary="maxResults.toString()">
      <div tw-class="flex flex-wrap items-center gap-3 text-xs">
        <label tw-class="inline-flex gap-2 items-center">
          <span>{{ lazyStrings.ImageGenerationResults__images_kept_on_screen() }}</span>
          <input :value="resultLimitDraft" @input="editResultLimit({ event: $event })" @change="commitResultLimit({ event: $event })" :disabled="!supported" type="number" min="1" max="100" step="1" data-testid="image-result-limit" tw-class="outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 w-20 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2 text-gray-800 dark:text-gray-100 shadow-sm" />
        </label>
        <button v-if="results.length" type="button" @click="clearResults" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 text-red-600 dark:text-red-400 font-bold rounded-xl border border-red-100 dark:border-red-900/30 bg-red-50/40 dark:bg-red-900/10 px-3 py-2 hover:border-red-200 dark:hover:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors min-h-10">{{ lazyStrings.stableDiffusionCppBrowser__clear_results() }}</button>
      </div>
    </ImageSettingsSection>
    <ImageEngineState :view="view" :active="active" />
    <div ref="diagnosticsRegion" tabindex="-1" data-testid="image-diagnostics-region" tw-class="space-y-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-2xl">
      <ImageSettingsSection v-model:open="diagnosticsOpen" :title="lazyStrings.stableDiffusionCppBrowser__diagnostics()" :summary="diagnosticStatus" data-testid="image-live-diagnostics">
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__debug_help() }}</p>
        <p v-if="diagnosticStatus" role="status" tw-class="text-xs font-mono break-words">{{ diagnosticStatus }}</p>
        <div tw-class="flex flex-wrap gap-3 text-sm">
          <button type="button" :disabled="!diagnosticText" @click="copyDiagnostics" data-testid="image-copy-diagnostics" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 min-h-10 disabled:opacity-40">{{ lazyStrings.stableDiffusionCppBrowser__copy_logs() }}</button>
          <button type="button" :disabled="!diagnosticText" @click="saveDiagnostics" data-testid="image-save-diagnostics" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 min-h-10 disabled:opacity-40">{{ lazyStrings.stableDiffusionCppBrowser__save_logs() }}</button>
          <span role="status" tw-class="text-xs">{{ diagnosticFeedback }}</span>
        </div>
        <details v-if="diagnosticText">
          <summary tw-class="text-xs cursor-pointer">{{ lazyStrings.stableDiffusionCppBrowser__show_logs() }}</summary>
          <pre tw-class="text-xs whitespace-pre-wrap break-all max-h-72 overflow-auto mt-2">{{ diagnosticText }}</pre>
        </details>
      </ImageSettingsSection>
      <details v-if="displayedFailure" open tw-class="rounded-xl border border-red-300 dark:border-red-800 p-4">
        <summary tw-class="font-medium">{{ lazyStrings.stableDiffusionCppBrowser__diagnostics() }}</summary>
        <pre role="alert" tw-class="text-xs whitespace-pre-wrap break-words mt-3 max-h-72 overflow-auto">{{ displayedFailure }}</pre>
      </details>
    </div>
    <ImageGenerationViewer :download-enabled="true" v-if="viewerIndex !== undefined" v-model:index="viewerIndex" :count="results.length" @close="viewerIndex = undefined">
      <template #download><ImageDownloadMenu :preferences="view.imageDownloadPreferences" :on-preferences-change="view.setImageDownloadPreferences" v-if="results[viewerIndex]" :key="results[viewerIndex]!.id" :active="active" :disabled="false" :on-download="options => view.downloadResult({ resultId: results[viewerIndex!]!.id, ...options })" /></template>
      <img v-if="results[viewerIndex]" :src="results[viewerIndex]!.url" :alt="results[viewerIndex]!.parameters.prompt" tw-class="max-w-full max-h-[85vh] object-contain" />
    </ImageGenerationViewer>
  </div>
</template>
