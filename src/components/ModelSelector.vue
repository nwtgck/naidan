<script setup lang="ts">
import { ref, computed, useAttrs, nextTick, getCurrentInstance, watch, useSlots, inject, type Ref } from 'vue';
import { SearchIcon, RefreshCwIcon, CheckIcon, ChevronDownIcon, Loader2Icon, XIcon } from 'lucide-vue-next';
import { useSettings } from '@/composables/useSettings';
import { useEventTargetListener } from '@/composables/useEventTargetListener';
import { useWindowSize } from '@vueuse/core';
import { useAnchoredPopup } from '@/composables/useAnchoredPopup';
import SettingsSourceBadge from './SettingsSourceBadge.vue';
import type { SettingsSourcePresentation } from './SettingsSourceBadge.vue';
import { lazyStrings } from '@/strings';

const disclosureOpen = inject<Readonly<Ref<boolean>> | undefined>('settings-disclosure-open', undefined);
const disclosureFocusReturn = inject<(() => HTMLElement | undefined) | undefined>('settings-disclosure-focus-return', undefined);
const props = defineProps<{
  modelValue: string | undefined,
  placeholder?: string,
  loading?: boolean,
  allowClear?: boolean,
  models?: readonly string[],
  disabled?: boolean,
  clearLabel?: string,
  modelLabels?: Readonly<Record<string, string>>,
  inputId?: string,
  invalid?: boolean,
  surface?: 'default' | 'composer' | 'sidebar' | 'settings',
  frame?: 'standalone' | 'embedded',
  inheritedModel?: { id: string | undefined, source: SettingsSourcePresentation | undefined },
  modelSelection?: 'available' | 'unavailable',
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | undefined): void,
  (e: 'refresh'): void,
  (e: 'update:open', open: boolean): void,
}>();

const attrs = useAttrs();
const slots = useSlots();
const modelSelectionUnavailable = computed(() => props.disabled || props.modelSelection === 'unavailable');
const instance = getCurrentInstance();
const { availableModels: settingsModels, isFetchingModels: isInternalFetching, fetchModels: internalFetch } = useSettings();

const availableModels = computed(() => props.models ?? settingsModels.value);
const isFetchingModels = computed(() => props.models !== undefined ? !!props.loading : props.loading || (isInternalFetching?.value ?? false));

function modelLabel({ model }: { model: string }): string {
  return props.modelLabels?.[model] ?? model;
}

const displayModelName = computed(() => {
  const model = props.modelValue || props.inheritedModel?.id;
  return model ? modelLabel({ model }) : props.placeholder || lazyStrings.ModelSelector__select_a_model();
});
const inheritedModelParts = computed(() => splitModelName({ name: props.inheritedModel?.id ? modelLabel({ model: props.inheritedModel.id }) : props.clearLabel }));

function splitModelName({ name }: { name: string | undefined }) {
  if (name === undefined) {
    return { prefix: '', suffix: undefined };
  }
  const lastSlashIndex = name.lastIndexOf('/');
  if (lastSlashIndex === -1) {
    return { prefix: '', suffix: name };
  }
  return {
    prefix: name.slice(0, lastSlashIndex + 1),
    suffix: name.slice(lastSlashIndex + 1),
  };
}

const modelNameParts = computed(() => splitModelName({ name: displayModelName.value }));
const modelHasMetadata = computed(() => Boolean(modelNameParts.value.prefix || (!props.modelValue && props.inheritedModel?.source)));
const inheritedModelHasMetadata = computed(() => Boolean(inheritedModelParts.value.prefix || props.inheritedModel?.source));

