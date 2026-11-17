<script lang="ts">
export type ModelSelectorV2Model = {
  id: string,
  label: string,
  description: string | undefined,
  availability: 'local' | 'download_required' | 'remote',
};
export type ModelSelectorV2Panel = { id: string, label: string | undefined };
</script>

<script setup lang="ts">
import { ref, computed, nextTick, watch, useSlots, useId, inject, type Ref } from 'vue';
import { SearchIcon, RefreshCwIcon, CheckIcon, ChevronDownIcon, Loader2Icon, XIcon, ArrowLeftIcon, FolderPlusIcon, DownloadIcon } from 'lucide-vue-next';
import { useWindowSize } from '@vueuse/core';
import { useAnchoredPopup } from '@/composables/useAnchoredPopup';
import SettingsSourceBadge from './SettingsSourceBadge.vue';
import type { SettingsSourcePresentation } from './SettingsSourceBadge.vue';
import { lazyStrings } from '@/strings';
import { splitModelName } from '@/utils/model-name';

const disclosureOpen = inject<Readonly<Ref<boolean>> | undefined>('settings-disclosure-open', undefined);
const disclosureFocusReturn = inject<(() => HTMLElement | undefined) | undefined>('settings-disclosure-focus-return', undefined);
const props = defineProps<{
  modelValue: string | undefined,
  placeholder?: string,
  loading?: boolean,
  allowClear?: boolean,
  models: readonly ModelSelectorV2Model[],
  panels?: readonly ModelSelectorV2Panel[],
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
const triggerDetailId = useId();
const modelSelectionUnavailable = computed(() => props.disabled || props.modelSelection === 'unavailable');
// Providers own the inventory and external requests. Typing in this component
// only filters these supplied values; it never authorizes a network request.
const modelIndex = computed(() => new Map(props.models.map(model => [model.id, model])));
const availableModels = computed(() => props.models.map(model => model.id));
const isFetchingModels = computed(() => !!props.loading);
const selectedModel = computed(() => props.modelValue === undefined ? undefined : modelIndex.value.get(props.modelValue));

function modelLabel({ model }: { model: string }): string {
  return modelIndex.value.get(model)?.label ?? model;
}

const displayModelName = computed(() => {
  const model = props.modelValue || props.inheritedModel?.id;
  return model ? modelLabel({ model }) : props.placeholder || lazyStrings.ModelSelector__select_a_model();
});
const inheritedModelParts = computed(() => splitModelName({ name: props.inheritedModel?.id ? modelLabel({ model: props.inheritedModel.id }) : props.clearLabel }));


const modelNameParts = computed(() => splitModelName({ name: displayModelName.value }));
const modelHasMetadata = computed(() => Boolean(modelNameParts.value.prefix || (!props.modelValue && props.inheritedModel?.source)));
const inheritedModelHasMetadata = computed(() => Boolean(inheritedModelParts.value.prefix || props.inheritedModel?.source));

const searchableModels = computed(() => {
  return availableModels.value.map(m => ({
    original: m,
    lower: `${m} ${modelLabel({ model: m })} ${modelIndex.value.get(m)?.description ?? ''}`.toLowerCase(),
  }));
});

const filteredModels = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) {
    return availableModels.value;
  }

  const keywords = q.split(/[\s\u3000]+/).filter(k => !!k);
  if (keywords.length === 0) {
    return availableModels.value;
  }

  return searchableModels.value
    .filter(item => keywords.every(kw => item.lower.includes(kw)))
    .map(item => item.original);
});

const modelOptions = computed(() => filteredModels.value.map(model => {
  const label = modelLabel({ model });
  return { model, label, details: modelIndex.value.get(model), parts: splitModelName({ name: label }) };
}));

const isOpen = ref(false);
const panelView = ref<'models' | 'sources' | 'panel'>('models');
const activePanelId = ref<string>();
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
const dropdownRef = ref<HTMLElement | null>(null);
const listContainerRef = ref<HTMLElement | null>(null);

