<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { lazyStrings } from '@/strings';
import { idToRaw } from '@/01-models/ids';
import type { BinaryObjectId } from '@/01-models/ids';
import type { ImageGenerationRecord } from '@/01-models/image-generation-history';
import type { ImageGenerationView } from '@/features/stable-diffusion-cpp-browser/use-image-generation-types';
import type { ImageGenerationHistoryView } from '@/features/stable-diffusion-cpp-browser/history-view';
import ImageSettingsSection from './ImageSettingsSection.vue';
import ImageGenerationViewer from './ImageGenerationViewer.vue';
import ImageDownloadMenu from './ImageDownloadMenu.vue';
import ImageHistoryImage from './ImageHistoryImage.vue';
const props = defineProps<{ view: ImageGenerationHistoryView, disabled: boolean, active: boolean, onDownload: ImageGenerationView['downloadHistory'] }>();
const emit = defineEmits<{
  reuse: [value: { record: ImageGenerationRecord }];
  useImage: [value: { binaryObjectId: BinaryObjectId, role: 'initial' | 'reference' }];
}>();
const { available, items, total, loading, error, warnings, warningCount, selected, detailLoading, detailError } = props.view;
const viewerIndex = ref<number>();
const deleteError = ref('');
watch(() => props.active && available.value, visible => {
  if (!visible) viewerIndex.value = undefined;
});
const viewerFrames = computed(() => selected.value ? [selected.value.result, ...selected.value.previews] : []);
const previewsOpen = ref(false);
watch(selected, () => {
  viewerIndex.value = undefined;
  previewsOpen.value = false;
  deleteError.value = '';
});
const search = ref(''), deleting = ref(false);
function searchChanged(): void {
  props.view.setQuery({ text: search.value });
}
function dateLabel({ timestamp }: { timestamp: number }): string {
  return new Date(timestamp).toLocaleString();
}
async function removeSelected(): Promise<void> {
  if (!selected.value || deleting.value || props.disabled) return;
  const id = selected.value.id;
  deleting.value = true;
  deleteError.value = '';
  try {
    await props.view.remove({ id });
  } catch (cause) {
    if (selected.value?.id === id) deleteError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    deleting.value = false;
  }
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="space-y-4" data-testid="image-generation-history">
    <header tw-class="space-y-2">
      <h2 tw-class="font-semibold">{{ lazyStrings.ImageGenerationLab__history() }}</h2>
    </header>
    <p v-if="!available" role="status" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 p-3 text-sm" data-testid="image-history-unavailable">{{ lazyStrings.ImageGenerationHistory__opfs_required() }}</p>
    <div tw-class="flex flex-wrap items-center gap-2">
      <label tw-class="min-w-0 flex-1 text-sm space-y-1">
        <span>{{ lazyStrings.ImageGenerationHistory__search_history() }}</span>
        <input v-model="search" @input="searchChanged" :disabled="!available" type="search" data-testid="image-history-search" tw-class="outline-none focus:border-purple-400 focus:ring-4 focus:ring-purple-500/10 disabled:opacity-50 block w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent p-2" />
      </label>
      <button type="button" @click="view.reload()" :disabled="!available || loading" data-testid="image-history-refresh" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 self-end rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm disabled:opacity-40">{{ lazyStrings.ImageGenerationHistory__refresh() }}</button>
    </div>
    <p v-if="error" role="alert" tw-class="text-sm text-red-600 dark:text-red-400 break-words">{{ error }}</p>
    <div v-if="available && warningCount > 0" role="status" tw-class="rounded-lg border border-amber-300 dark:border-amber-800 p-3 space-y-2 text-sm" data-testid="image-history-partial">
      <p>{{ lazyStrings.ImageGenerationHistory__some_history_files_could_not_be_read() }}</p>
      <p data-testid="image-history-readable-count">{{ lazyStrings.ImageGenerationHistory__readable_matches({ shown: items.length, total }) }}</p>
      <details v-if="warnings.length" tw-class="text-xs space-y-2">
        <summary tw-class="cursor-pointer">{{ lazyStrings.ImageGenerationHistory__read_warnings({ shown: warnings.length, total: warningCount }) }}</summary>
        <ul tw-class="space-y-2 break-words">
          <li v-for="(warning, index) in warnings" :key="index">
            <span tw-class="font-mono break-all">{{ warning.path }}</span>: {{ warning.message }}
          </li>
        </ul>
      </details>
    </div>
    <p v-if="loading" role="status" tw-class="text-sm text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationHistory__loading_history() }}</p>
    <p v-if="available && !loading && !error && !warningCount && !items.length" tw-class="rounded-lg border border-dashed border-gray-300 dark:border-gray-700 p-8 text-center text-sm text-gray-500 dark:text-gray-400" data-testid="image-history-empty">{{ lazyStrings.ImageGenerationHistory__no_history_found() }}</p>
    <div v-if="available" :tw-class="['items-start gap-6', selected ? 'grid lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.85fr)]' : 'block']">
      <div :tw-class="['grid gap-3 grid-cols-2', selected ? 'md:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3' : 'md:grid-cols-3 xl:grid-cols-5']">
        <button v-for="item in items" :key="idToRaw({ id: item.id })" type="button" @click="view.select({ id: item.id })" :aria-pressed="selected?.id === item.id" data-testid="image-history-item" :tw-class="['w-full overflow-hidden rounded-lg border text-left space-y-2 pb-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500', selected?.id === item.id ? 'border-purple-400 dark:border-purple-700 bg-purple-50/50 dark:bg-purple-950/20' : 'border-gray-200 dark:border-gray-700']">
          <ImageHistoryImage :binary-object-id="item.binaryObjectId" :alt="item.prompt" :get-image="view.getImage" thumbnail />
          <p tw-class="px-3 text-sm line-clamp-2 break-words">{{ item.prompt }}</p>
          <p tw-class="px-3 text-xs text-gray-500 dark:text-gray-400">{{ dateLabel({ timestamp: item.createdAt }) }} · {{ item.width }} × {{ item.height }}</p>
          <p tw-class="px-3 text-xs truncate text-gray-500 dark:text-gray-400" :title="item.modelName">{{ item.modelName }}</p>
        </button>
        <button v-if="items.length < total" @click="view.loadMore()" :disabled="loading" type="button" data-testid="image-history-more" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 col-span-full w-full rounded-lg border border-gray-200 dark:border-gray-700 p-3 text-sm disabled:opacity-40">{{ lazyStrings.ImageGenerationHistory__load_more() }}</button>
      </div>
      <div tw-class="min-w-0 space-y-4 lg:sticky lg:top-4">
        <p v-if="detailLoading" role="status" tw-class="text-sm">{{ lazyStrings.ImageGenerationHistory__loading_history() }}</p>
        <p v-if="detailError" role="alert" tw-class="text-sm text-red-600 dark:text-red-400 break-words">{{ detailError }}</p>
        <article v-if="selected" tw-class="space-y-4" data-testid="image-history-detail">
          <div tw-class="flex flex-wrap items-center justify-between gap-2">
            <h3 tw-class="text-sm font-medium">{{ dateLabel({ timestamp: selected.createdAt }) }}</h3>
            <button type="button" @click="view.clearSelection()" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 text-xs underline">{{ lazyStrings.ImageGenerationHistory__close_details() }}</button>
          </div>
          <button type="button" @click="viewerIndex = 0" :aria-label="lazyStrings.ImageGenerationViewer__image_preview()" data-testid="image-history-open-viewer" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 block w-full">
            <ImageHistoryImage :binary-object-id="selected.result.binaryObjectId" :alt="selected.request.parameters.prompt" :get-image="view.getImage" />
          </button>
          <div tw-class="flex flex-wrap gap-2 text-sm">
            <button type="button" @click="emit('reuse', { record: selected })" :disabled="disabled" data-testid="image-history-reuse" tw-class="min-h-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 disabled:opacity-40">{{ lazyStrings.ImageGenerationHistory__reuse_settings() }}</button>
            <button type="button" @click="emit('useImage', { binaryObjectId: selected.result.binaryObjectId, role: 'initial' })" :disabled="disabled" data-testid="image-history-use-initial" tw-class="min-h-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 disabled:opacity-40">{{ lazyStrings.ImageGenerationHistory__use_as_initial_image() }}</button>
            <button type="button" @click="emit('useImage', { binaryObjectId: selected.result.binaryObjectId, role: 'reference' })" :disabled="disabled" data-testid="image-history-use-reference" tw-class="min-h-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 disabled:opacity-40">{{ lazyStrings.ImageGenerationHistory__use_as_reference_image() }}</button>
          </div>
          <ImageDownloadMenu :key="idToRaw({ id: selected.id })" :active="active" :disabled="!available" :on-download="options => onDownload({ binaryObjectId: selected!.result.binaryObjectId, record: selected!, ...options })" data-testid="image-history-download" />
          <p tw-class="text-sm whitespace-pre-wrap break-words">{{ selected.request.parameters.prompt }}</p>
          <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ selected.result.width }} × {{ selected.result.height }} · {{ selected.result.modelVersion }} · {{ lazyStrings.ImageGenerationHistory__requested_seed() }}: {{ selected.request.parameters.seed }}</p>
          <dl tw-class="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
            <div>
              <dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__steps() }}</dt>
              <dd>{{ selected.request.parameters.steps }}</dd>
            </div>
            <div>
              <dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__guidance() }}</dt>
              <dd>{{ selected.request.parameters.guidance }}</dd>
            </div>
            <div>
              <dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__sampler() }}</dt>
              <dd>{{ selected.request.parameters.sampler }}</dd>
            </div>
            <div>
              <dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__scheduler() }}</dt>
              <dd>{{ selected.request.parameters.scheduler }}</dd>
            </div>
            <div>
              <dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__generation_time() }}</dt>
              <dd>{{ (selected.result.elapsedMs / 1000).toFixed(1) }} s</dd>
            </div>
            <div>
              <dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__bf16_weight_conversion() }}</dt>
              <dd>{{ selected.request.parameters.bf16WeightType.toUpperCase() }}</dd>
            </div>
          </dl>
          <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationHistory__reuse_does_not_download_models() }}</p>
          <ImageSettingsSection :title="lazyStrings.ImageGenerationHistory__requested_settings()" :summary="undefined">
            <pre tw-class="max-h-80 overflow-auto whitespace-pre-wrap break-words">{{ JSON.stringify(selected.request, undefined, 2) }}</pre>
          </ImageSettingsSection>
          <ImageSettingsSection v-if="selected.previews.length" v-model:open="previewsOpen" :title="lazyStrings.stableDiffusionCppBrowser__preview_title()" :summary="selected.previews.length.toString()" data-testid="image-history-previews">
            <div v-if="previewsOpen" tw-class="grid sm:grid-cols-2 gap-3">
              <figure v-for="(frame, index) in selected.previews" :key="idToRaw({ id: frame.binaryObjectId })" tw-class="space-y-2">
                <button type="button" @click="viewerIndex = index + 1" :aria-label="lazyStrings.ImageGenerationViewer__image_preview()" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 block w-full">
                  <ImageHistoryImage :binary-object-id="frame.binaryObjectId" :alt="selected.request.parameters.prompt" :get-image="view.getImage" />
                </button>
                <figcaption tw-class="text-xs">{{ frame.step }} / {{ frame.steps }} · {{ frame.mode }} · {{ frame.width }} × {{ frame.height }}</figcaption>
                <ImageDownloadMenu :active="active" :disabled="!available" :on-download="options => onDownload({ binaryObjectId: frame.binaryObjectId, record: selected!, ...options })" />
              </figure>
            </div>
          </ImageSettingsSection>
          <ImageSettingsSection :title="lazyStrings.ImageGenerationHistory__remove_from_history()" :summary="undefined">
            <p tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationHistory__removing_keeps_image_files() }}</p>
            <p v-if="deleteError" role="alert" data-testid="image-history-delete-error" tw-class="text-red-600 dark:text-red-400 break-words">{{ deleteError }}</p>
            <button type="button" @click="removeSelected" :disabled="disabled || deleting" data-testid="image-history-delete" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 rounded-lg border border-red-300 dark:border-red-800 px-3 py-2 text-red-600 dark:text-red-400 disabled:opacity-40">{{ lazyStrings.ImageGenerationHistory__remove_from_history() }}</button>
          </ImageSettingsSection>
        </article>
      </div>
    </div>
    <ImageSettingsSection :title="lazyStrings.ImageGenerationResults__about_saved_history()" :summary="undefined">
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationHistory__experimental_history_notice() }}</p>
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationHistory__backup_does_not_include_history() }}</p>
    </ImageSettingsSection>
    <ImageGenerationViewer :download-enabled="true" v-if="viewerIndex !== undefined && selected" v-model:index="viewerIndex" :count="viewerFrames.length" @close="viewerIndex = undefined">
      <template #download><ImageDownloadMenu v-if="viewerFrames[viewerIndex]" :key="idToRaw({ id: viewerFrames[viewerIndex]!.binaryObjectId })" :active="active" :disabled="!available" :on-download="options => onDownload({ binaryObjectId: viewerFrames[viewerIndex!]!.binaryObjectId, record: selected!, ...options })" /></template>
      <ImageHistoryImage v-if="viewerFrames[viewerIndex]" :binary-object-id="viewerFrames[viewerIndex]!.binaryObjectId" :alt="selected.request.parameters.prompt" :get-image="view.getImage" eager />
    </ImageGenerationViewer>
  </section>
</template>
