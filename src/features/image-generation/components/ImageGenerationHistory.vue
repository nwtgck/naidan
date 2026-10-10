<script setup lang="ts">
import { computed, ref, useId, watch, type Ref } from 'vue';
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronsLeftIcon, ChevronsRightIcon, CopyIcon, LoaderCircleIcon } from 'lucide-vue-next';
import { ensureStrings, lazyStrings } from '@/strings';
import { useConfirm } from '@/composables/useConfirm';
import AllowedHtmlView from '@/components/common/AllowedHtmlView.vue';
import { jsonToHighlightedHtml } from '@/logic/security/allowedHtml';
import { idToRaw } from '@/01-models/ids';
import type { BinaryObjectId } from '@/01-models/ids';
import type { ImageGenerationRecord } from '@/01-models/image-generation-history';
import type { ImageDownloadPreferences, ImageGenerationView } from '@/features/image-generation/use-image-generation-types';
import type { ImageGenerationHistoryView } from '@/features/image-generation/history-view';
import ImageSettingsSection from './ImageSettingsSection.vue';
import ImageGenerationViewer from './ImageGenerationViewer.vue';
import ImageDownloadMenu from './ImageDownloadMenu.vue';
import ImageHistoryImage from './ImageHistoryImage.vue';
const props = defineProps<{
  view: ImageGenerationHistoryView, disabled: boolean, recordDeleteDisabled: boolean, editorDisabled: boolean, active: boolean,
  downloadPreferences: Ref<ImageDownloadPreferences>,
  onDownloadPreferencesChange: ({ preferences }: { preferences: ImageDownloadPreferences }) => void,
  onDownload: ImageGenerationView['downloadHistory'],
}>();
const emit = defineEmits<{
  reuse: [value: { record: ImageGenerationRecord }];
  useImage: [value: { binaryObjectId: BinaryObjectId, role: 'initial' | 'reference' }];
}>();
const { available, items, total, currentPage, pageCount, loading, error, warnings, warningCount, selected, detailLoading, detailError } = props.view;
const { showConfirm } = useConfirm();
const viewerIndex = ref<number>();
const deleteError = ref('');
const imageDeleteError = ref('');
const deletingImage = ref(false);
const imageDeleteHelpOpen = ref(false);
const imageDeleteHelpId = useId();
const promptCopied = ref(false);
const promptCopyError = ref('');
let promptCopyRevision = 0;
let imageDeleteContextRevision = 0;
watch([selected, available, detailLoading, () => props.active, () => props.disabled], () => {
  imageDeleteContextRevision++;
}, { flush: 'sync' });
watch(() => props.active && available.value, visible => {
  if (!visible) viewerIndex.value = undefined;
});
const viewerFrames = computed(() => selected.value ? [selected.value.result, ...selected.value.previews] : []);
const requestedSettingsHtml = computed(() => jsonToHighlightedHtml({
  json: selected.value ? JSON.stringify(selected.value.request, undefined, 2) : '',
  highlight: true,
  keyStyle: 'raw',
}));
const previewsOpen = ref(false);
const deleteHelpOpen = ref(false);
const deleteHelpId = useId();
watch(selected, () => {
  promptCopyRevision++;
  promptCopied.value = false;
  promptCopyError.value = '';
  viewerIndex.value = undefined;
  previewsOpen.value = false;
  deleteHelpOpen.value = false;
  deleteError.value = '';
  imageDeleteHelpOpen.value = false;
  imageDeleteError.value = '';
});

async function copySelectedPrompt(): Promise<void> {
  const prompt = selected.value?.request.parameters.prompt;
  if (prompt === undefined) return;
  const revision = ++promptCopyRevision;
  promptCopied.value = false;
  promptCopyError.value = '';
  try {
    await navigator.clipboard.writeText(prompt);
    if (revision !== promptCopyRevision) return;
    promptCopied.value = true;
    setTimeout(() => {
      if (revision === promptCopyRevision) promptCopied.value = false;
    }, 2000);
  } catch (cause) {
    if (revision !== promptCopyRevision) return;
    const message = await ensureStrings.volumes__failed_to_copy({ errorMessage: cause instanceof Error ? cause.message : String(cause) });
    if (revision === promptCopyRevision) promptCopyError.value = message;
  }
}

