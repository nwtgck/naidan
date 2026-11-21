<script setup lang="ts">
import { ref, computed, nextTick, watch, useSlots, useId, inject, type Ref } from 'vue';
import { SearchIcon, RefreshCwIcon, ChevronDownIcon, Loader2Icon, XIcon, ArrowLeftIcon, FolderPlusIcon, DownloadIcon, Maximize2Icon, Minimize2Icon } from 'lucide-vue-next';
import { useWindowSize, useResizeObserver } from '@vueuse/core';
import { useAnchoredPopup } from '@/composables/useAnchoredPopup';
import { useEventTargetListener } from '@/composables/useEventTargetListener';
import { provideModelSelectorHuggingFaceSearchState } from '@/composables/useModelSelectorHuggingFaceSearchState';
import SettingsSourceBadge from './SettingsSourceBadge.vue';
import type { SettingsSourcePresentation } from './SettingsSourceBadge.vue';
import { splitModelIdDisplay, trySplitRepositoryModelId } from '@/01-models/llama-cpp-browser-model-id';
import { lazyStrings } from '@/strings';
import ModelSelectorStoredVariantsRow from './ModelSelectorStoredVariantsRow.vue';
import { groupStoredModelVariants } from '@/features/llama-cpp-browser/hugging-face/stored-model-variant-groups';
import { splitModelName } from '@/utils/model-name';
import { modelSearchFilter, type ModelSelectorItem } from './model-selector-item';

type ChatModelSelectorPanel = { id: string, label: string | undefined, placement?: 'before-models' };

const disclosureOpen = inject<Readonly<Ref<boolean>> | undefined>('settings-disclosure-open', undefined);
const disclosureFocusReturn = inject<(() => HTMLElement | undefined) | undefined>('settings-disclosure-focus-return', undefined);
const props = defineProps<{
  modelValue: string | undefined,
  placeholder?: string,
  loading?: boolean,
  allowClear?: boolean,
  models: readonly ModelSelectorItem[],
  modelsLabel?: string,
  panels?: readonly ChatModelSelectorPanel[],
  initialPanel?: string,
  selectionAvailability?: ModelSelectorItem['availability'],
  hideFirstUseDownloadHint?: boolean,
  query?: string,
  disabled?: boolean,
  clearLabel?: string,
  inputId?: string,
  invalid?: boolean,
  surface?: 'default' | 'composer' | 'sidebar' | 'settings',
  frame?: 'standalone' | 'embedded',
  popupPresentation?: 'floating' | 'inline',
  chevronVisibility?: 'visible' | 'hidden',
  inheritedModel?: { id: string | undefined, source: SettingsSourcePresentation | undefined },
  modelSelection?: 'available' | 'unavailable',
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | undefined): void,
  (e: 'refresh'): void,
  (e: 'update:query', value: string): void,
  (e: 'update:open', open: boolean): void,
}>();

const slots = useSlots();
provideModelSelectorHuggingFaceSearchState();
const triggerDetailId = useId();
const modelSelectionUnavailable = computed(() => props.disabled || props.modelSelection === 'unavailable');
// Providers own the inventory and external requests. Typing in this component
// only filters these supplied values; it never authorizes a network request.
const modelChoices = computed(() => {
  const reference = props.modelValue || props.inheritedModel?.id;
  if (reference === undefined || props.models.some(model => model.id === reference)) {
    return props.models;
  }
  const configured = trySplitRepositoryModelId({ modelId: reference });
  if (configured?.configuration === undefined) {
    return props.models;
  }
  // Inventory reports canonical files. Re-selecting its active configured row
  // must preserve the current text-only or explicit projector choice.
  return props.models.map(model => model.id === configured.baseId && model.availability === 'local'
    ? { ...model, id: reference } : model);
});
const modelIndex = computed(() => new Map(modelChoices.value.map(model => [model.id, model])));
const availableModels = computed(() => modelChoices.value.map(model => model.id));
const isFetchingModels = computed(() => !!props.loading);
const selectedModel = computed(() => props.modelValue === undefined ? undefined : modelIndex.value.get(props.modelValue));

function modelLabel({ model }: { model: string }): string {
  const label = modelIndex.value.get(model)?.label ?? model;
  return label === model ? trySplitRepositoryModelId({ modelId: model })?.baseId ?? model : label;
}

function displayedModelParts({ model }: { model: string | undefined }): ReturnType<typeof splitModelName> {
  if (model === undefined) {
    return { prefix: '', suffix: undefined };
  }
  const label = modelLabel({ model });
  const baseId = /^(?:hf\.co|host)\//.test(label) ? trySplitRepositoryModelId({ modelId: label })?.baseId : undefined;
  if (baseId !== undefined) {
    const { source, name, variant } = splitModelIdDisplay({ modelId: baseId });
    return { prefix: source, suffix: variant === undefined ? name : `${name}:${variant}` };
  }
  return splitModelName({ name: label });
}

const displayModelName = computed(() => {
  const model = props.modelValue || props.inheritedModel?.id;
  return model ? modelLabel({ model }) : props.placeholder || lazyStrings.ModelSelector__select_a_model();
});
const inheritedModelParts = computed(() => props.inheritedModel?.id ? displayedModelParts({ model: props.inheritedModel.id }) : splitModelName({ name: props.clearLabel }));


const displayReference = computed(() => props.modelValue || props.inheritedModel?.id || displayModelName.value);
const modelNameParts = computed(() => props.modelValue || props.inheritedModel?.id ? displayedModelParts({ model: props.modelValue || props.inheritedModel?.id }) : splitModelName({ name: displayModelName.value }));
const modelHasMetadata = computed(() => Boolean(modelNameParts.value.prefix || (!props.modelValue && props.inheritedModel?.source)));
const inheritedModelHasMetadata = computed(() => Boolean(inheritedModelParts.value.prefix || props.inheritedModel?.source));