const searchableModels = computed(() => {
  return availableModels.value.map(m => ({
    original: m,
    lower: `${m} ${modelLabel({ model: m })}`.toLowerCase(),
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
  return { model, label, parts: splitModelName({ name: label }) };
}));

const isOpen = ref(false);
const searchQuery = ref('');
const highlightedIndex = ref(-1);
const containerRef = ref<HTMLElement | null>(null);
const searchInputRef = ref<HTMLInputElement | null>(null);
const dropdownRef = ref<HTMLElement | null>(null);
const listContainerRef = ref<HTMLElement | null>(null);

const { width: windowWidth } = useWindowSize();
const popup = useAnchoredPopup({ anchor: containerRef, preferredWidth: { unit: 'px', value: 480 }, maxWidthPx: 640 });
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

  // Native buttons act on their own value, rather than the search highlight.
  if ((props.surface === 'sidebar' || props.surface === 'settings') && event.target instanceof HTMLButtonElement && dropdownRef.value?.contains(event.target) && event.key !== 'Escape' && event.key !== 'Tab') {
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
    closeDropdown({ restoreFocus: true });
    break;
  case 'Tab':
    if (!slots.settings) {
      closeDropdown({ restoreFocus: props.surface === 'settings' });
    }
    break;
  }
}

async function handleRefresh({ event }: { event: Event }) {
  event.stopPropagation();
  if (modelSelectionUnavailable.value || isFetchingModels.value) {
    return;
  }
  // Check if parent has a listener for 'refresh' (onRefresh)
  const hasRefreshListener = !!(instance?.vnode.props?.onRefresh || attrs.onRefresh);
  if (hasRefreshListener) {
    emit('refresh');
  } else if (props.models === undefined) {
    // Explicit lists must not refresh an unrelated chat provider.
    await internalFetch({});
  }
}

function handleClickOutside({ event }: { event: MouseEvent }) {
  const target = event.target as Node;
  const isInsideTrigger = containerRef.value?.contains(target);
  const isInsideDropdown = dropdownRef.value?.contains(target);

  if (!isInsideTrigger && !isInsideDropdown) {
    isOpen.value = false;
  }
}

useEventTargetListener(document, 'mousedown', (event) => handleClickOutside({ event }));
useEventTargetListener(document, 'focusin', event => {
  const target = event.target as Node;
  if (isOpen.value && !containerRef.value?.contains(target) && !dropdownRef.value?.contains(target)) {
    closeDropdown({ restoreFocus: false });
  }
});

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

// Close on width resize to prevent floating detached dropdown (e.g. orientation change)
// We ignore height changes to prevent closing when mobile software keyboard appears
watch(() => props.disabled, disabled => {
  if (disabled) {
    isOpen.value = false;
  }
});

watch(windowWidth, () => {
  if (isOpen.value) {
    isOpen.value = false;
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
        <span v-if="surface === 'settings' || inheritedModel" tw-class="block min-w-0 flex-1 text-left">
          <span :tw-class="['block truncate', surface === 'settings' ? 'text-sm leading-5' : 'text-xs leading-4']">{{ modelNameParts.suffix }}</span>
          <span v-if="modelHasMetadata" data-testid="model-selector-trigger-metadata" tw-class="mt-0.5 flex h-4 min-w-0 items-center gap-1.5"><SettingsSourceBadge :source="modelValue ? undefined : inheritedModel?.source" /><span :tw-class="['min-w-0 flex-1 truncate font-normal leading-4 text-gray-500 dark:text-gray-400', surface === 'settings' ? 'text-xs' : 'text-[11px]']">{{ modelNameParts.prefix.replace(/\/$/, '') }}</span></span>
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
        <div :tw-class="['flex items-center justify-end shrink-0', surface === 'sidebar' ? 'w-9 gap-1' : 'gap-1.5 ml-1']">
          <Loader2Icon v-if="isFetchingModels" tw-class="w-3 h-3 animate-spin text-gray-400" />
          <span v-if="surface === 'sidebar'" tw-class="flex h-5 w-5 shrink-0 items-center justify-center">
            <ChevronDownIcon
              :stroke-width="1.75"
              :tw-class="['h-3.5 w-3.5 transition-all duration-200', isOpen ? 'text-blue-500 dark:text-blue-400' : 'text-gray-400 dark:text-gray-500', { 'rotate-180': isOpen }]"
            />
          </span>
          <ChevronDownIcon
            v-else
            :tw-class="['w-3.5 h-3.5 text-gray-400 transition-transform duration-200', { 'rotate-180': isOpen }]"
          />
        </div>
      </div>
    </button>

    <!-- Dropdown Teleported -->
    <Teleport to="body">
      <div
        v-if="isOpen"
        ref="dropdownRef"
        :style="floatingStyle"
        data-testid="model-selector-dropdown"
        class="animate-in fade-in" :tw-class="[
          'bg-white border border-gray-200 rounded-xl shadow-xl overflow-y-auto overscroll-contain duration-200',
          surface === 'sidebar' ? 'flex flex-col dark:bg-gray-900 dark:border-gray-700/80' : 'dark:bg-gray-800 dark:border-gray-700'
        ]"
        :class="dropdownPosition === 'bottom' ? 'slide-in-from-top-2' : 'slide-in-from-bottom-2'"
        @keydown="handleKeydown({ event: $event })"
        @focusin="handleSidebarFocus({ event: $event })"
      >
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
          <button type="button"
                  v-for="({ model, label, parts }, index) in modelOptions"
                  :key="model"
                  data-testid="model-selector-option"
                  :disabled="modelSelectionUnavailable"
                  @click="selectModel({ model })"
                  :title="label"
                  :aria-pressed="model === modelValue"
                  :tw-class="['w-full flex items-center justify-between px-3 py-2 text-xs text-left transition-colors',
                              surface === 'sidebar' ? 'gap-3 min-h-14 rounded-lg disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/30' : '',
                              model === modelValue
                                ? surface === 'sidebar' ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 font-semibold' : 'text-blue-600 dark:text-blue-400 font-bold'
                                : 'text-gray-700 dark:text-gray-300',
                              highlightedIndex === (allowClear ? index + 1 : index)
                                ? surface === 'sidebar' ? 'ring-1 ring-inset ring-gray-300 dark:ring-gray-600' : 'bg-gray-100 dark:bg-gray-700/50'
                                : surface === 'sidebar' ? 'hover:bg-gray-100/80 dark:hover:bg-gray-800/70' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
                  ]"
                  :data-index="allowClear ? index + 1 : index"
                  @mouseenter="highlightedIndex = allowClear ? index + 1 : index"
          >
            <span :tw-class="['flex min-w-0 flex-1 flex-col gap-0.5', surface === 'sidebar' ? '' : 'pr-2']">
              <span data-testid="model-selector-option-name" tw-class="block truncate leading-5">{{ parts.suffix }}</span>
              <span v-if="parts.prefix" data-testid="model-selector-option-namespace" tw-class="block truncate text-[10px] leading-4 font-normal text-gray-400 dark:text-gray-500">{{ parts.prefix.slice(0, -1) }}</span>
            </span>
            <CheckIcon v-if="model === modelValue" tw-class="w-3.5 h-3.5 shrink-0" />
          </button>
        </div>
        <div v-if="$slots.settings" data-testid="model-selector-settings" :tw-class="['border-t border-gray-100 px-3', surface === 'sidebar' || surface === 'composer' ? 'py-2' : 'py-3', surface === 'sidebar' ? 'shrink-0 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-800/30' : 'dark:border-gray-700']" @keydown.stop="handleSettingsKeydown({ event: $event })">
          <slot name="settings"></slot>
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