const search = ref(''), deleting = ref(false);
const searchInputId = useId();

function searchChanged(): void {
  props.view.setQuery({ text: search.value });
}

function dateLabel({ timestamp }: { timestamp: number }): string {
  return new Date(timestamp).toLocaleString();
}

async function removeSelected(): Promise<void> {
  if (!selected.value || deleting.value || deletingImage.value || detailLoading.value || props.recordDeleteDisabled || !props.active || !available.value) return;
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

async function removeSelectedImage(): Promise<void> {
  const record = selected.value;
  if (!record || deletingImage.value || deleting.value || detailLoading.value || props.disabled || !props.active || !available.value) return;
  const id = record.id, binaryObjectId = record.result.binaryObjectId;
  const contextRevision = imageDeleteContextRevision;
  const title = await ensureStrings.ImageGenerationHistory__delete_image_file();
  const message = await ensureStrings.ImageGenerationHistory__deleting_image_file_affects_other_records();
  if (contextRevision !== imageDeleteContextRevision || selected.value !== record || props.disabled || !props.active || !available.value) return;
  const confirmed = await showConfirm({ title, message, confirmButtonText: title, confirmButtonVariant: 'danger' });
  if (!confirmed || contextRevision !== imageDeleteContextRevision || deletingImage.value || deleting.value || detailLoading.value || props.disabled || !props.active || !available.value || selected.value !== record || selected.value.result.binaryObjectId !== binaryObjectId) return;
  deletingImage.value = true;
  imageDeleteError.value = '';
  try {
    await props.view.removeImage({ id, binaryObjectId });
  } catch (cause) {
    if (selected.value === record) imageDeleteError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    deletingImage.value = false;
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="space-y-4" data-testid="image-generation-history">
    <p v-if="!available" role="status" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-3 text-sm text-gray-600 dark:text-gray-300" data-testid="image-history-unavailable">{{ lazyStrings.ImageGenerationHistory__opfs_required() }}</p>
    <div tw-class="flex flex-wrap items-center gap-2">
      <div tw-class="relative min-w-0 flex-1 text-sm">
        <label :for="searchInputId" tw-class="sr-only">{{ lazyStrings.ImageGenerationHistory__search_history() }}</label>
        <input :id="searchInputId" v-model="search" @input="searchChanged" :disabled="!available" :placeholder="lazyStrings.ImageGenerationHistory__search_history()" type="search" data-testid="image-history-search" tw-class="outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 disabled:cursor-not-allowed block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2.5 pl-2.5 pr-16 text-gray-800 dark:text-gray-100 shadow-sm transition-colors hover:border-gray-300 dark:hover:border-gray-600" />
        <span role="status" data-testid="image-history-search-status" tw-class="pointer-events-none absolute right-10 top-1/2 -translate-y-1/2 text-blue-500"><LoaderCircleIcon v-if="loading" aria-hidden="true" tw-class="h-4 w-4 animate-spin motion-reduce:animate-none" /><span tw-class="sr-only">{{ loading ? lazyStrings.ImageGenerationHistory__loading_history() : '' }}</span></span>
      </div>
      <button type="button" @click="view.reload()" :disabled="!available || loading" data-testid="image-history-refresh" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 self-end rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2.5 text-sm font-bold text-gray-700 dark:text-gray-200 shadow-sm transition-colors hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed">{{ lazyStrings.ImageGenerationHistory__refresh() }}</button>
    </div>
    <nav :aria-label="lazyStrings.ImageGenerationHistory__page_of_total({ page: currentPage, total: pageCount })" data-testid="image-history-pagination" tw-class="flex items-center justify-end gap-1">
      <button type="button" @click="view.goToPage({ page: 1 })" :disabled="!available || loading || !!error || currentPage <= 1" :aria-label="lazyStrings.ImageGenerationHistory__first_page()" :title="lazyStrings.ImageGenerationHistory__first_page()" data-testid="image-history-first-page" tw-class="inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"><ChevronsLeftIcon tw-class="h-4 w-4" /></button>
      <button type="button" @click="view.goToPage({ page: currentPage - 1 })" :disabled="!available || loading || !!error || currentPage <= 1" :aria-label="lazyStrings.ImageGenerationHistory__previous_page()" :title="lazyStrings.ImageGenerationHistory__previous_page()" data-testid="image-history-previous-page" tw-class="inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"><ChevronLeftIcon tw-class="h-4 w-4" /></button>
      <span data-testid="image-history-page-number" tw-class="min-w-16 px-2 text-center text-xs font-medium tabular-nums text-gray-600 dark:text-gray-300">{{ currentPage }} / {{ pageCount }}</span>
      <button type="button" @click="view.goToPage({ page: currentPage + 1 })" :disabled="!available || loading || !!error || currentPage >= pageCount" :aria-label="lazyStrings.ImageGenerationHistory__next_page()" :title="lazyStrings.ImageGenerationHistory__next_page()" data-testid="image-history-next-page" tw-class="inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"><ChevronRightIcon tw-class="h-4 w-4" /></button>
      <button type="button" @click="view.goToPage({ page: pageCount })" :disabled="!available || loading || !!error || currentPage >= pageCount" :aria-label="lazyStrings.ImageGenerationHistory__last_page()" :title="lazyStrings.ImageGenerationHistory__last_page()" data-testid="image-history-last-page" tw-class="inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"><ChevronsRightIcon tw-class="h-4 w-4" /></button>
    </nav>
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
    <p v-if="available && !loading && !error && !warningCount && !items.length" tw-class="rounded-2xl border border-dashed border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/20 p-8 text-center text-sm text-gray-500 dark:text-gray-400" data-testid="image-history-empty">{{ lazyStrings.ImageGenerationHistory__no_history_found() }}</p>
    <div v-if="available" :tw-class="['items-start gap-6', selected ? 'grid lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.85fr)]' : 'block']">
      <div :aria-busy="loading" data-testid="image-history-results" :tw-class="['grid gap-3 grid-cols-2', selected ? 'md:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3' : 'md:grid-cols-3 xl:grid-cols-5']">
        <button v-for="item in items" :key="idToRaw({ id: item.id })" type="button" @click="view.select({ id: item.id })" :aria-pressed="selected?.id === item.id" data-testid="image-history-item" :tw-class="['w-full overflow-hidden rounded-xl border text-left space-y-2 pb-3 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', selected?.id === item.id ? 'border-blue-300 dark:border-blue-700 bg-blue-50/50 dark:bg-blue-950/20' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/40 hover:border-gray-300 dark:hover:border-gray-600']">
          <ImageHistoryImage :binary-object-id="item.binaryObjectId" :width="item.width" :height="item.height" :alt="item.prompt" :get-image="view.getImage" :invalidation="view.imageInvalidation.value" thumbnail />
          <p tw-class="px-3 text-sm line-clamp-2 break-words">{{ item.prompt }}</p>
          <p tw-class="px-3 text-xs text-gray-500 dark:text-gray-400">{{ dateLabel({ timestamp: item.createdAt }) }} · {{ item.width }} × {{ item.height }}</p>
          <p tw-class="px-3 text-xs truncate text-gray-500 dark:text-gray-400" :title="item.modelName">{{ item.modelName }}</p>
        </button>
      </div>
      <div tw-class="min-w-0 space-y-4 lg:sticky lg:top-4">
        <p v-if="detailLoading" role="status" tw-class="text-sm">{{ lazyStrings.ImageGenerationHistory__loading_history() }}</p>
        <p v-if="detailError" role="alert" tw-class="text-sm text-red-600 dark:text-red-400 break-words">{{ detailError }}</p>
        <article v-if="selected" :aria-busy="detailLoading" tw-class="space-y-4 rounded-2xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 p-4" data-testid="image-history-detail">
          <div tw-class="flex flex-wrap items-center justify-between gap-2">
            <h3 tw-class="text-sm font-bold text-gray-800 dark:text-gray-100">{{ dateLabel({ timestamp: selected.createdAt }) }}</h3>
            <button type="button" @click="view.clearSelection()" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-lg px-2 py-1 text-xs font-bold text-gray-500 dark:text-gray-400 transition-colors hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200">{{ lazyStrings.ImageGenerationHistory__close_details() }}</button>
          </div>
          <button type="button" @click="viewerIndex = 0" :disabled="detailLoading" :aria-label="lazyStrings.ImageGenerationViewer__image_preview()" data-testid="image-history-open-viewer" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 block w-full rounded-xl disabled:cursor-not-allowed">
            <ImageHistoryImage :binary-object-id="selected.result.binaryObjectId" :width="selected.result.width" :height="selected.result.height" :alt="selected.request.parameters.prompt" :get-image="view.getImage" :invalidation="view.imageInvalidation.value" />
          </button>
          <div tw-class="flex flex-wrap gap-2 text-sm">
            <button type="button" @click="emit('reuse', { record: selected })" :disabled="disabled || editorDisabled || detailLoading" data-testid="image-history-reuse" tw-class="min-h-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-xs font-bold text-blue-600 dark:text-blue-400 shadow-sm transition-colors hover:border-blue-200 dark:hover:border-blue-900/50 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-40 disabled:cursor-not-allowed">{{ lazyStrings.ImageGenerationHistory__reuse_settings() }}</button>
            <button type="button" @click="emit('useImage', { binaryObjectId: selected.result.binaryObjectId, role: 'initial' })" :disabled="disabled || editorDisabled || detailLoading" data-testid="image-history-use-initial" tw-class="min-h-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-xs font-bold text-gray-700 dark:text-gray-200 shadow-sm transition-colors hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed">{{ lazyStrings.ImageGenerationHistory__use_as_initial_image() }}</button>
            <button type="button" @click="emit('useImage', { binaryObjectId: selected.result.binaryObjectId, role: 'reference' })" :disabled="disabled || editorDisabled || detailLoading" data-testid="image-history-use-reference" tw-class="min-h-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-xs font-bold text-gray-700 dark:text-gray-200 shadow-sm transition-colors hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed">{{ lazyStrings.ImageGenerationHistory__use_as_reference_image() }}</button>
          </div>
          <ImageDownloadMenu :preferences="props.downloadPreferences" :on-preferences-change="onDownloadPreferencesChange" :key="idToRaw({ id: selected.id })" :active="active" :disabled="!available || detailLoading" :on-download="options => onDownload({ binaryObjectId: selected!.result.binaryObjectId, record: selected!, ...options })" data-testid="image-history-download" />
          <section tw-class="min-w-0 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5 shadow-sm" data-testid="image-history-prompt">
            <div tw-class="flex min-w-0 items-start gap-2">
              <p tw-class="min-w-0 flex-1 text-sm leading-relaxed text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words [overflow-wrap:anywhere]" data-testid="image-history-full-prompt">{{ selected.request.parameters.prompt }}</p>
              <button type="button" @click="copySelectedPrompt" :title="promptCopied ? lazyStrings.MessageActions__copied() : lazyStrings.ImageInfoDisplay__copy_prompt()" :aria-label="promptCopied ? lazyStrings.MessageActions__copied() : lazyStrings.ImageInfoDisplay__copy_prompt()" data-testid="image-history-copy-prompt" tw-class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 transition-colors hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-blue-600 dark:hover:text-blue-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                <CheckIcon v-if="promptCopied" aria-hidden="true" tw-class="h-4 w-4" />
                <CopyIcon v-else aria-hidden="true" tw-class="h-4 w-4" />
              </button>
            </div>
            <span v-if="promptCopied" role="status" tw-class="sr-only">{{ lazyStrings.MessageActions__copied() }}</span>
            <p v-if="promptCopyError" role="alert" data-testid="image-history-copy-prompt-error" tw-class="mt-2 text-xs text-red-600 dark:text-red-400 break-words">{{ promptCopyError }}</p>
          </section>
          <ImageSettingsSection :title="lazyStrings.ImageGenerationHistory__generation_details()" :summary="undefined" data-testid="image-history-generation-details">
            <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ selected.result.confirmation === 'unconfirmed' ? lazyStrings.ImageRecoveredOutputs__unconfirmed() : '' }} {{ selected.result.width }} × {{ selected.result.height }} · {{ selected.result.modelVersion }} · {{ lazyStrings.ImageGenerationHistory__requested_seed() }}: {{ selected.request.parameters.seed }}</p>
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
              <div v-if="selected.request.parameters.bf16WeightType !== undefined">
                <dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.stableDiffusionCppBrowser__bf16_weight_conversion() }}</dt>
                <dd>{{ selected.request.parameters.bf16WeightType.toUpperCase() }}</dd>
              </div>
            </dl>
            <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationHistory__reuse_does_not_download_models() }}</p>
          </ImageSettingsSection>
          <ImageSettingsSection :title="lazyStrings.ImageGenerationHistory__requested_settings()" :summary="undefined">
            <AllowedHtmlView as="pre" :html="requestedSettingsHtml" data-testid="image-history-request-json" tw-class="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed font-mono text-gray-700 dark:text-gray-300" />
          </ImageSettingsSection>
          <ImageSettingsSection v-if="selected.previews.length" v-model:open="previewsOpen" :title="lazyStrings.stableDiffusionCppBrowser__preview_title()" :summary="selected.previews.length.toString()" data-testid="image-history-previews">
            <div v-if="previewsOpen" tw-class="grid sm:grid-cols-2 gap-3">
              <figure v-for="(frame, index) in selected.previews" :key="idToRaw({ id: frame.binaryObjectId })" tw-class="space-y-2">
                <button type="button" @click="viewerIndex = index + 1" :disabled="detailLoading" :aria-label="lazyStrings.ImageGenerationViewer__image_preview()" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 block w-full rounded-xl disabled:cursor-not-allowed">
                  <ImageHistoryImage :binary-object-id="frame.binaryObjectId" :width="frame.width" :height="frame.height" :alt="selected.request.parameters.prompt" :get-image="view.getImage" :invalidation="view.imageInvalidation.value" />
                </button>
                <figcaption tw-class="text-xs">{{ frame.step }} / {{ frame.steps }} · {{ frame.mode }} · {{ frame.width }} × {{ frame.height }}</figcaption>
                <ImageDownloadMenu :preferences="props.downloadPreferences" :on-preferences-change="onDownloadPreferencesChange" :active="active" :disabled="!available || detailLoading" :on-download="options => onDownload({ binaryObjectId: frame.binaryObjectId, record: selected!, ...options })" />
              </figure>
            </div>
          </ImageSettingsSection>
          <section tw-class="rounded-2xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 px-3" data-testid="image-history-delete-section">
            <div tw-class="flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-1.5">
              <button type="button" @click="removeSelected" :disabled="recordDeleteDisabled || deleting || deletingImage || detailLoading || !active || !available" data-testid="image-history-delete" tw-class="inline-flex min-h-10 items-center rounded-xl border border-red-100 dark:border-red-900/30 bg-red-50/40 dark:bg-red-900/10 px-3 py-2 text-xs font-bold leading-tight text-red-600 dark:text-red-400 transition-colors hover:border-red-200 dark:hover:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-40 disabled:cursor-not-allowed">{{ lazyStrings.ImageGenerationHistory__remove_from_history() }}</button>
              <button type="button" :aria-expanded="deleteHelpOpen" :aria-controls="deleteHelpId" data-testid="image-history-delete-help-toggle" @click="deleteHelpOpen = !deleteHelpOpen" tw-class="inline-flex min-h-10 items-center self-center gap-1.5 rounded-lg px-2 text-xs font-medium leading-tight text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                {{ lazyStrings.llamaCppBrowserDownloads__details() }}
                <ChevronDownIcon aria-hidden="true" :tw-class="['h-4 w-4 transition-transform motion-reduce:transition-none', deleteHelpOpen ? 'rotate-180' : '']" />
              </button>
            </div>
            <div v-show="deleteHelpOpen || deleteError" tw-class="space-y-2 px-1 pt-2 pb-3 text-xs leading-relaxed">
              <p v-if="deleteHelpOpen" :id="deleteHelpId" data-testid="image-history-delete-help" tw-class="border-t border-gray-200 dark:border-gray-700 pt-3 pb-2 text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationHistory__removing_keeps_image_files() }}</p>
              <p v-if="deleteError" role="alert" data-testid="image-history-delete-error" tw-class="text-red-600 dark:text-red-400 break-words">{{ deleteError }}</p>
            </div>
          </section>
          <section tw-class="rounded-2xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 px-3" data-testid="image-history-image-delete-section">
            <div tw-class="flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-1.5">
              <button type="button" @click="removeSelectedImage" :disabled="disabled || deleting || deletingImage || detailLoading || !available" data-testid="image-history-delete-image" tw-class="inline-flex min-h-10 items-center rounded-xl border border-red-100 dark:border-red-900/30 bg-red-50/40 dark:bg-red-900/10 px-3 py-2 text-xs font-bold leading-tight text-red-600 dark:text-red-400 transition-colors hover:border-red-200 dark:hover:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-40 disabled:cursor-not-allowed">{{ lazyStrings.ImageGenerationHistory__delete_image_file() }}</button>
              <button type="button" :aria-expanded="imageDeleteHelpOpen" :aria-controls="imageDeleteHelpId" data-testid="image-history-image-delete-help-toggle" @click="imageDeleteHelpOpen = !imageDeleteHelpOpen" tw-class="inline-flex min-h-10 items-center self-center gap-1.5 rounded-lg px-2 text-xs font-medium leading-tight text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                {{ lazyStrings.llamaCppBrowserDownloads__details() }}
                <ChevronDownIcon aria-hidden="true" :tw-class="['h-4 w-4 transition-transform motion-reduce:transition-none', imageDeleteHelpOpen ? 'rotate-180' : '']" />
              </button>
            </div>
            <div v-show="imageDeleteHelpOpen || imageDeleteError" tw-class="space-y-2 px-1 pt-2 pb-3 text-xs leading-relaxed">
              <p v-if="imageDeleteHelpOpen" :id="imageDeleteHelpId" data-testid="image-history-image-delete-help" tw-class="border-t border-gray-200 dark:border-gray-700 pt-3 pb-2 text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationHistory__deleting_image_file_affects_other_records() }}</p>
              <p v-if="imageDeleteError" role="alert" data-testid="image-history-image-delete-error" tw-class="text-red-600 dark:text-red-400 break-words">{{ imageDeleteError }}</p>
            </div>
          </section>
        </article>
      </div>
    </div>
    <ImageSettingsSection :title="lazyStrings.ImageGenerationResults__about_saved_history()" :summary="undefined">
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationHistory__experimental_history_notice() }}</p>
      <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationHistory__backup_does_not_include_history() }}</p>
    </ImageSettingsSection>
    <ImageGenerationViewer :download-enabled="true" v-if="viewerIndex !== undefined && selected" v-model:index="viewerIndex" :count="viewerFrames.length" @close="viewerIndex = undefined">
      <template #download><ImageDownloadMenu :preferences="props.downloadPreferences" :on-preferences-change="onDownloadPreferencesChange" v-if="viewerFrames[viewerIndex]" :key="idToRaw({ id: viewerFrames[viewerIndex]!.binaryObjectId })" :active="active" :disabled="!available || detailLoading" :on-download="options => onDownload({ binaryObjectId: viewerFrames[viewerIndex!]!.binaryObjectId, record: selected!, ...options })" /></template>
      <ImageHistoryImage v-if="viewerFrames[viewerIndex]" :binary-object-id="viewerFrames[viewerIndex]!.binaryObjectId" :width="viewerFrames[viewerIndex]!.width" :height="viewerFrames[viewerIndex]!.height" :alt="selected.request.parameters.prompt" :get-image="view.getImage" :invalidation="view.imageInvalidation.value" eager />
    </ImageGenerationViewer>
  </section>
</template>