const filteredModels = computed(() => {
  if (!searchQuery.value.trim()) {
    return availableModels.value;
  }
  const matches = modelSearchFilter({ query: searchQuery.value });
  return availableModels.value.filter(model => matches({ fields: [model, modelLabel({ model }), modelIndex.value.get(model)?.description] }));
});

const modelOptions = computed(() => filteredModels.value.map(model => {
  const label = modelLabel({ model });
  const title = trySplitRepositoryModelId({ modelId: model })?.configuration === undefined ? label : model;
  return { model, title, details: modelIndex.value.get(model), parts: displayedModelParts({ model }) };
}));

const groupedModels = computed(() => groupStoredModelVariants({
  items: modelOptions.value,
  identity: ({ item }) => {
    const availability = item.details?.availability;
    switch (availability) {
    case 'local': return { id: item.model, modelId: item.model, fallback: { name: item.parts.suffix ?? item.title, source: item.details?.description ?? item.parts.prefix.slice(0, -1) } };
    case 'download_required': case 'remote': case 'checking': case undefined:
      return { id: item.model, modelId: undefined };
    default: throw new Error(String(availability satisfies never));
    }
  },
}));

const isOpen = ref(false);
const expanded = ref(false);
const sizeButton = ref<HTMLButtonElement>();
const popupId = useId();
const tabStrip = ref<HTMLElement>();
const tabIndicator = ref<{ transform: string, width: string }>();
const animateTabIndicator = ref(false);
const viewport = ref<HTMLElement>();
const filterToolbar = ref<HTMLElement>();
const scrollPositions = new Map<string | undefined, number>();
const panelView = ref<'models' | 'sources' | 'panel'>('models');
const activePanelId = ref<string>();
const currentTab = computed(() => {
  switch (panelView.value) {
  case 'panel': return activePanelId.value;
  case 'models': case 'sources': return panelView.value;
  default: throw new Error(String(panelView.value satisfies never));
  }
});
const tabs = computed(() => [
  ...(props.panels?.filter(panel => panel.placement === 'before-models') ?? []),
  { id: 'models', label: props.modelsLabel ?? lazyStrings.ModelSelector__models() },
  ...(props.panels?.filter(panel => panel.placement === undefined) ?? []),
]);
const visitedPanels = ref(new Set<string>());
const auxiliaryOpen = computed(() => {
  switch (panelView.value) {
  case 'models': return false;
  case 'sources': case 'panel': return true;
  default: {
    const exhaustive: never = panelView.value;
    return exhaustive;
  }
  }
});
const sourceBackRef = ref<HTMLButtonElement>();
const localQuery = ref('');
const searchQuery = computed({
  get: () => props.query ?? localQuery.value,
  set: value => {
    localQuery.value = value;
    emit('update:query', value);
  },
});
const highlightedIndex = ref(-1);
const containerRef = ref<HTMLElement | null>(null);
const searchInputRef = ref<HTMLInputElement | null>(null);
const dropdownRef = ref<HTMLDialogElement | null>(null);
const listContainerRef = ref<HTMLElement | null>(null);

const { width: windowWidth } = useWindowSize();
const popup = useAnchoredPopup({
  anchor: containerRef,
  preferredWidth: { unit: 'px', value: 560 },
  maxWidthPx: 640,
  horizontalAlignment: () => {
    const surface = props.surface;
    switch (surface) {
    case 'composer': return 'center';
    case 'default': case 'sidebar': case 'settings': case undefined: return 'left';
    default: throw new Error(String(surface satisfies never));
    }
  },
});
const dropdownPosition = computed(() => popup.placement.value.direction);
const floatingStyle = computed(() => popup.placement.value.style);

function updateTabIndicator(): void {
  const selected = tabStrip.value?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
  tabIndicator.value = selected ? { transform: `translateX(${selected.offsetLeft}px)`, width: `${selected.offsetWidth}px` } : undefined;
}

useResizeObserver(tabStrip, updateTabIndicator);
watch([tabStrip, currentTab, tabs], updateTabIndicator, { flush: 'post' });
watch(currentTab, async (tab, previous) => {
  if (previous !== undefined && viewport.value) {
    scrollPositions.set(previous, viewport.value.scrollTop);
  }
  await nextTick();
  if (tab !== undefined && currentTab.value === tab && viewport.value) {
    viewport.value.scrollTop = scrollPositions.get(tab) ?? 0;
  }
}, { flush: 'sync' });

function showDialog(): void {
  const dialog = dropdownRef.value;
  if (!dialog || dialog.open) {
    return;
  }
  if (expanded.value) {
    dialog.showModal();
  } else if (typeof dialog.show === 'function') {
    dialog.show();
  } else {
    dialog.open = true;
  }
}

