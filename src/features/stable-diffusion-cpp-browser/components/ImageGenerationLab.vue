<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { ImageIcon, FolderOpenIcon, HistoryIcon, SlidersHorizontalIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { useImageGeneration } from '@/features/stable-diffusion-cpp-browser/use-image-generation';
import { useImageBenchmark } from '@/features/stable-diffusion-cpp-browser/use-image-benchmark';
import type { BinaryObjectId, ImageGenerationId } from '@/01-models/ids';
import type { ImageGenerationRecord } from '@/01-models/image-generation-history';
import ImageGenerationHistory from './ImageGenerationHistory.vue';
import ImageGenerationEditor from './ImageGenerationEditor.vue';
import ImageGenerationResults from './ImageGenerationResults.vue';
import ImageRepositoryImport from './ImageRepositoryImport.vue';
import ImageModelCatalog from './ImageModelCatalog.vue';
import ImageModelPicker from './ImageModelPicker.vue';
import ImageSettingsSection from './ImageSettingsSection.vue';
import ImageBenchmark from './ImageBenchmark.vue';
const id = useId();
const view = useImageGeneration();
const benchmark = useImageBenchmark({ generation: view });
const activeTab = defineModel<'generate' | 'models' | 'history' | 'measure'>('tab', { default: 'generate' });
const benchmarkVisited = ref(false);
const historyVisited = ref(false);
watch([activeTab, view.history.available], ([tab, historyAvailable]) => {
  switch (tab) {
  case 'measure':
    benchmarkVisited.value = true;
    break;
  case 'history':
    historyVisited.value = true;
    // Returning to OPFS clears the old snapshot even if the tab did not change.
    // Only the visible history pane should start its replacement query.
    if (historyAvailable) void view.history.reload();
    break;
  case 'generate': case 'models': break;
  default: {
    const exhaustive: never = tab;
    throw new Error(String(exhaustive));
  }
  }
}, { immediate: true });
const tabs = computed(() => [
  { id: 'generate' as const, label: lazyStrings.stableDiffusionCppBrowser__generate(), icon: ImageIcon },
  { id: 'history' as const, label: lazyStrings.ImageGenerationLab__history(), icon: HistoryIcon },
  { id: 'models' as const, label: lazyStrings.ImageGenerationLab__models(), icon: FolderOpenIcon },
  { id: 'measure' as const, label: lazyStrings.imageBenchmark__diagnostics(), icon: SlidersHorizontalIcon },
]);
function openTab({ tab }: { tab: typeof activeTab.value }): void {
  activeTab.value = tab;
}
function tabKey({ event }: { event: KeyboardEvent }): void {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const index = tabs.value.findIndex(tab => tab.id === activeTab.value);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.value.length - 1 : (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + tabs.value.length) % tabs.value.length;
  const tab = tabs.value[next];
  if (tab) {
    openTab({ tab: tab.id });
    document.getElementById(id + '-tab-' + tab.id)?.focus();
  }
}
async function openHistory({ id }: { id: ImageGenerationId | undefined }): Promise<void> {
  openTab({ tab: 'history' });
  if (id) await view.history.select({ id });
}
async function reuseHistory({ record }: { record: ImageGenerationRecord }): Promise<void> {
  await view.reuseHistory({ record });
  if (!view.historyActions.error.value) openTab({ tab: 'generate' });
}
async function useHistoryImage({ binaryObjectId, role }: { binaryObjectId: BinaryObjectId, role: 'initial' | 'reference' }): Promise<void> {
  await view.useHistoryImage({ binaryObjectId, role });
  if (!view.historyActions.error.value) openTab({ tab: 'generate' });
}
const { library, busy, supported, formDisabled, debug, unavailable, files, loras, imageInputs, parameters, retainModel, modelResident, maxResults, weightResidency, gpuBudgetMiB, results, recommendation, applyRecommendedSettings, stopping, cancelled, cancel, forceCancel, generate } = view;
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: { benchmark, activeTab, files, loras, imageInputs, parameters, preview: view.preview, livePreview: view.livePreview, previewSnapshots: view.previewSnapshots, retainModel, modelResident, maxResults, maxPreviews: view.maxPreviews, weightResidency, gpuBudgetMiB, results, recommendation, applyRecommendedSettings, stopping, cancelled, cancel, forceCancel, generate } }) || {}) });
</script>
<template>
  <main tw-class="h-full overflow-y-auto bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100" data-testid="image-generation-lab">
    <div tw-class="max-w-[100rem] mx-auto p-4 sm:px-6 sm:py-5 space-y-5">
      <div tw-class="sticky top-0 z-30 -mx-4 -mt-4 space-y-2 border-b border-gray-200 dark:border-gray-800 bg-white/95 dark:bg-gray-900/95 px-4 pt-3 pb-2 shadow-sm backdrop-blur-sm sm:-mx-6 sm:-mt-5 sm:px-6 sm:pt-4" data-testid="image-lab-sticky-header">
        <header tw-class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 tw-class="text-lg font-bold tracking-tight text-gray-800 dark:text-white flex items-center gap-2">
            <ImageIcon tw-class="w-5 h-5 text-blue-600 dark:text-blue-400" />{{ lazyStrings.ImageGenerationLab__image_generation_entirely_in_browser() }}</h1>
        </header>
        <div tw-class="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div tw-class="min-w-0 w-full sm:flex-1">
            <div role="tablist" :aria-label="lazyStrings.stableDiffusionCppBrowser__image_generation_lab()" tw-class="flex gap-1 w-full overflow-x-auto border-b border-gray-200 dark:border-gray-800 pb-2" @keydown="tabKey({ event: $event })">
              <button v-for="tab in tabs" :key="tab.id" type="button" role="tab" :id="id + '-tab-' + tab.id" :aria-controls="id + '-panel-' + tab.id" :aria-selected="activeTab === tab.id" :tabindex="activeTab === tab.id ? 0 : -1" @click="openTab({ tab: tab.id })" :data-testid="'image-tab-' + tab.id" :tw-class="['flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2.5 text-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', activeTab === tab.id ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white font-medium' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/50']">
                <component :is="tab.icon" tw-class="w-4 h-4 shrink-0" />{{ tab.label }}<span v-if="(tab.id === 'measure' && benchmark.busy.value) || (tab.id === 'generate' && busy)" tw-class="w-1.5 h-1.5 rounded-full bg-blue-500" :aria-label="lazyStrings.imageBenchmark__running()" />
              </button>
            </div>
          </div>
          <!-- This switch configures generation requests; benchmark runs select their own debug setting. -->
          <label v-if="activeTab === 'generate'" :title="lazyStrings.stableDiffusionCppBrowser__debug_mode()" :tw-class="['self-end sm:self-auto shrink-0 min-h-10 inline-flex items-center gap-2 rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 px-3 py-1.5', formDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer']">
            <input v-model="debug" type="checkbox" role="switch" true-value="on" false-value="off" :disabled="formDisabled" data-testid="image-debug-mode" tw-class="sr-only peer" /><span aria-hidden="true" tw-class="relative h-6 w-10 shrink-0 rounded-full bg-gray-200 dark:bg-gray-700 transition-colors peer-checked:bg-blue-600 peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-offset-gray-900 peer-disabled:opacity-40 peer-disabled:cursor-not-allowed after:content-[''] after:absolute after:top-1 after:left-1 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-4 motion-reduce:transition-none motion-reduce:after:transition-none" />
            <span tw-class="flex flex-col leading-tight"><span tw-class="text-xs font-bold text-gray-700 dark:text-gray-200">{{ lazyStrings.ImageGenerationLab__debug() }}</span><span tw-class="text-[10px] text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationLab__record_detailed_logs() }}</span></span>
          </label>
        </div>
      </div>
      <p v-if="!supported" role="status" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 p-3 text-sm" data-testid="image-unavailable">{{ unavailable }}</p>
      <p v-if="view.historyActions.error.value" role="alert" tw-class="text-sm text-red-600 dark:text-red-400 break-words" data-testid="image-history-action-error">{{ view.historyActions.error.value }}</p>
      <div v-if="view.historyActions.missingInactiveFiles.value.length" role="status" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-2" data-testid="image-history-missing-inactive-files">
        <p tw-class="text-sm">{{ lazyStrings.ImageGenerationLab__disabled_loras_not_restored() }}</p>
        <ul tw-class="text-xs space-y-1 break-all">
          <li v-for="file in view.historyActions.missingInactiveFiles.value" :key="file">{{ file }}</li>
        </ul>
      </div>
      <div v-if="view.historyActions.missingFiles.value.length" tw-class="rounded-lg border border-amber-300 dark:border-amber-800 p-3 space-y-2" data-testid="image-history-missing-files">
        <p tw-class="text-sm">{{ lazyStrings.ImageGenerationLab__select_missing_files() }}</p>
        <ul tw-class="text-xs space-y-1 break-all">
          <li v-for="file in view.historyActions.missingFiles.value" :key="file">{{ file }}</li>
        </ul>
        <button type="button" @click="view.clearHistoryMissingFiles()" :disabled="view.historyActions.busy.value" tw-class="rounded-lg px-2.5 py-1.5 text-xs font-bold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">{{ lazyStrings.ImageGenerationLab__continue_without_missing_files() }}</button>
      </div>
      <div tw-class="space-y-6">
        <div tw-class="min-w-0 flex-1 w-full">
          <!-- Pane visibility must not own the form, generation, downloads, or result URLs. -->
          <div v-show="activeTab === 'generate'" role="tabpanel" :id="id + '-panel-generate'" :aria-labelledby="id + '-tab-generate'" tw-class="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] 2xl:grid-cols-[minmax(28rem,0.9fr)_minmax(0,1.1fr)] gap-6 xl:gap-10 items-start">
            <ImageGenerationEditor :view="view" :active="activeTab === 'generate'" @manage-models="openTab({ tab: 'models' })" />
            <div tw-class="min-w-0">
              <ImageGenerationResults :view="view" :active="activeTab === 'generate'" @open-history="openHistory" @prepare="openTab({ tab: 'models' })" />
            </div>
          </div>
          <div v-show="activeTab === 'models'" role="tabpanel" :id="id + '-panel-models'" :aria-labelledby="id + '-tab-models'" tw-class="space-y-4">
            <div tw-class="flex flex-wrap items-center justify-between gap-3">
              <div tw-class="space-y-1">
                <h2 tw-class="text-lg font-bold tracking-tight text-gray-800 dark:text-white">{{ lazyStrings.ImageGenerationLab__models() }}</h2>
                <p tw-class="text-sm text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationLab__prepare_models_help() }}</p>
              </div>
              <button type="button" @click="openTab({ tab: 'generate' })" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-xs font-bold text-gray-700 dark:text-gray-200 shadow-sm transition-colors hover:bg-gray-50 dark:hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" data-testid="image-return-to-generation">{{ lazyStrings.ImageGenerationLab__back_to_generation() }}</button>
            </div>
            <p v-if="library.failure.value" role="alert" tw-class="text-sm text-red-600 dark:text-red-400 break-words">{{ library.failure.value }}</p>
            <div v-if="library.scanState.value === 'scanning'" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-2" data-testid="image-models-scan-status">
              <div tw-class="flex flex-wrap items-center justify-between gap-2 text-xs">
                <p role="status">{{ lazyStrings.stableDiffusionCppBrowser__scanning_repositories() }} <span v-if="library.scanProgress.value?.total">{{ library.scanProgress.value.completed }} / {{ library.scanProgress.value.total }}</span></p>
                <button type="button" @click="library.cancelScan()" data-testid="image-models-cancel-scan" tw-class="rounded-lg px-2 py-1 text-xs font-bold text-blue-600 dark:text-blue-400 transition-colors hover:bg-blue-50 dark:hover:bg-blue-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.SHARED__cancel() }}</button>
              </div>
              <p v-if="library.scanProgress.value?.path" tw-class="text-xs text-gray-500 dark:text-gray-400 break-all">{{ library.scanProgress.value.path }}</p>
            </div>
            <ImageSettingsSection :title="lazyStrings.ImageGenerationLab__saved_models()" :summary="library.models.value.length.toString()" :open="true">
              <ImageModelPicker :empty-label="lazyStrings.ImageModelPicker__choose_a_model()" :active="activeTab === 'models'" :model-value="library.main.value" :choices="library.models.value" :disabled="formDisabled || library.importing.value || library.downloading.value || library.scanState.value === 'scanning'" :required="true" :label="lazyStrings.stableDiffusionCppBrowser__main_image_model()" @update:model-value="library.chooseMain({ id: $event })" data-testid="image-saved-main-model" />
            </ImageSettingsSection>
            <div tw-class="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(16rem,1fr)]">
              <ImageModelCatalog :disabled="formDisabled" :view="library" @selected="openTab({ tab: 'generate' })" />
              <ImageRepositoryImport :disabled="formDisabled" :view="library" />
            </div>
          </div>
          <div v-show="activeTab === 'history'" role="tabpanel" :id="id + '-panel-history'" :aria-labelledby="id + '-tab-history'" data-testid="image-history-workspace">
            <!-- Model transfers lock editor changes, while history browsing, deletion, and image downloads remain available. -->
            <ImageGenerationHistory v-if="historyVisited" :view="view.history" :active="activeTab === 'history'" :disabled="formDisabled || view.historyActions.busy.value" :editor-disabled="library.importing.value || library.downloading.value" @reuse="reuseHistory" @use-image="useHistoryImage" :on-download="view.downloadHistory" />
          </div>
          <div v-show="activeTab === 'measure'" role="tabpanel" :id="id + '-panel-measure'" :aria-labelledby="id + '-tab-measure'">
            <ImageBenchmark :active="activeTab === 'measure'" v-if="benchmarkVisited" :bench="benchmark" :generation="view" />
          </div>
        </div>
      </div>
    </div>
  </main>
</template>