const { width: windowWidth } = useWindowSize();
const popup = useAnchoredPopup({ anchor: containerRef, preferredWidth: { unit: 'px', value: 560 }, maxWidthPx: 640 });
const dropdownPosition = computed(() => popup.placement.value.direction);
const floatingStyle = computed(() => popup.placement.value.style);

const combinedOptions = computed(() => {
  const options: (string | undefined)[] = [];
  if (props.allowClear) {
    options.push(undefined);
  }
  options.push(...filteredModels.value);
  return options;
});


function toggleDropdown() {
  if (props.disabled || (modelSelectionUnavailable.value && !slots.settings)) {
    return;
  }
  popup.refresh();
  if (isOpen.value) {
    isOpen.value = false;
  } else {
    isOpen.value = true;
    panelView.value = 'models';
    searchQuery.value = '';
    // Set initial highlighted index to current model or first item
    const currentIndex = combinedOptions.value.indexOf(props.modelValue);
    highlightedIndex.value = currentIndex >= 0 ? currentIndex : 0;

    nextTick(() => {
      popup.refresh();
      if (modelSelectionUnavailable.value) {
        dropdownRef.value?.querySelector<HTMLButtonElement>('[data-testid="model-selector-settings"] button:not(:disabled)')?.focus();
      } else {
        searchInputRef.value?.focus();
      }
      scrollToHighlighted();
    });
  }
}

function selectModel({ model }: { model: string | undefined }) {
  if (!isOpen.value || modelSelectionUnavailable.value || (model !== undefined && !availableModels.value.includes(model))) {
    return;
  }
  emit('update:modelValue', model);
  closeDropdown({ restoreFocus: true });
}