function toggleSize(): void {
  const dialog = dropdownRef.value;
  if (!dialog?.open || typeof dialog.showModal !== 'function') {
    return;
  }
  const previous = dialog.getBoundingClientRect();
  dialog.close();
  expanded.value = !expanded.value;
  showDialog();
  void nextTick(() => {
    sizeButton.value?.focus({ preventScroll: true });
    if (!isOpen.value || dropdownRef.value !== dialog || !previous.width || !previous.height || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || typeof dialog.animate !== 'function') {
      return;
    }
    for (const animation of dialog.getAnimations()) {
      animation.cancel();
    }
    const current = dialog.getBoundingClientRect();
    if (current.width && current.height) {
      dialog.animate([
        { transformOrigin: 'top left', transform: `translate(${previous.left - current.left}px, ${previous.top - current.top}px) scale(${previous.width / current.width}, ${previous.height / current.height})` },
        { transformOrigin: 'top left', transform: 'none' },
      ], { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    }
  });
}

watch(dropdownRef, showDialog, { flush: 'post' });
useEventTargetListener(document, 'pointerdown', event => {
  if (!isOpen.value || expanded.value || event.button !== 0) {
    return;
  }
  const path = event.composedPath();
  const dialog = dropdownRef.value;
  const trigger = containerRef.value;
  if ((!dialog || !path.includes(dialog)) && (!trigger || !path.includes(trigger))) {
    closeDropdown({ restoreFocus: false });
  }
}, { capture: true });

function activeStoredVariantId({ variants }: { variants: readonly { item: { model: string } }[] }): string {
  return (variants.find(({ item }) => item.model === (props.modelValue || props.inheritedModel?.id)) ?? variants[0]!).item.model;
}

const combinedOptions = computed(() => {
  const options: (string | undefined)[] = props.allowClear ? [undefined] : [];
  for (const row of groupedModels.value) {
    switch (row.kind) {
    case 'single': options.push(row.item.model);
      break;
    case 'variants': options.push(activeStoredVariantId({ variants: row.variants }));
      break;
    default: throw new Error(String(row satisfies never));
    }
  }
  return options;
});
const optionIndices = computed(() => new Map(combinedOptions.value.map((id, index) => [id, index])));

function toggleDropdown() {
  if (isOpen.value) {
    closeDropdown({ restoreFocus: true });
    return;
  }
  openDropdown();
}

function openDropdown(): void {
  if (props.disabled || (modelSelectionUnavailable.value && !slots.settings)) {
    return;
  }
  popup.refresh();
  if (isOpen.value) {
    return;
  }
  expanded.value = false;
  scrollPositions.clear();
  tabIndicator.value = undefined;
  animateTabIndicator.value = false;
  isOpen.value = true;
  panelView.value = 'models';
  if (props.initialPanel !== undefined) {
    openPanel({ id: props.initialPanel });
  }
  searchQuery.value = '';
  const currentIndex = optionIndices.value.get(props.modelValue) ?? -1;
  highlightedIndex.value = currentIndex >= 0 ? currentIndex : 0;

  void nextTick(() => {
    popup.refresh();
    if (modelSelectionUnavailable.value) {
      dropdownRef.value?.querySelector<HTMLButtonElement>('[data-testid="model-selector-settings"] button:not(:disabled)')?.focus();
    } else if (!auxiliaryOpen.value) {
      searchInputRef.value?.focus();
    } else {
      tabStrip.value?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
    }
    scrollToHighlighted();
  });
}

function isPanelOpen({ id }: { id: string }): boolean {
  return isOpen.value && panelView.value === 'panel' && activePanelId.value === id;
}

function selectModel({ model, keepOpen }: { model: string | undefined, keepOpen?: boolean }) {
  if (!isOpen.value || modelSelectionUnavailable.value || (model !== undefined && !availableModels.value.includes(model))) {
    return;
  }
  emit('update:modelValue', model);
  if (!keepOpen) {
    closeDropdown({ restoreFocus: true });
  }
}

function selectTab({ id }: { id: string }): void {
  if (currentTab.value === id) {
    return;
  }
  animateTabIndicator.value = tabIndicator.value !== undefined;
  if (id === 'models') {
    backToModels();
  } else {
    openPanel({ id });
  }
}

function openPanel({ id }: { id: string }): void {
  if (!props.panels?.some(panel => panel.id === id)) {
    return;
  }
  visitedPanels.value = new Set(visitedPanels.value).add(id);
  activePanelId.value = id;
  panelView.value = 'panel';
  popup.refresh();
}

function openSources(): void {
  panelView.value = 'sources';
  popup.refresh();
  void nextTick(() => sourceBackRef.value?.focus());
}

function backToModels(): void {
  panelView.value = 'models';
  void nextTick(() => searchInputRef.value?.focus({ preventScroll: true }));
}

function closeSources(): void {
  closeDropdown({ restoreFocus: true });
}

function clearFilter() {
  searchQuery.value = '';
  searchInputRef.value?.focus();
}

function scrollToHighlighted() {
  nextTick(() => {
    const list = listContainerRef.value;
    const container = props.panels?.length ? viewport.value : list;
    const highlighted = list?.querySelector<HTMLElement>(`[data-index="${highlightedIndex.value}"]`);
    if (!container || !highlighted) {
      return;
    }
    const bounds = container.getBoundingClientRect();
    const top = props.panels?.length ? Math.max(bounds.top, filterToolbar.value?.getBoundingClientRect().bottom ?? bounds.top) : bounds.top;
    const row = highlighted.getBoundingClientRect();
    if (row.top < top) {
      container.scrollTop -= top - row.top;
    } else if (row.bottom > bounds.bottom) {
      container.scrollTop += row.bottom - bounds.bottom;
    }
  });
}

function handleKeydown({ event }: { event: KeyboardEvent }) {
  if (props.disabled || event.isComposing || event.keyCode === 229) {
    return;
  }
  if (!isOpen.value) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter') {
      event.preventDefault();
      toggleDropdown();
    }
    return;
  }

  // Source workflows include native file dialogs and drag/drop. Their inputs
  // own navigation keys, and losing browser focus must not dismiss the work.
  if (auxiliaryOpen.value) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeDropdown({ restoreFocus: true });
    }
    return;
  }

  // Native buttons act on their own value, rather than the search highlight.
  if (event.target instanceof HTMLButtonElement && dropdownRef.value?.contains(event.target) && event.key !== 'Escape' && event.key !== 'Tab') {
    return;
  }

  if (modelSelectionUnavailable.value && event.key !== 'Escape' && event.key !== 'Tab') {
    return;
  }

  switch (event.key) {
  case 'ArrowDown':
    event.preventDefault();
    if (!combinedOptions.value.length) {
      return;
    }
    highlightedIndex.value = (highlightedIndex.value + 1) % combinedOptions.value.length;
    scrollToHighlighted();
    break;
  case 'ArrowUp':
    event.preventDefault();
    if (!combinedOptions.value.length) {
      return;
    }
    highlightedIndex.value = (highlightedIndex.value - 1 + combinedOptions.value.length) % combinedOptions.value.length;
    scrollToHighlighted();
    break;
  case 'Enter': {
    event.preventDefault();
    if (highlightedIndex.value >= 0 && highlightedIndex.value < combinedOptions.value.length) {
      selectModel({ model: combinedOptions.value[highlightedIndex.value] });
    }
    break;
  }
  case 'Escape':
    event.preventDefault();
    event.stopPropagation();
    closeDropdown({ restoreFocus: true });
    break;
  case 'Tab':
    break;
  }
}

