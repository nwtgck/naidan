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
const resultsElement = ref<HTMLElement>();
function viewResult(): void {
  resultsElement.value?.scrollIntoView({ block: 'start' });
}
const benchmarkVisited = ref(false);
const historyVisited = ref(false);
watch(activeTab, tab => {
  switch (tab) {
  case 'measure':
    benchmarkVisited.value = true;
    break;
  case 'history':
    historyVisited.value = true;
    void view.history.reload();
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
const { library, busy, supported, formDisabled, unavailable, files, loras, imageInputs, parameters, retainModel, modelResident, maxResults, weightResidency, gpuBudgetMiB, results, recommendation, applyRecommendedSettings, stopping, cancelled, cancel, forceCancel, generate } = view;
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: { benchmark, activeTab, files, loras, imageInputs, parameters, preview: view.preview, livePreview: view.livePreview, previewSnapshots: view.previewSnapshots, retainModel, modelResident, maxResults, maxPreviews: view.maxPreviews, weightResidency, gpuBudgetMiB, results, recommendation, applyRecommendedSettings, stopping, cancelled, cancel, forceCancel, generate } }) || {}) });
</script>
<template>
  <main tw-class="h-full overflow-y-auto bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100" data-testid="image-generation-lab">
    <div tw-class="max-w-[100rem] mx-auto p-4 sm:px-6 sm:py-4 space-y-4">
      <header tw-class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 tw-class="text-lg font-semibold flex items-center gap-2">
          <ImageIcon tw-class="w-5 h-5" />{{ lazyStrings.stableDiffusionCppBrowser__image_generation_lab() }}</h1>
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__experimental_local_workspace() }}</p>
      </header>
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
        <button type="button" @click="view.clearHistoryMissingFiles()" :disabled="view.historyActions.busy.value" tw-class="text-xs underline disabled:opacity-40">{{ lazyStrings.ImageGenerationLab__continue_without_missing_files() }}</button>
      </div>
      <div tw-class="space-y-6">
        <div role="tablist" :aria-label="lazyStrings.stableDiffusionCppBrowser__image_generation_lab()" tw-class="flex gap-1 w-full overflow-x-auto border-b border-gray-200 dark:border-gray-800 pb-2" @keydown="tabKey({ event: $event })">
          <button v-for="tab in tabs" :key="tab.id" type="button" role="tab" :id="id + '-tab-' + tab.id" :aria-controls="id + '-panel-' + tab.id" :aria-selected="activeTab === tab.id" :tabindex="activeTab === tab.id ? 0 : -1" @click="openTab({ tab: tab.id })" :data-testid="'image-tab-' + tab.id" :tw-class="['flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2.5 text-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500', activeTab === tab.id ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white font-medium' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/50']">
            <component :is="tab.icon" tw-class="w-4 h-4 shrink-0" />{{ tab.label }}<span v-if="(tab.id === 'measure' && benchmark.busy.value) || (tab.id === 'generate' && busy)" tw-class="w-1.5 h-1.5 rounded-full bg-purple-500" :aria-label="lazyStrings.imageBenchmark__running()" />
          </button>
        </div>
        <div tw-class="min-w-0 flex-1 w-full">
          <!-- Pane visibility must not own the form, generation, downloads, or result URLs. -->
          <div v-show="activeTab === 'generate'" role="tabpanel" :id="id + '-panel-generate'" :aria-labelledby="id + '-tab-generate'" tw-class="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] 2xl:grid-cols-[minmax(28rem,0.9fr)_minmax(0,1.1fr)] gap-6 xl:gap-10 items-start">
            <ImageGenerationEditor :view="view" :active="activeTab === 'generate'" @manage-models="openTab({ tab: 'models' })" @view-result="viewResult" />
            <div ref="resultsElement" tw-class="min-w-0 scroll-mt-4">
              <ImageGenerationResults :view="view" :active="activeTab === 'generate'" @open-history="openHistory" @prepare="openTab({ tab: 'models' })" />
            </div>
          </div>
          <div v-show="activeTab === 'models'" role="tabpanel" :id="id + '-panel-models'" :aria-labelledby="id + '-tab-models'" tw-class="space-y-4">
            <div tw-class="flex flex-wrap items-center justify-between gap-3">
              <div tw-class="space-y-1">
                <h2 tw-class="font-semibold">{{ lazyStrings.ImageGenerationLab__models() }}</h2>
                <p tw-class="text-sm text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationLab__prepare_models_help() }}</p>
              </div>
              <button type="button" @click="openTab({ tab: 'generate' })" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm" data-testid="image-return-to-generation">{{ lazyStrings.ImageGenerationLab__back_to_generation() }}</button>
            </div>
            <p v-if="library.failure.value" role="alert" tw-class="text-sm text-red-600 dark:text-red-400 break-words">{{ library.failure.value }}</p>
            <div v-if="library.scanState.value === 'scanning'" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-2" data-testid="image-models-scan-status">
              <div tw-class="flex flex-wrap items-center justify-between gap-2 text-xs">
                <p role="status">{{ lazyStrings.stableDiffusionCppBrowser__scanning_repositories() }} <span v-if="library.scanProgress.value?.total">{{ library.scanProgress.value.completed }} / {{ library.scanProgress.value.total }}</span></p>
                <button type="button" @click="library.cancelScan()" data-testid="image-models-cancel-scan" tw-class="underline">{{ lazyStrings.SHARED__cancel() }}</button>
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
            <ImageGenerationHistory v-if="historyVisited" :view="view.history" :active="activeTab === 'history'" :disabled="formDisabled || view.historyActions.busy.value" @reuse="reuseHistory" @use-image="useHistoryImage" :on-download="view.downloadHistory" />
          </div>
          <div v-show="activeTab === 'measure'" role="tabpanel" :id="id + '-panel-measure'" :aria-labelledby="id + '-tab-measure'">
            <ImageBenchmark :active="activeTab === 'measure'" v-if="benchmarkVisited" :bench="benchmark" :generation="view" />
          </div>
        </div>
      </div>
    </div>
  </main>
</template>