function openPanel({ id }: { id: string }): void {
  if (!props.panels?.some(panel => panel.id === id)) {
    return;
  }
  activePanelId.value = id;
  visitedPanels.value = new Set(visitedPanels.value).add(id);
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
  void nextTick(() => searchInputRef.value?.focus());
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
    if (!listContainerRef.value) {
      return;
    }
    const container = listContainerRef.value;
    const highlightedEl = container.querySelector(`[data-index="${highlightedIndex.value}"]`) as HTMLElement;
    if (highlightedEl) {
      const containerRect = container.getBoundingClientRect();
      const elRect = highlightedEl.getBoundingClientRect();

      if (elRect.top < containerRect.top) {
        container.scrollTop -= (containerRect.top - elRect.top);
      } else if (elRect.bottom > containerRect.bottom) {
        container.scrollTop += (elRect.bottom - containerRect.bottom);
      }
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
  case 'Enter':
    event.preventDefault();
    if (highlightedIndex.value >= 0 && highlightedIndex.value < combinedOptions.value.length) {
      selectModel({ model: combinedOptions.value[highlightedIndex.value] });
    }
    break;
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

// This selector can contain file dialogs, background downloads and nested
// controls. Keep work visible until an explicit close, Escape or selection;
// browser focus changes and child popups must not discard the selection UI.
function closeDropdown({ restoreFocus }: { restoreFocus: boolean }) {
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
    const currentIndex = combinedOptions.value.indexOf(props.modelValue);
    highlightedIndex.value = currentIndex >= 0 ? currentIndex : combinedOptions.value.length ? 0 : -1;
  } else if (event.target instanceof HTMLElement) {
    const index = event.target.dataset.index;
    highlightedIndex.value = index === undefined ? -1 : Number(index);
  }
}

watch(isOpen, open => emit('update:open', open));

// Reset highlighted index when filtering
watch(searchQuery, () => {
  if (isOpen.value) {
    highlightedIndex.value = combinedOptions.value.length > 0 ? 0 : -1;
  }
});

watch(() => props.disabled, disabled => {
  if (disabled) {
    isOpen.value = false;
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
      @click="toggleDropdown"
      :disabled="disabled || (modelSelectionUnavailable && !$slots.settings)"
      :title="displayModelName"
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
        <span v-if="selectedModel?.availability === 'download_required'" data-testid="model-selector-v2-download-hint" :aria-label="lazyStrings.ModelSelector__downloads_automatically()" :title="lazyStrings.ModelSelector__download_before_first_use()" tw-class="flex shrink-0 items-center gap-1 text-[10px] font-normal text-gray-400 dark:text-gray-500"><DownloadIcon aria-hidden="true" tw-class="h-3 w-3" /><span tw-class="whitespace-nowrap">{{ lazyStrings.ModelSelector__downloads_automatically() }}</span></span>
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
      <div
        v-if="isOpen"
        ref="dropdownRef"
        role="dialog"
        :aria-label="lazyStrings.ModelSelector__select_a_model()"
        :style="popupPresentation === 'inline' ? undefined : floatingStyle"
        data-testid="model-selector-dropdown"
        class="animate-in fade-in" :tw-class="[
          'bg-white border border-gray-200 rounded-xl shadow-xl overflow-y-auto overscroll-contain duration-200',
          popupPresentation === 'inline' ? 'mt-1.5 w-full' : '',
          surface === 'sidebar' ? 'flex flex-col dark:bg-gray-900 dark:border-gray-700/80' : 'dark:bg-gray-800 dark:border-gray-700'
        ]"
        :class="popupPresentation === 'inline' || dropdownPosition === 'bottom' ? 'slide-in-from-top-2' : 'slide-in-from-bottom-2'"
        @keydown="handleDropdownKeydown({ event: $event })"
        @focusin="handleSidebarFocus({ event: $event })"
      >
        <div v-if="panelView !== 'sources'" tw-class="flex items-center justify-between gap-2 border-b border-gray-100 px-2 py-1.5 dark:border-gray-700">
          <div role="group" tw-class="flex min-w-0 items-center gap-1">
            <button type="button" :aria-pressed="panelView === 'models'" @click="backToModels" :tw-class="['min-h-9 rounded-lg px-3 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-blue-500', panelView === 'models' ? 'bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-white' : 'text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-700']">{{ lazyStrings.ModelSelector__models() }}</button>
            <button v-for="panel in panels" :key="panel.id" type="button" :aria-pressed="panelView === 'panel' && activePanelId === panel.id" @click="openPanel({ id: panel.id })" :tw-class="['min-h-9 rounded-lg px-3 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-blue-500', panelView === 'panel' && activePanelId === panel.id ? 'bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-white' : 'text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-700']">{{ panel.label }}</button>
          </div>
          <button type="button" @click="closeSources" :aria-label="lazyStrings.ModelSelector__close()" tw-class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-gray-400 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-gray-700"><XIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
        </div>
        <div v-if="$slots.toolbar && panelView !== 'sources'" tw-class="border-b border-gray-100 px-3 py-2 dark:border-gray-700"><slot name="toolbar" /></div>
        <div v-for="panel in panels" :key="panel.id" v-show="panelView === 'panel' && activePanelId === panel.id" :inert="panelView !== 'panel' || activePanelId !== panel.id || undefined" :aria-hidden="panelView !== 'panel' || activePanelId !== panel.id" tw-class="p-3">
          <slot v-if="visitedPanels.has(panel.id)" name="panel" :panel="panel.id" :query="searchQuery" :active="panelView === 'panel' && activePanelId === panel.id" :close="closeSources" />
        </div>
        <template v-if="panelView === 'sources'">
          <div tw-class="flex shrink-0 items-center justify-between gap-3 border-b border-gray-100 px-3 py-2 dark:border-gray-700">
            <button ref="sourceBackRef" type="button" @click="backToModels" :aria-label="lazyStrings.ModelSelector__back_to_models()" tw-class="flex min-h-9 min-w-0 items-center gap-2 rounded-lg px-2 text-xs font-medium text-gray-500 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-300 dark:hover:bg-gray-700"><ArrowLeftIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" />{{ lazyStrings.ModelSelector__add_model_files() }}</button>
            <button type="button" @click="closeSources" :aria-label="lazyStrings.ModelSelector__close()" tw-class="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-gray-400 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-gray-700"><XIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
          </div>
          <div data-testid="model-selector-v2-sources" tw-class="min-h-0 overflow-y-auto overscroll-contain p-3">
            <slot name="sources" :close="closeSources" />
          </div>
        </template>
        <div v-show="panelView === 'models'" :inert="panelView !== 'models' || undefined" :aria-hidden="panelView !== 'models'">
          <!-- Search and Actions -->
          <div :tw-class="['p-2 border-b border-gray-100 dark:border-gray-700 flex items-center gap-2', surface === 'sidebar' ? 'shrink-0 dark:border-gray-800' : 'bg-gray-50/50 dark:bg-gray-900/50']">
            <div tw-class="relative min-w-0 flex-1">
              <SearchIcon tw-class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              <input
                ref="searchInputRef"
                data-testid="model-selector-filter"
                v-model="searchQuery"
                :disabled="modelSelectionUnavailable"
                type="text"
                :tw-class="[
                  'w-full rounded-lg pl-8 text-xs outline-none placeholder:text-gray-400 disabled:cursor-not-allowed',
                  surface === 'sidebar' ? 'pr-8 py-2 bg-transparent text-gray-700 dark:text-gray-200 focus:bg-gray-50 dark:focus:bg-gray-800 focus:ring-2 focus:ring-blue-500/15' : 'pr-2 py-1.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 focus:ring-2 focus:ring-blue-500/20'
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
                      surface === 'sidebar' ? 'hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/25' : 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:border-blue-200 dark:hover:border-blue-900/50 shadow-sm'
                    ]"
                    :disabled="modelSelectionUnavailable || isFetchingModels"
                    :title="lazyStrings.ModelSelector__refresh_model_list()"
            >
              <RefreshCwIcon :tw-class="['w-3.5 h-3.5', { 'animate-spin': isFetchingModels }]" />
            </button>
          </div>

          <!-- List -->
          <!-- Keep some list space; on very short viewports the whole panel can scroll too. -->
          <div ref="listContainerRef" data-testid="model-selector-list" class="custom-scrollbar" :tw-class="['max-h-60 overflow-y-auto py-1 overscroll-contain', surface === 'sidebar' ? 'min-h-24 flex-auto px-1.5' : '']">
            <div v-if="surface === 'sidebar' && modelSelectionUnavailable && $slots.unavailable" data-testid="model-selector-unavailable" tw-class="px-3 py-4 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
              <slot name="unavailable"></slot>
            </div>
            <!-- Inherited / Default option -->
            <button type="button"
                    v-if="allowClear"
                    @click="selectModel({ model: undefined })"
                    :tw-class="['w-full flex items-center justify-between px-3 py-2 text-xs text-left transition-colors border-b border-gray-50 dark:border-gray-700/50 mb-1',
                                !modelValue
                                  ? 'text-blue-600 dark:text-blue-400 font-bold'
                                  : 'text-gray-500 dark:text-gray-400',
                                highlightedIndex === 0
                                  ? 'bg-gray-100 dark:bg-gray-700/50'
                                  : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
                    ]"
                    :disabled="modelSelectionUnavailable"
                    data-testid="model-selector-clear"
                    :aria-label="inheritedModel ? [inheritedModel.id || clearLabel, inheritedModel.source?.description].filter(Boolean).join(' · ') : undefined"
                    data-index="0"
                    @mouseenter="highlightedIndex = 0"
            >
              <div tw-class="flex min-w-0 flex-1 items-center gap-2">
                <XIcon v-if="modelValue" tw-class="w-3.5 h-3.5" />
                <span v-if="inheritedModel" tw-class="block min-w-0 flex-1">
                  <span :tw-class="['block truncate font-medium', surface === 'settings' ? 'text-sm leading-5' : 'text-xs leading-4']">{{ inheritedModelParts.suffix || clearLabel || lazyStrings.ModelSelector__inherit() }}</span>
                  <span v-if="inheritedModelHasMetadata" data-testid="model-selector-clear-metadata" tw-class="mt-0.5 flex min-w-0 items-center gap-1.5"><SettingsSourceBadge :source="inheritedModel.source" /><span tw-class="min-w-0 flex-1 truncate text-xs font-normal text-gray-500 dark:text-gray-400">{{ inheritedModelParts.prefix.replace(/\/$/, '') }}</span></span>
                </span>
                <template v-else><span tw-class="truncate">{{ clearLabel || placeholder || lazyStrings.ModelSelector__inherit() }}</span></template>
              </div>
              <CheckIcon v-if="!modelValue" tw-class="w-3.5 h-3.5 shrink-0" />
            </button>

            <div v-if="filteredModels.length === 0 && !(surface === 'sidebar' && modelSelectionUnavailable && $slots.unavailable)" tw-class="px-4 py-8 text-center">
              <p data-testid="model-selector-empty" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ surface === 'sidebar' && isFetchingModels ? lazyStrings.ModelSelector__loading_models() : surface === 'sidebar' && !availableModels.length && !searchQuery.trim() ? lazyStrings.ModelSelector__no_models_available() : lazyStrings.ModelSelector__no_models_found() }}</p>
            </div>
            <div v-for="({ model, label, details, parts }, index) in modelOptions" :key="model" tw-class="flex items-center">
              <button type="button" data-testid="model-selector-option" :disabled="modelSelectionUnavailable" @click="selectModel({ model })" :title="label" :aria-pressed="model === modelValue" :data-index="allowClear ? index + 1 : index" @mouseenter="highlightedIndex = allowClear ? index + 1 : index" :tw-class="['flex min-w-0 flex-1 items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-xs transition-colors focus-visible:outline-2 focus-visible:outline-blue-500', model === modelValue ? 'font-medium text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-200', highlightedIndex === (allowClear ? index + 1 : index) ? 'bg-gray-100 dark:bg-gray-700/50' : 'hover:bg-gray-50 dark:hover:bg-gray-700/50']">
                <span tw-class="flex min-w-0 flex-1 flex-col">
                  <span data-testid="model-selector-option-name" tw-class="truncate leading-5">{{ parts.suffix }}</span>
                  <span tw-class="flex min-w-0 items-center gap-2 text-[10px] font-normal leading-4 text-gray-400 dark:text-gray-500">
                    <span v-if="details?.description || parts.prefix" tw-class="min-w-0 truncate">{{ details?.description || parts.prefix.slice(0, -1) }}</span>
                    <span v-if="details?.availability === 'download_required'" :title="lazyStrings.ModelSelector__download_before_first_use()" tw-class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap"><DownloadIcon aria-hidden="true" tw-class="h-3 w-3" />{{ lazyStrings.ModelSelector__downloads_automatically() }}</span>
                    <span v-else-if="details?.availability === 'local'" :title="lazyStrings.ModelSelector__on_this_device()"><CheckIcon aria-hidden="true" tw-class="h-3 w-3" /></span>
                  </span>
                </span>
                <CheckIcon v-if="model === modelValue" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />
              </button>
              <div v-if="$slots['model-action']" tw-class="shrink-0 pr-2"><slot name="model-action" :id="model" :model="details" /></div>
            </div>
          </div>
          <div v-if="$slots['selection-details']" tw-class="border-t border-gray-100 px-3 py-2 dark:border-gray-700"><slot name="selection-details" /></div>
          <div v-if="$slots.sources" tw-class="border-t border-gray-100 p-2 dark:border-gray-700">
            <button type="button" data-testid="model-selector-v2-open-sources" @click="openSources" tw-class="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-xs font-medium text-gray-500 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-300 dark:hover:bg-gray-700"><FolderPlusIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.ModelSelector__add_model_files() }}</button>
          </div>
          <div v-if="$slots.settings" data-testid="model-selector-settings" :tw-class="['border-t border-gray-100 px-3', surface === 'sidebar' || surface === 'composer' ? 'py-2' : 'py-3', surface === 'sidebar' ? 'shrink-0 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-800/30' : 'dark:border-gray-700']" @keydown.stop="handleSettingsKeydown({ event: $event })">
            <slot name="settings"></slot>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
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