function handleDropdownKeydown({ event }: { event: KeyboardEvent }): void {
  const presentation = props.popupPresentation;
  switch (presentation) {
  case 'inline':
    // Inline menus live under the trigger's root key handler. Handle each key
    // once, and let a popup Escape close the menu before its containing dialog.
    event.stopPropagation();
    break;
  case 'floating':
  case undefined: break;
  default: {
    const exhaustive: never = presentation;
    throw new Error(`Unhandled popup presentation: ${exhaustive}`);
  }
  }
  handleKeydown({ event });
}

async function handleRefresh({ event }: { event: Event }) {
  event.stopPropagation();
  if (modelSelectionUnavailable.value || isFetchingModels.value) {
    return;
  }
  emit('refresh');
}

function closeDropdown({ restoreFocus }: { restoreFocus: boolean }) {
  if (dropdownRef.value?.open) {
    dropdownRef.value.close?.();
  }
  isOpen.value = false;
  if (restoreFocus) {
    containerRef.value?.querySelector<HTMLButtonElement>('button')?.focus();
  }
}

function handleSettingsKeydown({ event }: { event: KeyboardEvent }) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeDropdown({ restoreFocus: true });
  }
}

function handleSidebarFocus({ event }: { event: FocusEvent }) {
  const surface = props.surface;
  switch (surface) {
  case 'sidebar':
    break;
  case undefined:
  case 'default':
  case 'composer':
  case 'settings':
    return;
  default: {
    const _ex: never = surface;
    throw new Error(`Unhandled model selector surface: ${_ex}`);
  }
  }
  if (event.target === searchInputRef.value) {
    const currentIndex = optionIndices.value.get(props.modelValue) ?? -1;
    highlightedIndex.value = currentIndex >= 0 ? currentIndex : combinedOptions.value.length ? 0 : -1;
  } else if (event.target instanceof HTMLElement) {
    const index = event.target.dataset.index;
    highlightedIndex.value = index === undefined ? -1 : Number(index);
  }
}

watch(isOpen, open => emit('update:open', open));
watch(() => props.panels, panels => {
  if (panelView.value === 'panel' && !panels?.some(panel => panel.id === activePanelId.value)) {
    backToModels();
  }
});

// Reset highlighted index when filtering
watch(searchQuery, () => {
  if (isOpen.value) {
    highlightedIndex.value = combinedOptions.value.length > 0 ? 0 : -1;
  }
});

watch(() => props.disabled, disabled => {
  if (disabled) {
    closeDropdown({ restoreFocus: false });
  }
});

watch(windowWidth, () => {
  if (isOpen.value) {
    popup.refresh();
  }
});


