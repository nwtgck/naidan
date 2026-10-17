<script setup lang="ts">
import { ref, computed, useAttrs, nextTick, getCurrentInstance, watch, useSlots } from 'vue';
import { SearchIcon, RefreshCwIcon, CheckIcon, ChevronDownIcon, Loader2Icon, XIcon } from 'lucide-vue-next';
import { useSettings } from '@/composables/useSettings';
import { useEventTargetListener } from '@/composables/useEventTargetListener';
import { useWindowSize } from '@vueuse/core';
import { useAnchoredPopup } from '@/composables/useAnchoredPopup';
import { lazyStrings } from '@/strings';

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
  surface?: 'default' | 'composer',
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

const displayModelName = computed(() => props.modelValue ? modelLabel({ model: props.modelValue }) : props.placeholder || lazyStrings.ModelSelector__select_a_model());

const modelNameParts = computed(() => {
  const name = displayModelName.value;
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
});

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
  if (modelSelectionUnavailable.value || (model !== undefined && !availableModels.value.includes(model))) {
    return;
  }
  emit('update:modelValue', model);
  closeDropdown({ restoreFocus: true });
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
      isOpen.value = false;
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


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div tw-class="relative w-full" ref="containerRef" @keydown="handleKeydown({ event: $event })">
    <!-- Trigger -->
    <button
      type="button"
      :id="inputId"
      :aria-invalid="invalid || undefined"
      :aria-expanded="isOpen"
      @click="toggleDropdown"
      :disabled="disabled || (modelSelectionUnavailable && !$slots.settings)"
      :title="displayModelName"
      :tw-class="[
        'w-full flex items-center justify-between gap-2 text-xs text-gray-700 dark:text-gray-200 outline-none disabled:opacity-50 disabled:cursor-not-allowed transition-colors',
        surface === 'composer'
          ? 'h-9 px-2 rounded-xl font-medium bg-transparent hover:bg-gray-100 dark:hover:bg-gray-700/50 focus-visible:ring-2 focus-visible:ring-gray-400/50'
          : 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2.5 font-bold focus:ring-4 focus:ring-blue-500/10 hover:border-gray-300 dark:hover:border-gray-600 shadow-sm',
        isOpen ? surface === 'composer' ? 'bg-gray-100 dark:bg-gray-700/50' : 'ring-4 ring-blue-500/10 border-blue-500/50' : ''
      ]"
      data-testid="model-selector-trigger"
    >
      <div tw-class="flex items-center min-w-0 flex-1 overflow-hidden">
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
      <div tw-class="flex items-center gap-1.5 shrink-0 ml-1">
        <Loader2Icon v-if="isFetchingModels" tw-class="w-3 h-3 animate-spin text-gray-400" />
        <ChevronDownIcon
          :tw-class="['w-3.5 h-3.5 text-gray-400 transition-transform duration-200', { 'rotate-180': isOpen }]"
        />
      </div>
    </button>

    <!-- Dropdown Teleported -->
    <Teleport to="body">
      <div
        v-if="isOpen"
        ref="dropdownRef"
        :style="floatingStyle"
        data-testid="model-selector-dropdown"
        class="animate-in fade-in" tw-class="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl overflow-y-auto overscroll-contain duration-200"
        :class="dropdownPosition === 'bottom' ? 'slide-in-from-top-2' : 'slide-in-from-bottom-2'"
        @keydown="handleKeydown({ event: $event })"
      >
        <!-- Search and Actions -->
        <div tw-class="p-2 border-b border-gray-100 dark:border-gray-700 flex items-center gap-2 bg-gray-50/50 dark:bg-gray-900/50">
          <div tw-class="relative flex-1">
            <SearchIcon tw-class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              ref="searchInputRef"
              data-testid="model-selector-filter"
              v-model="searchQuery"
              :disabled="modelSelectionUnavailable"
              type="text"
              tw-class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg pl-8 pr-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-blue-500/20 placeholder:text-gray-400"
              :placeholder="lazyStrings.ModelSelector__filter_models()"
              @click.stop
            />
            <button type="button"
                    v-if="searchQuery"
                    @click="searchQuery = ''"
                    tw-class="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-400"
            >
              <XIcon tw-class="w-3 h-3" />
            </button>
          </div>
          <button type="button"
                  data-testid="model-selector-refresh"
                  @click="handleRefresh({ event: $event })"
                  tw-class="p-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 hover:border-blue-200 dark:hover:border-blue-900/50 transition-colors shadow-sm disabled:opacity-50"
                  :disabled="modelSelectionUnavailable || isFetchingModels"
                  :title="lazyStrings.ModelSelector__refresh_model_list()"
          >
            <RefreshCwIcon :tw-class="['w-3.5 h-3.5', { 'animate-spin': isFetchingModels }]" />
          </button>
        </div>

        <!-- List -->
        <div ref="listContainerRef" class="custom-scrollbar" tw-class="max-h-60 overflow-y-auto py-1 overscroll-contain">
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
                  data-index="0"
                  @mouseenter="highlightedIndex = 0"
          >
            <div tw-class="flex items-center gap-2">
              <XIcon v-if="modelValue" tw-class="w-3.5 h-3.5" />
              <span tw-class="truncate">{{ clearLabel || placeholder || lazyStrings.ModelSelector__inherit() }}</span>
            </div>
            <CheckIcon v-if="!modelValue" tw-class="w-3.5 h-3.5 shrink-0" />
          </button>

          <div v-if="filteredModels.length === 0" tw-class="px-4 py-8 text-center">
            <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ModelSelector__no_models_found() }}</p>
          </div>
          <button type="button"
                  v-for="(model, index) in filteredModels"
                  :key="model"
                  data-testid="model-selector-option"
                  :disabled="modelSelectionUnavailable"
                  @click="selectModel({ model })"
                  :tw-class="['w-full flex items-center justify-between px-3 py-2 text-xs text-left transition-colors',
                              model === modelValue
                                ? 'text-blue-600 dark:text-blue-400 font-bold'
                                : 'text-gray-700 dark:text-gray-300',
                              highlightedIndex === (allowClear ? index + 1 : index)
                                ? 'bg-gray-100 dark:bg-gray-700/50'
                                : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
                  ]"
                  :data-index="allowClear ? index + 1 : index"
                  @mouseenter="highlightedIndex = allowClear ? index + 1 : index"
          >
            <span tw-class="break-all whitespace-normal pr-2">{{ modelLabel({ model }) }}</span>
            <CheckIcon v-if="model === modelValue" tw-class="w-3.5 h-3.5 shrink-0" />
          </button>
        </div>
        <div v-if="$slots.settings" data-testid="model-selector-settings" tw-class="border-t border-gray-100 dark:border-gray-700 p-3" @keydown.stop="handleSettingsKeydown({ event: $event })">
          <slot name="settings"></slot>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
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
