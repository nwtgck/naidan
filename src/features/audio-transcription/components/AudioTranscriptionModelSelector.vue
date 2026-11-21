<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { computed, nextTick, onScopeDispose, ref, useId, watch } from 'vue';
import { useResizeObserver } from '@vueuse/core';
import { ChevronDownIcon, DownloadIcon, GlobeIcon, Loader2Icon, Maximize2Icon, Minimize2Icon, RefreshCwIcon, SearchIcon, XIcon } from 'lucide-vue-next';
import { useAnchoredPopup } from '@/composables/useAnchoredPopup';
import { useEventTargetListener } from '@/composables/useEventTargetListener';
import { provideModelSelectorHuggingFaceSearchState } from '@/composables/useModelSelectorHuggingFaceSearchState';
import ModelSelectorStoredVariantsRow from '@/components/ModelSelectorStoredVariantsRow.vue';
import ModelSelectorRepositoryRow from '@/components/ModelSelectorRepositoryRow.vue';
import { groupStoredModelVariants } from '@/features/llama-cpp-browser/hugging-face/stored-model-variant-groups';
import ModelSelectorVariantDownload from '@/components/ModelSelectorVariantDownload.vue';
import ModelSelectorDownloadAction from '@/components/ModelSelectorDownloadAction.vue';
import ModelSelectorFileImport from '@/components/ModelSelectorFileImport.vue';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { describeModelSelectorDownload, type ModelSelectorDownloadPresentation } from '@/components/model-selector-download-presentation';
import ModelSelectorConfigurationSummary from '@/components/ModelSelectorConfigurationSummary.vue';
import ModelSelectorConfiguration from '@/components/ModelSelectorConfiguration.vue';
import ModelSelectorFileOptions from '@/components/ModelSelectorFileOptions.vue';
import ModelSelectorRepositorySource from '@/components/ModelSelectorRepositorySource.vue';
import AudioTranscriptionModelSources from '@/features/audio-transcription/components/AudioTranscriptionModelSources.vue';
import type { AudioTranscriptionPickerModel, useAudioTranscriptionModels } from '@/features/audio-transcription/composables/useAudioTranscriptionModels';
import LlamaCppBrowserDownloadDestination from '@/features/llama-cpp-browser/components/LlamaCppBrowserDownloadDestination.vue';
import { formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/presentation';
import { splitModelName } from '@/utils/model-name';
import { modelSearchFilter } from '@/components/model-selector-item';
import { splitModelIdDisplay, trySplitRepositoryModelId } from '@/01-models/llama-cpp-browser-model-id';

const props = defineProps<{ models: ReturnType<typeof useAudioTranscriptionModels> }>();
type Tab = 'compatible' | 'saved' | 'huggingface' | 'files';
type ModelGroup = 'stored' | 'other' | 'download';
const tabs = computed<readonly { id: Tab, label: string | undefined }[]>(() => [
  { id: 'compatible', label: lazyStrings.AudioTranscriptionModelSelector__for_transcription() },
  { id: 'saved', label: lazyStrings.ModelSelector__models_on_this_device() },
  { id: 'huggingface', label: 'Hugging Face' },
  { id: 'files', label: lazyStrings.ModelSelector__add_files() },
]);
const popupId = useId();
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLDialogElement>();
const sizeButton = ref<HTMLButtonElement>();
const search = ref<HTMLInputElement>();
const tabStrip = ref<HTMLElement>();
const animateTabIndicator = ref(false);
const tabIndicator = ref<{ transform: string, width: string }>();
const viewport = ref<HTMLElement>();
const open = ref(false);
const expanded = ref(false);
const tab = ref<Tab>('compatible');
const query = ref('');
const { query: huggingFaceQuery } = provideModelSelectorHuggingFaceSearchState();
let hasOpenedHuggingFace = false;
const hfVisited = ref(false);
const fileVisited = ref(false);
const addedModels = ref<readonly LocalModel[]>([]);
const openDetails = ref<{ id: string, group: ModelGroup }>();
const detailId = computed(() => openDetails.value?.id);
const detailAnchor = ref<HTMLButtonElement>();
const currentVariant = ref<string>();
const editingSuggestedConfiguration = ref(false);
const checkedVariants = ref(false);
const checkingVariants = ref(false);
let inspection: AbortController | undefined;
let sizeAnimation: Animation | undefined;
const scrollPositions = new Map<Tab, number>();
const { placement, refresh } = useAnchoredPopup({ anchor: trigger, preferredWidth: { unit: 'px', value: 510 }, maxWidthPx: 510 });

const downloadDestinationLabel = computed(() => {
  const destination = props.models.downloadDestination;
  return destination.label({ destination: destination.destination.value });
});
const selected = computed(() => props.models.pickerModels.value.find(model => model.id === props.models.selectedId.value));
const selectedName = computed(() => selected.value?.modelId ?? selected.value?.label);
const selectedNameParts = computed(() => {
  const reference = selected.value?.modelId;
  const parsed = reference !== undefined && /^(?:hf\.co|host)\//.test(reference) ? trySplitRepositoryModelId({ modelId: reference }) : undefined;
  if (parsed !== undefined) {
    const { source, name, variant } = splitModelIdDisplay({ modelId: parsed.baseId });
    return { prefix: source, suffix: variant === undefined ? name : `${name}:${variant}` };
  }
  return splitModelName({ name: selectedName.value });
});
const downloads = computed(() => {
  const display = new Map<string, ModelSelectorDownloadPresentation>();
  for (const [id, { status, progress }] of props.models.downloadStates.value) {
    const presentation = describeModelSelectorDownload({ status, progress });
    if (presentation !== undefined) {
      display.set(id, presentation);
    }
  }
  return display;
});
const showFirstUseDownloadHint = computed(() => {
  const model = selected.value;
  return model?.availability === 'download_required'
    && props.models.downloadStates.value.get(model.id)?.status !== 'complete'
    && !downloads.value.get(model.id)?.active;
});
const isRefreshing = computed(() => props.models.refreshing.value);
const matchingIds = computed(() => {
  const matches = modelSearchFilter({ query: query.value });
  return new Set(props.models.pickerModels.value.filter(model => matches({ fields: [model.modelId, model.label, model.description] })).map(model => model.id));
});
const matching = computed(() => props.models.pickerModels.value
  .filter(model => model.id === detailId.value || matchingIds.value.has(model.id))
  .map(model => {
    const saved = model.availability === 'local';
    const title = saved ? model.modelId ?? model.label : model.label;
    const parts = splitModelName({ name: title });
    return {
      ...model,
      title,
      suggested: model.id.startsWith('suggestion:'),
      name: splitModelName({ name: model.label }).suffix || model.label,
      subtitle: saved && parts.prefix ? parts.prefix.slice(0, -1) : model.description,
      download: saved ? undefined : downloads.value.get(model.id),
    };
  }));
const otherMatching = computed(() => matching.value.filter(model => model.compatibility !== undefined && matchingIds.value.has(model.id)));

function groupForModel({ model }: { model: AudioTranscriptionPickerModel }): ModelGroup {
  if (openDetails.value?.id === model.id) {
    return openDetails.value.group;
  }
  if (model.compatibility !== undefined) {
    return 'other';
  }
  switch (model.availability) {
  case 'local': return 'stored';
  case 'checking': case 'download_required': case 'remote': return 'download';
  default: throw new Error(String(model.availability satisfies never));
  }
}

const groups = computed<{ id: ModelGroup, label: string | undefined, models: typeof matching.value }[]>(() => {
  const grouped: Record<ModelGroup, typeof matching.value> = { stored: [], other: [], download: [] };
  for (const model of matching.value) {
    grouped[groupForModel({ model })].push(model);
  }
  switch (tab.value) {
  case 'saved': return [
    { id: 'stored', label: lazyStrings.AudioTranscriptionModelSelector__supports_transcription(), models: grouped.stored },
    { id: 'other', label: lazyStrings.AudioTranscriptionModelSelector__other_saved_models(), models: grouped.other },
  ];
  case 'compatible': return [
    { id: 'stored', label: lazyStrings.ModelSelector__models_on_this_device(), models: grouped.stored },
    { id: 'download', label: lazyStrings.AudioTranscriptionModelSelector__models_to_download(), models: grouped.download },
  ];
  case 'huggingface': case 'files': return [];
  default: throw new Error(String(tab.value satisfies never));
  }
});
const groupedRows = computed(() => groups.value.map(group => ({
  ...group,
  rows: groupStoredModelVariants({
    items: group.models,
    identity: ({ item }) => {
      switch (item.availability) {
      case 'local': return { id: item.id, modelId: item.modelId, fallback: { name: item.name, source: item.subtitle ?? '' } };
      case 'checking': case 'download_required': case 'remote': return { id: item.id, modelId: undefined };
      default: throw new Error(String(item.availability satisfies never));
      }
    },
  }).map(row => {
    switch (row.kind) {
    case 'single': return { row, model: row.item };
    case 'variants': return { row, model: (row.variants.find(variant => variant.item.id === selected.value?.id) ?? row.variants[0]!).item };
    default: throw new Error(String(row satisfies never));
    }
  }),
})));
const variants = computed(() => props.models.quantizationsForModel({ id: detailId.value }));
const selectedVariantDetails = computed(() => variants.value.find(variant => variant.id === currentVariant.value));
const details = computed(() => props.models.detailsForModel({ id: detailId.value, filePath: currentVariant.value }));

function measureTabIndicator(): void {
  const active = tabStrip.value?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
  if (active && active.offsetWidth > 0) {
    tabIndicator.value = { transform: 'translateX(' + active.offsetLeft + 'px)', width: active.offsetWidth + 'px' };
  }
}

watch([tab, tabStrip], measureTabIndicator, { flush: 'post' });
useResizeObserver(tabStrip, measureTabIndicator);

function statusLabel({ model }: { model: AudioTranscriptionPickerModel }): string | undefined {
  switch (model.compatibility) {
  case 'unconfirmed': return lazyStrings.AudioTranscriptionModelSelector__compatibility_unconfirmed();
  case 'unmatched': case undefined: break;
  default: throw new Error(String(model.compatibility satisfies never));
  }
  switch (model.availability) {
  case 'download_required': {
    const download = downloads.value.get(model.id);
    return download?.active ? undefined : download?.label ?? lazyStrings.ModelSelector__downloads_automatically();
  }
  case 'checking': case 'local': case 'remote': return undefined;
  default: throw new Error(String(model.availability satisfies never));
  }
}

function focusView(): void {
  void nextTick(() => {
    refresh();
    switch (tab.value) {
    case 'compatible': case 'saved': search.value?.focus({ preventScroll: true });
      break;
    case 'huggingface': panel.value?.querySelector<HTMLInputElement>('[data-testid="model-selector-hf-query"]')?.focus({ preventScroll: true });
      break;
    case 'files': break;
    default: throw new Error(String(tab.value satisfies never));
    }
  });
}

function hide(): void {
  closeDetails({ restoreFocus: false });
  sizeAnimation?.cancel();
  if (expanded.value) {
    panel.value?.close();
  }
  open.value = false;
}

function close(): void {
  hide();
  trigger.value?.focus();
}

function showDialog(): void {
  const element = panel.value;
  if (!element || !element.isConnected || element.open) {
    return;
  }
  if (expanded.value) {
    element.showModal();
  } else if (typeof element.show === 'function') {
    element.show();
  } else {
    element.open = true;
  }
}

function toggleSize(): void {
  const element = panel.value;
  if (!element?.open) {
    return;
  }
  const previous = element.getBoundingClientRect();
  sizeAnimation?.cancel();
  element.close();
  expanded.value = !expanded.value;
  showDialog();
  void nextTick(() => {
    refresh();
    sizeButton.value?.focus({ preventScroll: true });
    if (panel.value !== element || !open.value || window.matchMedia('(prefers-reduced-motion: reduce)').matches || typeof element.animate !== 'function') {
      return;
    }
    const current = element.getBoundingClientRect();
    if (current.width === 0 || current.height === 0) {
      return;
    }
    const offset = 'translate(' + (previous.left - current.left) + 'px, ' + (previous.top - current.top) + 'px)';
    const scale = 'scale(' + (previous.width / current.width) + ', ' + (previous.height / current.height) + ')';
    sizeAnimation = element.animate([
      { transformOrigin: 'top left', transform: offset + ' ' + scale },
      { transformOrigin: 'top left', transform: 'none' },
    ], { duration: 230, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
  });
}

watch(panel, showDialog, { flush: 'post' });
useEventTargetListener(document, 'pointerdown', event => {
  if (!open.value || expanded.value || event.button !== 0) {
    return;
  }
  const path = event.composedPath();
  if ((panel.value && path.includes(panel.value)) || (trigger.value && path.includes(trigger.value))) {
    return;
  }
  hide();
}, { capture: true });

function toggle(): void {
  if (open.value) {
    close();
    return;
  }
  expanded.value = false;
  tab.value = selected.value?.compatibility === undefined ? 'compatible' : 'saved';
  query.value = '';
  scrollPositions.clear();
  tabIndicator.value = undefined;
  animateTabIndicator.value = false;
  hfVisited.value = false;
  fileVisited.value = false;
  open.value = true;
  focusView();
}

function showTab({ id }: { id: Tab }): void {
  if (tab.value === id) {
    return;
  }
  rememberListPosition();
  closeDetails({ restoreFocus: false });
  animateTabIndicator.value = tabIndicator.value !== undefined;
  tab.value = id;
  switch (id) {
  case 'huggingface':
    if (!hasOpenedHuggingFace) {
      huggingFaceQuery.value = query.value;
      hasOpenedHuggingFace = true;
    }
    hfVisited.value = true;
    break;
  case 'files': fileVisited.value = true;
    break;
  case 'compatible': case 'saved': break;
  default: throw new Error(String(id satisfies never));
  }
  restoreListPosition();
  focusView();
}

function rememberListPosition(): void {
  if (viewport.value) {
    scrollPositions.set(tab.value, viewport.value.scrollTop);
  }
}

function restoreListPosition(): void {
  void nextTick(() => {
    if (viewport.value) {
      viewport.value.scrollTop = scrollPositions.get(tab.value) ?? 0;
    }
  });
}

function closeDetails({ restoreFocus }: { restoreFocus: boolean }): void {
  inspection?.abort();
  inspection = undefined;
  checkingVariants.value = false;
  openDetails.value = undefined;
  if (restoreFocus) {
    detailAnchor.value?.focus({ preventScroll: true });
    detailAnchor.value?.scrollIntoView?.({ block: 'nearest' });
  }
  detailAnchor.value = undefined;
}

function toggleDetails({ id, group, event }: { id: string, group: ModelGroup, event: MouseEvent }): void {
  const wasOpen = detailId.value === id;
  closeDetails({ restoreFocus: wasOpen });
  if (wasOpen) {
    return;
  }
  openDetails.value = { id, group };
  detailAnchor.value = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : undefined;
  currentVariant.value = props.models.modelVariant({ id });
  editingSuggestedConfiguration.value = false;
  checkedVariants.value = false;
}

async function checkVariants(): Promise<void> {
  const id = detailId.value;
  if (id === undefined || checkingVariants.value) {
    return;
  }
  const request = new AbortController();
  inspection = request;
  checkingVariants.value = true;
  try {
    const current = await props.models.inspectQuantizations({ id, signal: request.signal, pinCurrent: false });
    if (!request.signal.aborted && detailId.value === id) {
      checkedVariants.value = true;
      if (!props.models.quantizationsFailure.value) {
        currentVariant.value = current;
        if (!current && variants.value.length > 0) {
          editingSuggestedConfiguration.value = true;
        }
      }
    }
  } finally {
    if (inspection === request) {
      inspection = undefined;
      checkingVariants.value = false;
    }
  }
}

watch(query, () => {
  scrollPositions.clear();
  if (detailId.value !== undefined && !matchingIds.value.has(detailId.value)) {
    closeDetails({ restoreFocus: false });
  }
});

function choose({ id, keepOpen }: { id: string, keepOpen?: boolean }): void {
  if (!props.models.busy.value) {
    props.models.select({ id });
    if (!keepOpen) {
      close();
    }
  }
}

function chooseStoredVariant({ id }: { id: string }): void {
  if (!props.models.busy.value) {
    closeDetails({ restoreFocus: false });
    choose({ id, keepOpen: true });
  }
}

async function chooseAddedModel({ modelId }: { modelId: string }): Promise<void> {
  let model = props.models.pickerModels.value.find(entry => entry.modelId === modelId);
  if (model === undefined) {
    await props.models.refresh();
    model = props.models.pickerModels.value.find(entry => entry.modelId === modelId);
  }
  if (open.value && model !== undefined) {
    choose({ id: model.id });
  }
}

function chooseSuggestedConfiguration({ id }: { id: string }): void {
  const variant = selectedVariantDetails.value;
  if (variant === undefined || props.models.busy.value) {
    return;
  }
  if (variant.id === props.models.modelVariant({ id })) {
    choose({ id });
    return;
  }
  props.models.selectQuantization({ id: variant.id, entryId: id });
  close();
}

function chooseVariant({ id }: { id: string }): void {
  const entryId = detailId.value;
  if (entryId === undefined || props.models.busy.value || !variants.value.some(variant => variant.id === id)) {
    return;
  }
  inspection?.abort();
  inspection = undefined;
  checkingVariants.value = false;
  props.models.selectQuantization({ id, entryId });
  currentVariant.value = id;
}

function handleEscape({ event }: { event: KeyboardEvent }): void {
  if (event.defaultPrevented || event.isComposing) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (detailId.value !== undefined) {
    closeDetails({ restoreFocus: true });
  } else {
    close();
  }
}

onScopeDispose(() => {
  inspection?.abort();
  sizeAnimation?.cancel();
});


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <button
    ref="trigger" type="button" aria-haspopup="dialog" :aria-expanded="open" :aria-controls="open ? popupId : undefined"
    :title="selectedName" data-testid="audio-transcription-model-selector"
    :tw-class="['flex h-9 w-full items-center gap-2 rounded-xl px-2 text-left text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-200 dark:hover:bg-gray-800 motion-reduce:transition-none', open && 'bg-gray-100 dark:bg-gray-800']"
    @click="toggle" @keydown.esc="open && close()"
  >
    <span dir="ltr" tw-class="block min-w-0 flex-1">
      <span tw-class="block truncate leading-4">{{ selectedNameParts.suffix || lazyStrings.ModelSelector__select_a_model() }}</span>
      <span v-if="selectedNameParts.prefix" tw-class="block truncate text-[10px] font-normal leading-3 text-gray-500 dark:text-gray-400">{{ selectedNameParts.prefix.slice(0, -1) }}</span>
    </span>
    <span v-if="showFirstUseDownloadHint" :title="lazyStrings.ModelSelector__download_before_first_use()" tw-class="flex shrink-0 items-center gap-1 whitespace-nowrap text-[10px] font-normal text-gray-500 dark:text-gray-400"><DownloadIcon aria-hidden="true" tw-class="h-3 w-3" /><span tw-class="hidden sm:inline">{{ lazyStrings.ModelSelector__downloads_automatically() }}</span></span>
    <ChevronDownIcon aria-hidden="true" :tw-class="['h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform motion-reduce:transition-none', open && 'rotate-180']" />
  </button>
  <Teleport to="body">
    <Transition name="transcription-model-picker">
      <dialog
        v-if="open" :id="popupId" ref="panel" :aria-modal="expanded || undefined" :aria-labelledby="popupId + '-title'"
        :style="expanded ? undefined : placement.style" data-testid="audio-transcription-model-selector"
        class="model-picker-dialog"
        :class="{ 'model-picker-above': !expanded && placement.direction === 'top', 'model-picker-expanded': expanded }"
        tw-class="flex h-[30rem] flex-col overflow-auto overscroll-contain rounded-2xl border border-gray-200 bg-white p-0 text-gray-800 shadow-xl shadow-gray-900/10 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
        @keydown.esc="handleEscape({ event: $event })"
        @cancel.prevent="close"
      >
        <header tw-class="flex min-h-11 shrink-0 items-center gap-2 border-b border-gray-100 px-3 dark:border-gray-800">
          <h2 :id="popupId + '-title'" tw-class="sr-only">{{ lazyStrings.ModelSelector__select_a_model() }}</h2>
          <div ref="tabStrip" role="group" :aria-label="lazyStrings.AudioTranscriptionModelSelector__model_groups()" tw-class="relative flex min-w-0 flex-1 gap-3 overflow-x-auto">
            <span v-if="tabIndicator" :style="tabIndicator" aria-hidden="true" :class="{ 'model-picker-tab-indicator': animateTabIndicator }" tw-class="pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full bg-blue-500" />
            <button v-for="choice in tabs" :key="choice.id" type="button" :aria-pressed="tab === choice.id" :tw-class="['shrink-0 whitespace-nowrap px-1 pb-3 pt-2.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-500 motion-reduce:transition-none', tab === choice.id ? 'text-blue-700 dark:text-blue-300' : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200']" @click="showTab({ id: choice.id })">{{ choice.label }}</button>
          </div>
          <button ref="sizeButton" type="button" :aria-label="expanded ? lazyStrings.ModelSelector__shrink() : lazyStrings.ModelSelector__expand()" :title="expanded ? lazyStrings.ModelSelector__shrink() : lazyStrings.ModelSelector__expand()" tw-class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-gray-800 motion-reduce:transition-none" @click="toggleSize">
            <Minimize2Icon v-if="expanded" aria-hidden="true" tw-class="h-4 w-4" />
            <Maximize2Icon v-else aria-hidden="true" tw-class="h-4 w-4" />
          </button>
          <button v-if="expanded" type="button" :aria-label="lazyStrings.ModelSelector__close()" :title="lazyStrings.ModelSelector__close()" tw-class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-gray-800 motion-reduce:transition-none" @click="close"><XIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
        </header>

        <div ref="viewport" class="model-picker-scroll" tw-class="min-h-24 flex-1 overflow-y-auto overscroll-contain">
          <div v-if="tab === 'saved' || tab === 'compatible'" tw-class="space-y-2 px-3 pb-3">
            <div tw-class="sticky top-0 z-10 flex gap-2 bg-white pt-4 pb-2 dark:bg-gray-900">
              <label tw-class="relative flex min-w-0 flex-1 items-center">
                <SearchIcon aria-hidden="true" tw-class="pointer-events-none absolute left-2.5 h-4 w-4 text-gray-400" />
                <input ref="search" v-model="query" type="search" :aria-label="lazyStrings.ModelSelector__filter_models()" :placeholder="lazyStrings.ModelSelector__filter_models()" autocomplete="off" tw-class="min-h-9 w-full rounded-lg border border-gray-200 bg-gray-50 pl-8 pr-2 text-xs outline-none placeholder:text-gray-500 focus:border-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:placeholder:text-gray-400" />
              </label>
              <button type="button" :aria-label="lazyStrings.ModelSelector__refresh_model_list()" :title="lazyStrings.ModelSelector__refresh_model_list()" :disabled="isRefreshing" tw-class="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-gray-700 dark:hover:bg-gray-800" @click="models.refresh()"><RefreshCwIcon aria-hidden="true" :tw-class="['h-3.5 w-3.5', isRefreshing && 'animate-spin motion-reduce:animate-none']" /></button>
            </div>
            <section v-for="group in groupedRows" v-show="group.models.length" :key="group.id">
              <h3 tw-class="px-2 pb-1.5 text-[11px] font-medium text-gray-500 dark:text-gray-400">{{ group.label }}</h3>
              <ul tw-class="space-y-0.5">
                <li v-for="{ row, model } in group.rows" :key="row.key">
                  <ModelSelectorRepositoryRow
                    as="div" :row-id="model.id" :expanded="detailId === model.id" :configuration-id="popupId + '-model-options'" :checked="selected?.id === model.id"
                    :choose-label="model.label" :test-id="model.suggested ? 'audio-transcription-suggested-model' : undefined" :download-status="statusLabel({ model })" :disabled="false"
                    @choose="choose({ id: model.id })" @toggle="toggleDetails({ id: model.id, group: group.id, event: $event })"
                  >
                    <template v-if="row.kind === 'variants'" #row>
                      <ModelSelectorStoredVariantsRow
                        :name="row.name" :source="row.source"
                        :choices="row.variants.map(({ item, label }) => ({ id: item.id, modelId: item.modelId ?? item.id, label }))"
                        :popup-target="panel" :configuration="{ open: detailId === model.id, id: popupId + '-model-options' }"
                        :selected-id="selected?.id" :disabled="models.busy.value" @choose="choose({ id: $event })" @change-variant="chooseStoredVariant({ id: $event })"
                        @toggle-configuration="toggleDetails({ ...$event, group: group.id })"
                      />
                    </template>
                    <span :title="model.title" tw-class="block truncate font-medium">{{ model.name }}</span>
                    <span v-if="model.subtitle" :title="model.subtitle" tw-class="mt-0.5 block truncate text-[11px] text-gray-500 dark:text-gray-400">{{ model.subtitle }}</span>
                    <template #actions>
                      <ModelSelectorDownloadAction v-if="model.download?.active || model.availability === 'download_required'" :label="model.title" :destination-label="downloadDestinationLabel" :state="model.download?.active ? 'active' : 'available'" :active-label="model.download?.label" :percent="model.download?.percent" :disabled="models.downloadDestination.unavailable.value || models.downloadDestination.view.busy.value" @download="models.backgroundDownload({ id: model.id })" @stop="models.stopBackgroundDownload({ id: model.id })" />
                    </template>
                    <template #configuration>
                      <ModelSelectorConfiguration @collapse="closeDetails({ restoreFocus: true })">
                        <template v-if="details?.kind === 'huggingface' && model.suggested" #summary>
                          <ModelSelectorConfigurationSummary :status="models.configurationSummary({ id: model.id, variant: currentVariant })" :quantization="selectedVariantDetails?.label" :bytes="selectedVariantDetails?.bytes" :expanded="editingSuggestedConfiguration" selectable :checked="selected?.id === model.id && models.modelVariant({ id: model.id }) === currentVariant" :selection-disabled="models.busy.value || selectedVariantDetails === undefined" @toggle="editingSuggestedConfiguration = !editingSuggestedConfiguration" @choose="chooseSuggestedConfiguration({ id: model.id })" />
                        </template>
                        <template v-if="details?.kind === 'huggingface' && (!model.suggested || editingSuggestedConfiguration)" #source>
                          <ModelSelectorRepositorySource :repository="details.repository" :url="details.repositoryUrl" :files="details.files" />
                        </template>
                        <div v-if="details?.kind === 'huggingface'" tw-class="space-y-2">
                          <ModelSelectorFileOptions test-id="audio-transcription-model-variant" v-if="variants.length && (!model.suggested || editingSuggestedConfiguration)" :model-name="model.name" :selected="model.suggested || selected?.id === model.id ? currentVariant : undefined" :choices="variants" :disabled="models.busy.value" @select="chooseVariant({ id: $event })">
                            <template #action="{ choice }"><ModelSelectorVariantDownload :request="models.variantDownloadRequest({ id: model.id, variantId: choice.id })" :label="choice.label" :refresh-inventory="models.refresh" :disabled="models.downloadDestination.unavailable.value || models.downloadDestination.view.busy.value" /></template>
                          </ModelSelectorFileOptions>
                          <button type="button" :disabled="checkingVariants" :title="lazyStrings.ModelSelector__fetch_configuration()" tw-class="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800 motion-reduce:transition-none" @click="checkVariants">
                            <Loader2Icon v-if="checkingVariants" aria-hidden="true" tw-class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                            <GlobeIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5 text-gray-500 dark:text-gray-400" />
                            {{ lazyStrings.ModelSelector__show_configuration() }}
                          </button>
                          <p v-if="checkedVariants && models.quantizationsFailure.value" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.AudioTranscriptionModelSelector__could_not_get_quantizations() }}</p>
                          <p v-else-if="checkedVariants && !variants.length" role="status" tw-class="text-xs text-gray-500">{{ lazyStrings.AudioTranscriptionModelSelector__no_gguf_choices() }}</p>
                          <LlamaCppBrowserDownloadDestination v-if="model.availability === 'download_required'" :view="models.downloadDestination.view" :disabled="false" :layout-file="selectedVariantDetails ? { repository: details.repository, path: selectedVariantDetails.filePath } : undefined" :popup-target="panel" layout="compact" />
                        </div>
                        <p v-else-if="details?.kind === 'local'" tw-class="flex justify-between gap-2 text-xs text-gray-500 dark:text-gray-400">
                          <span tw-class="min-w-0 break-words">{{ details.fileName || details.name }}</span>
                          <span tw-class="shrink-0 whitespace-nowrap tabular-nums">{{ formatDownloadBytes({ bytes: details.bytes }) }}</span>
                        </p>
                      </ModelSelectorConfiguration>
                    </template>
                  </ModelSelectorRepositoryRow>
                </li>
              </ul>
            </section>
            <p v-if="groups.every(group => group.models.length === 0)" role="status" tw-class="px-2 py-5 text-center text-xs text-gray-500">{{ isRefreshing ? lazyStrings.ModelSelector__loading_models() : query ? lazyStrings.ModelSelector__no_models_found() : lazyStrings.AudioTranscriptionModelSelector__no_saved_models() }}</p>
            <button v-if="tab === 'compatible' && query.trim() && otherMatching.length" type="button" tw-class="min-h-8 rounded-lg px-2 text-xs font-medium text-blue-700 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-blue-300 dark:hover:bg-blue-500/10" @click="showTab({ id: 'saved' })">{{ lazyStrings.AudioTranscriptionModelSelector__more_matching_models({ count: otherMatching.length }) }}</button>
          </div>
          <div v-if="hfVisited" v-show="tab === 'huggingface'" :inert="tab !== 'huggingface' || undefined" tw-class="px-3 pb-3">
            <AudioTranscriptionModelSources :models="models" :disabled="false" :popup-target="panel" :active="open && tab === 'huggingface'" v-model:query="huggingFaceQuery" @selected="close" />
          </div>
          <div v-if="fileVisited" v-show="tab === 'files'" :inert="tab !== 'files' || undefined" tw-class="p-3">
            <ModelSelectorFileImport v-model:added="addedModels" :selected-model-id="models.selectedModelId.value" :disabled="models.busy.value" :import-files="models.importModels" @choose="chooseAddedModel({ modelId: $event.modelId })" />
          </div>
        </div>

      </dialog>
    </Transition>
  </Teleport>
</template>

<style scoped>
.model-picker-dialog {
  margin: 0;
  container: model-picker / inline-size;
}
.model-picker-dialog:not([open]) {
  display: none;
}
.model-picker-dialog.model-picker-expanded {
  position: fixed;
  inset: 0;
  margin: auto;
  inline-size: min(54rem, calc(100% - 2rem));
  block-size: min(44rem, calc(100dvh - 2rem));
  max-inline-size: none;
  max-block-size: none;
}
.model-picker-dialog::backdrop {
  background-color: rgb(15 23 42 / 32%);
  animation: model-picker-backdrop-in 190ms ease-out both;
}
@keyframes model-picker-backdrop-in {
  from {
    opacity: 0;
  }
}
.transcription-model-picker-enter-active,
.transcription-model-picker-leave-active {
  transition: opacity 170ms ease, translate 170ms ease;
}
.transcription-model-picker-enter-from,
.transcription-model-picker-leave-to {
  opacity: 0;
  translate: 0 -5px;
}
.model-picker-above.transcription-model-picker-enter-from,
.model-picker-above.transcription-model-picker-leave-to {
  translate: 0 5px;
}
.model-picker-scroll {
  scroll-padding-block-start: 3.75rem;
}
.model-picker-tab-indicator {
  transition: transform 190ms cubic-bezier(0.2, 0.8, 0.2, 1), width 190ms ease-out;
}
@media (prefers-reduced-motion: reduce) {
  .transcription-model-picker-enter-active,
  .transcription-model-picker-leave-active,
  .model-picker-tab-indicator {
    transition: none;
  }
  .model-picker-dialog::backdrop {
    animation: none;
  }
}
</style>