watch(() => disclosureOpen?.value, value => {
  if (value === false) {
    if (document.activeElement instanceof Node && dropdownRef.value?.contains(document.activeElement)) {
      disclosureFocusReturn?.()?.focus();
    }
    closeDropdown({ restoreFocus: false });
  }
});
defineExpose({
  openDropdown,
  isPanelOpen,
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div :class="{ 'model-selector-sidebar': surface === 'sidebar' }" :tw-class="['relative w-full', surface === 'settings' && 'min-w-0 flex-1']" ref="containerRef" @keydown="handleKeydown({ event: $event })">
    <!-- Trigger -->
    <button
      type="button"
      :id="inputId"
      :aria-invalid="invalid || undefined"
      :aria-label="surface === 'settings' || inheritedModel ? [displayModelName, modelValue ? undefined : inheritedModel?.source?.description].filter(Boolean).join(' · ') : undefined"
      :aria-expanded="isOpen"
      aria-haspopup="dialog"
      :aria-describedby="$slots['trigger-detail'] ? triggerDetailId : undefined"
      :aria-busy="isFetchingModels || undefined"
      :aria-controls="isOpen ? popupId : undefined"
      @click="toggleDropdown"
      :disabled="disabled || (modelSelectionUnavailable && !$slots.settings)"
      :title="displayReference"
      :tw-class="[
        'w-full flex items-center justify-between gap-2 text-xs text-gray-700 dark:text-gray-200 outline-none disabled:opacity-50 disabled:cursor-not-allowed transition-colors',
        surface === 'settings'
          ? frame === 'embedded' ? 'min-h-[58px] rounded-none border-0 bg-transparent px-3.5 py-2.5 font-medium shadow-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/30 dark:hover:bg-gray-800' : 'min-h-[60px] rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 font-medium hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:border-gray-700/60 dark:bg-gray-800/55 dark:hover:bg-gray-800'
          : surface === 'composer'
            ? 'h-9 px-2 rounded-xl font-medium bg-transparent hover:bg-gray-100 dark:hover:bg-gray-700/50 focus-visible:ring-2 focus-visible:ring-gray-400/50'
            : surface === 'sidebar'
              ? 'flex-col items-stretch gap-1 rounded-xl border border-transparent bg-transparent px-3 py-2.5 font-semibold hover:bg-gray-100/70 dark:hover:bg-gray-800/60 focus-visible:ring-2 focus-visible:ring-blue-500/25'
              : 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2.5 font-bold focus:ring-4 focus:ring-blue-500/10 hover:border-gray-300 dark:hover:border-gray-600 shadow-sm',
        isOpen ? surface === 'settings' ? 'ring-2 ring-inset ring-blue-500/25' : surface === 'composer' ? 'bg-gray-100 dark:bg-gray-700/50' : surface === 'sidebar' ? 'bg-gray-100/80 dark:bg-gray-800/70' : 'ring-4 ring-blue-500/10 border-blue-500/50' : ''
      ]"
      data-testid="model-selector-trigger"
    >
      <div v-if="surface === 'sidebar' && ($slots['trigger-label'] || $slots['trigger-summary'])" tw-class="flex min-w-0 items-center justify-between gap-3 text-[10px] leading-4 font-medium text-gray-500 dark:text-gray-400">
        <span tw-class="min-w-0 truncate text-left"><slot name="trigger-label"></slot></span>
        <span v-if="$slots['trigger-summary']" class="model-selector-trigger-summary" tw-class="min-w-0 shrink-0 text-right font-normal text-gray-400 dark:text-gray-500"><slot name="trigger-summary"></slot></span>
      </div>
      <div tw-class="flex w-full min-w-0 items-center justify-between gap-2">
        <span v-if="surface === 'settings' || inheritedModel || $slots['trigger-detail']" tw-class="block min-w-0 flex-1 text-left">
          <span :tw-class="['block truncate', surface === 'settings' ? 'text-sm leading-5' : 'text-xs leading-4']">{{ modelNameParts.suffix }}</span>
          <span v-if="modelHasMetadata || $slots['trigger-detail']" data-testid="model-selector-trigger-metadata" tw-class="mt-0.5 flex h-4 min-w-0 items-center gap-1.5"><SettingsSourceBadge :source="modelValue ? undefined : inheritedModel?.source" /><span :tw-class="['min-w-0 flex-1 truncate font-normal leading-4 text-gray-500 dark:text-gray-400', surface === 'settings' ? 'text-xs' : 'text-[11px]']">{{ modelNameParts.prefix.replace(/\/$/, '') }}</span><span v-if="$slots['trigger-detail']" :id="triggerDetailId" tw-class="shrink-0"><slot name="trigger-detail" /></span></span>
        </span>
        <div v-else tw-class="flex items-center min-w-0 flex-1 overflow-hidden">
          <span
            v-if="modelNameParts.prefix"
            tw-class="font-normal whitespace-nowrap overflow-hidden min-w-0"
            style="direction: rtl; text-align: left; text-overflow: ellipsis; flex: 0 1000 auto;"
          >
            <bdi style="direction: ltr; unicode-bidi: isolate;">{{ modelNameParts.prefix }}</bdi>
          </span>
          <span tw-class="truncate min-w-0 flex-1 text-left" style="flex: 1 1 auto;">
            {{ modelNameParts.suffix }}
          </span>
        </div>
        <span v-if="!hideFirstUseDownloadHint && (selectionAvailability ?? selectedModel?.availability) === 'download_required'" data-testid="chat-model-selector-download-hint" :aria-label="lazyStrings.ModelSelector__downloads_automatically()" :title="lazyStrings.ModelSelector__download_before_first_use()" tw-class="flex shrink-0 items-center gap-1 text-[10px] font-normal text-gray-400 dark:text-gray-500"><DownloadIcon aria-hidden="true" tw-class="h-3 w-3" /><span tw-class="whitespace-nowrap">{{ lazyStrings.ModelSelector__downloads_automatically() }}</span></span>
        <div v-if="isFetchingModels || chevronVisibility !== 'hidden'" :tw-class="['flex items-center justify-end shrink-0', surface === 'sidebar' ? 'w-9 gap-1' : 'gap-1.5 ml-1']">
          <Loader2Icon v-if="isFetchingModels" tw-class="w-3 h-3 animate-spin text-gray-400" />
          <span v-if="surface === 'sidebar' && chevronVisibility !== 'hidden'" tw-class="flex h-5 w-5 shrink-0 items-center justify-center">
            <ChevronDownIcon
              :stroke-width="1.75"
              :tw-class="['h-3.5 w-3.5 transition-all duration-200', isOpen ? 'text-blue-500 dark:text-blue-400' : 'text-gray-400 dark:text-gray-500', { 'rotate-180': isOpen }]"
            />
          </span>
          <ChevronDownIcon
            v-else-if="chevronVisibility !== 'hidden'"
            :tw-class="['w-3.5 h-3.5 text-gray-400 transition-transform duration-200', { 'rotate-180': isOpen }]"
          />
        </div>
      </div>
    </button>

    <!-- Inline mode keeps this menu inside an aria-modal and its scroll region. -->
    <Teleport to="body" :disabled="popupPresentation === 'inline'">
      <!-- Sticky toolbars share the opaque panel background to cover scrolling rows. -->
      <dialog
        v-if="isOpen"
        :id="popupId"
        ref="dropdownRef"
        :aria-modal="expanded || undefined"
        :aria-label="lazyStrings.ModelSelector__select_a_model()"
        :style="expanded || popupPresentation === 'inline' ? undefined : floatingStyle"
        @cancel.prevent="closeSources"
        data-testid="model-selector-dropdown"
        class="animate-in fade-in" :tw-class="[
          'm-0 flex flex-col p-0 bg-[var(--model-selector-panel-background)] [--model-selector-panel-background:var(--color-white)] [--settings-select-menu-background:var(--model-selector-panel-background)] text-gray-800 dark:text-gray-200 border border-gray-200 rounded-2xl shadow-xl overflow-hidden duration-200 motion-reduce:animate-none',
          popupPresentation === 'inline' ? 'mt-1.5 w-full' : '',
          surface === 'composer' ? 'dark:[--model-selector-panel-background:var(--color-gray-800)]' : 'dark:[--model-selector-panel-background:var(--color-gray-900)]',
          surface === 'sidebar' ? 'dark:border-gray-700/80' : 'dark:border-gray-700'
        ]"
        :class="[
          'chat-model-selector-dialog',
          panels?.length && 'chat-model-selector-tabbed',
          expanded && 'chat-model-selector-expanded',
          !expanded && (popupPresentation === 'inline' || dropdownPosition === 'bottom' ? 'slide-in-from-top-2' : 'slide-in-from-bottom-2'),
        ]"
        @keydown="handleDropdownKeydown({ event: $event })"
        @focusin="handleSidebarFocus({ event: $event })"
      >
        <div v-if="panelView !== 'sources'" :tw-class="['flex min-h-11 shrink-0 items-end justify-between gap-2 border-b px-3 pt-1.5', surface === 'composer' ? 'border-gray-200 dark:border-gray-700' : 'border-gray-100 dark:border-gray-800']">
          <div ref="tabStrip" role="group" data-testid="chat-model-selector-tabs" tw-class="relative flex min-w-0 items-center gap-2 overflow-x-auto">
            <span v-if="tabIndicator" :style="tabIndicator" aria-hidden="true" data-testid="chat-model-selector-tab-indicator" :class="{ 'chat-model-selector-tab-indicator-moving': animateTabIndicator }" tw-class="pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full bg-blue-500/80 dark:bg-blue-400/80" />
            <button v-for="tab in tabs" :key="tab.id" type="button" :aria-pressed="currentTab === tab.id" tw-class="shrink-0 whitespace-nowrap px-2 pb-2.5 pt-2 text-xs font-medium text-gray-500 transition-colors hover:text-gray-800 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-500 aria-pressed:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200 dark:aria-pressed:text-gray-100 motion-reduce:transition-none" @click="selectTab({ id: tab.id })">{{ tab.label }}</button>
          </div>
          <div tw-class="flex shrink-0 items-center gap-1 self-center">
            <slot name="header-action" :close="closeSources" />
            <button v-if="popupPresentation !== 'inline'" ref="sizeButton" type="button" :aria-label="expanded ? lazyStrings.ModelSelector__shrink() : lazyStrings.ModelSelector__expand()" :title="expanded ? lazyStrings.ModelSelector__shrink() : lazyStrings.ModelSelector__expand()" tw-class="grid h-8 w-8 place-items-center rounded-lg text-gray-500 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-gray-700" @click="toggleSize"><Minimize2Icon v-if="expanded" aria-hidden="true" tw-class="h-4 w-4" /><Maximize2Icon v-else aria-hidden="true" tw-class="h-4 w-4" /></button>
            <button v-if="expanded" type="button" @click="closeSources" :aria-label="lazyStrings.ModelSelector__close()" tw-class="grid h-8 w-8 place-items-center rounded-lg text-gray-500 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-gray-700"><XIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
          </div>
        </div>
        <div v-else tw-class="flex min-h-11 shrink-0 items-center justify-between gap-3 border-b border-gray-100 px-3 dark:border-gray-800">
          <button ref="sourceBackRef" type="button" @click="backToModels" :aria-label="lazyStrings.ModelSelector__back_to_models()" tw-class="flex min-h-9 min-w-0 items-center gap-2 rounded-lg px-2 text-xs font-medium text-gray-500 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-300 dark:hover:bg-gray-700"><ArrowLeftIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" />{{ lazyStrings.ModelSelector__add_model_files() }}</button>
          <button type="button" @click="closeSources" :aria-label="lazyStrings.ModelSelector__close()" tw-class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-gray-400 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-gray-700"><XIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
        </div>
        <div ref="viewport" tw-class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div v-if="$slots.toolbar && panelView !== 'sources'" tw-class="border-b border-gray-100 px-3 py-2 dark:border-gray-700"><slot name="toolbar" /></div>
          <div v-for="panel in panels" :key="panel.id" v-show="panelView === 'panel' && activePanelId === panel.id" :inert="panelView !== 'panel' || activePanelId !== panel.id || undefined" :aria-hidden="panelView !== 'panel' || activePanelId !== panel.id" tw-class="px-3 pb-3">
            <slot v-if="visitedPanels.has(panel.id)" name="panel" :panel="panel.id" :query="searchQuery" :active="panelView === 'panel' && activePanelId === panel.id" :close="closeSources" :popup-target="dropdownRef ?? undefined" />
          </div>
          <div v-if="panelView === 'sources'" data-testid="chat-model-selector-sources" tw-class="p-3">
            <slot name="sources" :close="closeSources" />
          </div>
          <div v-show="panelView === 'models'" :inert="panelView !== 'models' || undefined" :aria-hidden="panelView !== 'models'" :tw-class="[panels?.length && 'px-3 pb-3']">
            <!-- Search and Actions -->
            <div ref="filterToolbar" :tw-class="['flex items-center gap-1.5 bg-[var(--model-selector-panel-background)]', panels?.length ? 'sticky top-0 z-10 pt-4 pb-2' : 'border-b border-gray-200 p-2 dark:border-gray-700', surface === 'sidebar' && 'shrink-0 dark:border-gray-800']">
              <div tw-class="relative min-w-0 flex-1">
                <SearchIcon tw-class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                <input
                  ref="searchInputRef"
                  data-testid="model-selector-filter"
                  v-model="searchQuery"
                  :disabled="modelSelectionUnavailable"
                  type="text"
                  :tw-class="[
                    'w-full rounded-lg pl-8 text-xs outline-none placeholder:text-gray-400 dark:placeholder:text-gray-300 disabled:cursor-not-allowed',
                    panels?.length ? 'h-9 border border-gray-200 bg-white pr-8 text-gray-800 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/15 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100' : surface === 'sidebar' ? 'pr-8 py-2 bg-transparent text-gray-700 dark:text-gray-200 focus:bg-gray-50 dark:focus:bg-gray-800 focus:ring-2 focus:ring-blue-500/15' : 'pr-2 py-1.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 focus:ring-2 focus:ring-blue-500/20'
                  ]"
                  :placeholder="lazyStrings.ModelSelector__filter_models()"
                  :aria-label="lazyStrings.ModelSelector__filter_models()"
                  @click.stop
                />
                <button type="button"
                        v-if="searchQuery"
                        data-testid="model-selector-clear-filter"
                        :title="lazyStrings.ModelSelector__clear_filter()"
                        @click="clearFilter"
                        tw-class="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-400"
                >
                  <XIcon tw-class="w-3 h-3" />
                </button>
              </div>
              <button type="button"
                      data-testid="model-selector-refresh"
                      @click="handleRefresh({ event: $event })"
                      :tw-class="[
                        'p-2 shrink-0 rounded-lg text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                        panels?.length ? 'grid h-9 w-9 place-items-center border border-gray-200 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-gray-700 dark:hover:bg-gray-800' : surface === 'sidebar' ? 'hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/25' : 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:border-blue-200 dark:hover:border-blue-900/50 shadow-sm'
                      ]"
                      :disabled="modelSelectionUnavailable || isFetchingModels"
                      :title="lazyStrings.ModelSelector__refresh_model_list()"
              >
                <RefreshCwIcon :tw-class="['w-3.5 h-3.5', { 'animate-spin': isFetchingModels }]" />
              </button>
            </div>

            <!-- List -->
            <!-- Keep some list space; on very short viewports the whole panel can scroll too. -->
            <div ref="listContainerRef" data-testid="model-selector-list" class="custom-scrollbar" :tw-class="[panels?.length ? 'divide-y divide-gray-100 dark:divide-gray-800' : 'max-h-60 overflow-y-auto overscroll-contain py-1', surface === 'sidebar' ? 'min-h-24 flex-auto px-1.5' : '']">
              <div v-if="surface === 'sidebar' && modelSelectionUnavailable && $slots.unavailable" data-testid="model-selector-unavailable" tw-class="px-3 py-4 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                <slot name="unavailable"></slot>
              </div>
              <!-- Inherited / Default option -->
              <button type="button"
                      v-if="allowClear"
                      @click="selectModel({ model: undefined })"
                      :tw-class="['flex min-h-10 w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs transition-colors',
                                  !modelValue
                                    ? 'bg-gray-100 ring-1 ring-inset ring-gray-300 font-bold text-blue-600 dark:bg-gray-700/50 dark:ring-gray-600 dark:text-blue-400'
                                    : 'text-gray-500 dark:text-gray-400',
                                  highlightedIndex === 0
                                    ? 'bg-gray-100 dark:bg-gray-700/50'
                                    : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
                      ]"
                      :disabled="modelSelectionUnavailable"
                      data-testid="model-selector-clear"
                      :aria-label="inheritedModel ? [inheritedModel.id || clearLabel, inheritedModel.source?.description].filter(Boolean).join(' · ') : undefined"
                      data-index="0"
                      @mouseenter="highlightedIndex = 0"
              >
                <div tw-class="flex min-w-0 flex-1 items-center gap-2">
                  <XIcon v-if="modelValue" aria-hidden="true" tw-class="h-4 w-4 shrink-0" />
                  <span v-if="inheritedModel" tw-class="block min-w-0 flex-1">
                    <span :tw-class="['block truncate font-medium', surface === 'settings' ? 'text-sm leading-5' : 'text-xs leading-4']">{{ inheritedModelParts.suffix || clearLabel || lazyStrings.ModelSelector__inherit() }}</span>
                    <span v-if="inheritedModelHasMetadata" data-testid="model-selector-clear-metadata" tw-class="mt-0.5 flex min-w-0 items-center gap-1.5"><SettingsSourceBadge :source="inheritedModel.source" /><span tw-class="min-w-0 flex-1 truncate text-xs font-normal text-gray-500 dark:text-gray-400">{{ inheritedModelParts.prefix.replace(/\/$/, '') }}</span></span>
                  </span>
                  <template v-else><span tw-class="truncate">{{ clearLabel || placeholder || lazyStrings.ModelSelector__inherit() }}</span></template>
                </div>
              </button>

              <div v-if="filteredModels.length === 0 && !(surface === 'sidebar' && modelSelectionUnavailable && $slots.unavailable)" tw-class="px-4 py-8 text-center">
                <p data-testid="model-selector-empty" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ surface === 'sidebar' && isFetchingModels ? lazyStrings.ModelSelector__loading_models() : surface === 'sidebar' && !availableModels.length && !searchQuery.trim() ? lazyStrings.ModelSelector__no_models_available() : lazyStrings.ModelSelector__no_models_found() }}</p>
              </div>
              <div v-for="row in groupedModels" :key="row.key">
                <ModelSelectorStoredVariantsRow
                  v-if="row.kind === 'variants'" :name="row.name" :source="row.source"
                  :choices="row.variants.map(({ item, label }) => ({ id: item.model, modelId: item.model, label, title: item.title }))"
                  :selected-id="modelValue || inheritedModel?.id" :disabled="modelSelectionUnavailable"
                  :popup-target="dropdownRef ?? undefined"
                  :index="optionIndices.get(activeStoredVariantId({ variants: row.variants }))" :highlighted="highlightedIndex === optionIndices.get(activeStoredVariantId({ variants: row.variants }))"
                  @choose="selectModel({ model: $event })" @change-variant="selectModel({ model: $event, keepOpen: true })"
                  @mouseenter="highlightedIndex = optionIndices.get(activeStoredVariantId({ variants: row.variants })) ?? -1"
                >
                  <template v-if="$slots['model-action']" #actions="{ id }"><slot name="model-action" :id="id" :model="modelIndex.get(id)" /></template>
                </ModelSelectorStoredVariantsRow>
                <div v-else tw-class="flex items-center">
                  <button type="button" data-testid="model-selector-option" :disabled="modelSelectionUnavailable" @click="selectModel({ model: row.item.model })" :title="row.item.title" :aria-pressed="row.item.model === modelValue" :data-index="optionIndices.get(row.item.model)" @mouseenter="highlightedIndex = optionIndices.get(row.item.model) ?? -1" :tw-class="['flex min-h-10 min-w-0 flex-1 items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-xs transition-colors focus-visible:outline-2 focus-visible:outline-blue-500', row.item.model === modelValue ? 'bg-gray-100 ring-1 ring-inset ring-gray-300 font-medium text-blue-600 dark:bg-gray-700/50 dark:ring-gray-600 dark:text-blue-400' : 'text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700/50', highlightedIndex === optionIndices.get(row.item.model) && 'ring-1 ring-inset ring-gray-300 dark:ring-gray-600']">
                    <span tw-class="flex min-w-0 flex-1 flex-col">
                      <span data-testid="model-selector-option-name" tw-class="truncate font-medium">{{ row.item.parts.suffix }}</span>
                      <span v-if="row.item.details?.description || row.item.parts.prefix || row.item.details?.availability === 'download_required'" tw-class="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] font-normal text-gray-500 dark:text-gray-400">
                        <span v-if="row.item.details?.description || row.item.parts.prefix" tw-class="min-w-0 truncate">{{ row.item.details?.description || row.item.parts.prefix.slice(0, -1) }}</span>
                        <span v-if="row.item.details?.availability === 'download_required'" :title="lazyStrings.ModelSelector__download_before_first_use()" tw-class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap"><DownloadIcon aria-hidden="true" tw-class="h-3 w-3" />{{ lazyStrings.ModelSelector__downloads_automatically() }}</span>
                      </span>
                    </span>
                  </button>
                  <div v-if="$slots['model-action']" tw-class="shrink-0 pr-2"><slot name="model-action" :id="row.item.model" :model="row.item.details" /></div>
                </div>
              </div>
            </div>
            <div v-if="$slots['selection-details']" tw-class="border-t border-gray-100 px-3 py-2 dark:border-gray-700"><slot name="selection-details" /></div>
            <div v-if="$slots.sources && !$slots['header-action']" tw-class="border-t border-gray-100 p-2 dark:border-gray-700">
              <button type="button" data-testid="chat-model-selector-open-sources" @click="openSources" tw-class="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-xs font-medium text-gray-500 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-300 dark:hover:bg-gray-700"><FolderPlusIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.ModelSelector__add_model_files() }}</button>
            </div>
          </div>
        </div>
        <div v-if="$slots.settings" data-testid="model-selector-settings" :tw-class="['shrink-0 border-t border-gray-100 px-3', surface === 'sidebar' || surface === 'composer' ? 'py-2' : 'py-3', surface === 'sidebar' ? 'shrink-0 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-800/30' : 'dark:border-gray-700']" @keydown.stop="handleSettingsKeydown({ event: $event })">
          <slot name="settings"></slot>
        </div>
      </dialog>
    </Teleport>
  </div>
