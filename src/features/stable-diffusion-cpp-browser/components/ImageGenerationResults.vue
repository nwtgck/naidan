<script setup lang="ts">
import { ref, watch } from 'vue';
import ImageSettingsSection from './ImageSettingsSection.vue';
import { ImageIcon, ImagesIcon } from 'lucide-vue-next';
import ImageGenerationViewer from './ImageGenerationViewer.vue';
import ImageDownloadMenu from './ImageDownloadMenu.vue';
import { lazyStrings } from '@/strings';
import type { ImageGenerationId } from '@/01-models/ids';
import type { ImageGenerationView } from '@/features/stable-diffusion-cpp-browser/use-image-generation-types';
import ImageGenerationPreview from './ImageGenerationPreview.vue';
const props = defineProps<{ view: ImageGenerationView, active: boolean }>();
const emit = defineEmits<{ openHistory: [value: { id: ImageGenerationId | undefined }], prepare: [] }>();
const saveHistory = props.view.historySaving.enabled;
const { maxResults, results, supported, removeResult, clearResults, diagnosticStatus, diagnosticText, diagnosticFeedback, copyDiagnostics, saveDiagnostics, failure } = props.view;
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
      <div tw-class="flex flex-wrap items-center justify-between gap-3">
        <h2 tw-class="text-lg font-semibold">{{ lazyStrings.stableDiffusionCppBrowser__generated_images() }}</h2>
        <button type="button" @click="emit('openHistory', { id: undefined })" data-testid="image-open-history" tw-class="ml-auto inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"><ImagesIcon aria-hidden="true" tw-class="w-4 h-4" />{{ lazyStrings.ImageGenerationLab__history() }}</button>

      </div>
      <div v-if="!results.length" tw-class="min-h-64 flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/20 p-8 text-center" data-testid="image-results-empty">
        <ImageIcon tw-class="w-10 h-10 text-gray-300 dark:text-gray-600" />
        <p tw-class="text-sm text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__no_images_yet() }}</p>
        <button v-if="!view.library.main.value && !view.files.value.model && !view.files.value.diffusion" type="button" @click="emit('prepare')" data-testid="image-results-prepare" tw-class="rounded-lg bg-purple-600 hover:bg-purple-700 text-white px-4 py-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-purple-500/30">{{ lazyStrings.ImageGenerationEditor__prepare_model() }}</button>
      </div>
      <div tw-class="grid grid-cols-2 gap-3">
        <article data-testid="image-generated-result" v-for="(result, index) in results" :key="result.id" :tw-class="['min-w-0 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden', index === 0 ? 'col-span-2' : '']">
          <button type="button" @click="viewerIndex = index" :aria-label="lazyStrings.ImageGenerationViewer__image_preview()" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 block w-full">
            <img :src="result.url" :alt="result.parameters.prompt" :width="result.parameters.width" :height="result.parameters.height" tw-class="w-full max-h-[65vh] object-contain bg-gray-50 dark:bg-gray-950" />
          </button>
          <div tw-class="p-4 space-y-2">
            <p v-if="result.uniformOutput" role="status" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.stableDiffusionCppBrowser__uniform_image_warning() }}</p>
            <p tw-class="text-sm line-clamp-2 break-words">{{ result.parameters.prompt }}</p>
            <p tw-class="text-xs text-gray-500">{{ result.modelVersion }} · {{ result.parameters.width }} × {{ result.parameters.height }} · {{ lazyStrings.stableDiffusionCppBrowser__seed() }}: {{ result.parameters.seed }} · {{ lazyStrings.stableDiffusionCppBrowser__generation_time() }} {{ formatElapsed({ elapsedMs: result.elapsedMs }) }}</p>
            <div tw-class="flex flex-wrap items-center gap-3 text-sm">
              <ImageDownloadMenu :active="active" :disabled="!supported" :on-download="options => view.downloadResult({ resultId: result.id, ...options })" data-testid="image-result-download" />
              <button v-if="view.savedHistoryId({ resultId: result.id })" type="button" :disabled="!view.history.available.value" @click="emit('openHistory', { id: view.savedHistoryId({ resultId: result.id }) })" data-testid="image-result-view-saved" tw-class="inline-flex items-center gap-1.5 text-xs text-purple-600 dark:text-purple-400 hover:rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 min-h-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 disabled:opacity-40"><ImagesIcon aria-hidden="true" tw-class="w-4 h-4" />{{ lazyStrings.ImageGenerationResults__view_in_my_images() }}</button>
              <button type="button" @click="removeResult({ resultId: result.id })" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 text-gray-500 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 min-h-10">{{ lazyStrings.stableDiffusionCppBrowser__remove() }}</button>
            </div>
          </div>
        </article>
      </div>
    </section>
    <ImageGenerationPreview :view="view" :active="active" :tw-class="view.busy.value ? 'order-first' : 'order-none'" />
    <section tw-class="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-2" data-testid="image-history-saving">
      <div tw-class="flex flex-wrap items-center gap-3 text-sm">
        <label tw-class="min-h-10 cursor-pointer inline-flex items-center gap-2">
          <input v-model="saveHistory" :disabled="!view.historySaving.supported.value" type="checkbox" role="switch" data-testid="image-save-history" tw-class="relative appearance-none h-5 w-9 shrink-0 cursor-pointer rounded-full bg-gray-300 dark:bg-gray-600 checked:bg-purple-600 dark:checked:bg-purple-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform checked:after:translate-x-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 disabled:opacity-40 disabled:cursor-not-allowed" />{{ lazyStrings.ImageGenerationResults__save_generation_history() }}</label>
      </div>
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
        <button type="button" @click="view.historySaving.retry()" :disabled="!view.historySaving.supported.value || view.historySaving.status.value === 'saving'" data-testid="image-history-retry-save" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 min-h-10 disabled:opacity-40">{{ lazyStrings.ImageGenerationResults__retry_saving() }}</button>
        <p v-if="!view.historySaving.supported.value" tw-class="w-full text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationResults__return_to_opfs_to_retry() }}</p>
      </div>
      <ImageSettingsSection embedded :title="lazyStrings.ImageGenerationResults__about_saved_history()" :summary="undefined">
        <p>{{ lazyStrings.ImageGenerationHistory__experimental_history_notice() }}</p>
        <p>{{ lazyStrings.ImageGenerationHistory__backup_does_not_include_history() }}</p>
      </ImageSettingsSection>
    </section>
    <ImageSettingsSection :title="lazyStrings.ImageGenerationResults__display_settings()" :summary="maxResults.toString()">
      <div tw-class="flex flex-wrap items-center gap-3 text-xs">
        <label tw-class="inline-flex gap-2 items-center">
          <span>{{ lazyStrings.ImageGenerationResults__images_kept_on_screen() }}</span>
          <input v-model.number="maxResults" :disabled="!supported" type="number" min="1" max="100" step="1" data-testid="image-result-limit" tw-class="outline-none focus:border-purple-400 focus:ring-4 focus:ring-purple-500/10 disabled:opacity-50 w-20 rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2" />
        </label>
        <button v-if="results.length" type="button" @click="clearResults" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 text-gray-500 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 min-h-10">{{ lazyStrings.stableDiffusionCppBrowser__clear_results() }}</button>
      </div>
    </ImageSettingsSection>
    <ImageSettingsSection :title="lazyStrings.stableDiffusionCppBrowser__diagnostics()" :summary="diagnosticStatus" data-testid="image-live-diagnostics">
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__debug_help() }}</p>
      <p v-if="diagnosticStatus" role="status" tw-class="text-xs font-mono break-words">{{ diagnosticStatus }}</p>
      <div tw-class="flex flex-wrap gap-3 text-sm">
        <button type="button" :disabled="!diagnosticText" @click="copyDiagnostics" data-testid="image-copy-diagnostics" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 min-h-10 disabled:opacity-40">{{ lazyStrings.stableDiffusionCppBrowser__copy_logs() }}</button>
        <button type="button" :disabled="!diagnosticText" @click="saveDiagnostics" data-testid="image-save-diagnostics" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 min-h-10 disabled:opacity-40">{{ lazyStrings.stableDiffusionCppBrowser__save_logs() }}</button>
        <span role="status" tw-class="text-xs">{{ diagnosticFeedback }}</span>
      </div>
      <details v-if="diagnosticText">
        <summary tw-class="text-xs cursor-pointer">{{ lazyStrings.stableDiffusionCppBrowser__show_logs() }}</summary>
        <pre tw-class="text-xs whitespace-pre-wrap break-all max-h-72 overflow-auto mt-2">{{ diagnosticText }}</pre>
      </details>
    </ImageSettingsSection>
    <details v-if="failure" open tw-class="rounded-xl border border-red-300 dark:border-red-800 p-4">
      <summary tw-class="font-medium">{{ lazyStrings.stableDiffusionCppBrowser__diagnostics() }}</summary>
      <pre role="alert" tw-class="text-xs whitespace-pre-wrap break-words mt-3 max-h-72 overflow-auto">{{ failure }}</pre>
    </details>
    <ImageGenerationViewer :download-enabled="true" v-if="viewerIndex !== undefined" v-model:index="viewerIndex" :count="results.length" @close="viewerIndex = undefined">
      <template #download><ImageDownloadMenu v-if="results[viewerIndex]" :key="results[viewerIndex]!.id" :active="active" :disabled="!supported" :on-download="options => view.downloadResult({ resultId: results[viewerIndex!]!.id, ...options })" /></template>
      <img v-if="results[viewerIndex]" :src="results[viewerIndex]!.url" :alt="results[viewerIndex]!.parameters.prompt" tw-class="max-w-full max-h-[85vh] object-contain" />
    </ImageGenerationViewer>
  </div>
</template>