</template>

<style scoped>
.chat-model-selector-dialog {
  container: model-picker / inline-size;
}
.chat-model-selector-dialog.chat-model-selector-tabbed {
  height: 30rem;
}
.chat-model-selector-dialog:not([open]) {
  display: none;
}
.chat-model-selector-tab-indicator-moving {
  transition: transform 180ms ease, width 180ms ease;
}
@media (prefers-reduced-motion: reduce) {
  .chat-model-selector-tab-indicator-moving {
    transition: none;
  }
}
.chat-model-selector-dialog.chat-model-selector-expanded {
  position: fixed;
  inset: 0;
  margin: auto;
  width: min(64rem, calc(100vw - 2rem));
  height: min(42rem, calc(100dvh - 2rem));
}
.chat-model-selector-dialog::backdrop {
  background: rgb(15 23 42 / 42%);
}

.model-selector-sidebar {
  container-type: inline-size;
  container-name: model-selector-sidebar;
}

@container model-selector-sidebar (max-width: 14rem) {
  .model-selector-trigger-summary {
    display: none;
  }
}

.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(156, 163, 175, 0.3);
  border-radius: 10px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: rgba(156, 163, 175, 0.5);
}

.animate-in {
  animation-duration: 200ms;
}

@keyframes fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes slide-in-from-bottom-2 {
  from {
    transform: translateY(0.5rem);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

@keyframes slide-in-from-top-2 {
  from {
    transform: translateY(-0.5rem);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.fade-in {
  animation-name: fade-in;
}

.slide-in-from-bottom-2 {
  animation-name: slide-in-from-bottom-2;
}

.slide-in-from-top-2 {
  animation-name: slide-in-from-top-2;
}
</style>
