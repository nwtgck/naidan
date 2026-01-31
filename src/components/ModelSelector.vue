<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, useAttrs, nextTick, getCurrentInstance, watch, type CSSProperties } from 'vue';
import { Search, RefreshCw, Check, ChevronDown, Loader2, X } from 'lucide-vue-next';
import { useSettings } from '../composables/useSettings';
import { useElementBounding, useWindowSize } from '@vueuse/core';

const props = defineProps<{
  modelValue: string | undefined;
  placeholder?: string;
  loading?: boolean;
  allowClear?: boolean;
  models?: readonly string[];
  disabled?: boolean;
  clearLabel?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | undefined): void;
  (e: 'refresh'): void;
}>();

const attrs = useAttrs();
const instance = getCurrentInstance();
const { availableModels: settingsModels, isFetchingModels: isInternalFetching, fetchModels: internalFetch } = useSettings();

const availableModels = computed(() => props.models ?? settingsModels.value);
const isFetchingModels = computed(() => props.loading || (isInternalFetching?.value ?? false));

const filteredModels = computed(() => {
  if (!searchQuery.value) return availableModels.value;
  const query = searchQuery.value.toLowerCase();
  return availableModels.value.filter(m => m.toLowerCase().includes(query));
});

const isOpen = ref(false);
const searchQuery = ref('');
const highlightedIndex = ref(-1);
const containerRef = ref<HTMLElement | null>(null);
const searchInputRef = ref<HTMLInputElement | null>(null);
const dropdownRef = ref<HTMLElement | null>(null);
const listContainerRef = ref<HTMLElement | null>(null);

const { width: windowWidth, height: windowHeight } = useWindowSize();
const triggerBounding = useElementBounding(containerRef);

const dropdownPosition = ref<'top' | 'bottom'>('bottom');

const combinedOptions = computed(() => {
  const options: (string | undefined)[] = [];
  if (props.allowClear) {
    options.push(undefined);
  }
  options.push(...filteredModels.value);
  return options;
});

const floatingStyle = computed((): CSSProperties => {
  if (!isOpen.value || !containerRef.value) return {};

  const rect = triggerBounding;
  const margin = 8;
  const dropdownHeight = 320; // Max expected height
  
  // Decide vertical position
  const spaceBelow = windowHeight.value - rect.bottom.value;
  const preferredPosition = spaceBelow < dropdownHeight && rect.top.value > dropdownHeight ? 'top' : 'bottom';
  
  // Set position ref for animation classes
  // eslint-disable-next-line vue/no-side-effects-in-computed-properties
  dropdownPosition.value = preferredPosition;

  // Horizontal alignment: try to align left, but push left if it goes off-screen
  const width = Math.max(rect.width.value, Math.min(480, windowWidth.value - 32));
  const maxWidth = Math.min(640, windowWidth.value - 32);
  let left = rect.left.value;

  if (left + width > windowWidth.value - 16) {
    left = windowWidth.value - width - 16;
  }
  if (left < 16) left = 16;

  const verticalStyle = (() => {
    switch (preferredPosition) {
    case 'bottom':
      return {
        top: `${rect.bottom.value + margin}px`,
        bottom: 'auto',
      };
    case 'top':
      return {
        top: 'auto',
        bottom: `${windowHeight.value - rect.top.value + margin}px`,
      };
    default: {
      const _ex: never = preferredPosition;
      throw new Error(`Unhandled position: ${_ex}`);
    }
    }
  })();

  return {
    position: 'fixed',
    ...verticalStyle,
    left: `${left}px`,
    width: `${width}px`,
    maxWidth: `${maxWidth}px`,
    zIndex: 9999,
  };
});

function toggleDropdown() {
  if (isOpen.value) {
    isOpen.value = false;
  } else {
    isOpen.value = true;
    searchQuery.value = '';
    // Set initial highlighted index to current model or first item
    const currentIndex = combinedOptions.value.indexOf(props.modelValue);
    highlightedIndex.value = currentIndex >= 0 ? currentIndex : 0;
    
    nextTick(() => {
      searchInputRef.value?.focus();
      scrollToHighlighted();
    });
  }
}

function selectModel(model: string | undefined) {
  emit('update:modelValue', model);
  isOpen.value = false;
}

function scrollToHighlighted() {
  nextTick(() => {
    if (!listContainerRef.value) return;
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

function handleKeydown(e: KeyboardEvent) {
  if (!isOpen.value) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
      e.preventDefault();
      toggleDropdown();
    }
    return;
  }

  switch (e.key) {
  case 'ArrowDown':
    e.preventDefault();
    highlightedIndex.value = (highlightedIndex.value + 1) % combinedOptions.value.length;
    scrollToHighlighted();
    break;
  case 'ArrowUp':
    e.preventDefault();
    highlightedIndex.value = (highlightedIndex.value - 1 + combinedOptions.value.length) % combinedOptions.value.length;
    scrollToHighlighted();
    break;
  case 'Enter':
    e.preventDefault();
    if (highlightedIndex.value >= 0 && highlightedIndex.value < combinedOptions.value.length) {
      selectModel(combinedOptions.value[highlightedIndex.value]);
    }
    break;
  case 'Escape':
    e.preventDefault();
    isOpen.value = false;
    break;
  case 'Tab':
    isOpen.value = false;
    break;
  }
}

async function handleRefresh(e: Event) {
  e.stopPropagation();
  // Check if parent has a listener for 'refresh' (onRefresh)
  const hasRefreshListener = !!(instance?.vnode.props?.onRefresh || attrs.onRefresh);
  if (hasRefreshListener) {
    emit('refresh');
  } else {
    await internalFetch();
  }
}

function handleClickOutside(event: MouseEvent) {
  const target = event.target as Node;
  const isInsideTrigger = containerRef.value?.contains(target);
  const isInsideDropdown = dropdownRef.value?.contains(target);

  if (!isInsideTrigger && !isInsideDropdown) {
    isOpen.value = false;
  }
}

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside);
});

onUnmounted(() => {
  document.removeEventListener('mousedown', handleClickOutside);
});

// Reset highlighted index when filtering
watch(searchQuery, () => {
  if (isOpen.value) {
    highlightedIndex.value = combinedOptions.value.length > 0 ? 0 : -1;
  }
});

// Close on scroll or resize to prevent floating detached dropdown
watch([windowWidth, windowHeight], () => {
  if (isOpen.value) isOpen.value = false;
});
</script>

<template>
  <div class="relative w-full" ref="containerRef" @keydown="handleKeydown">
    <!-- Trigger -->
    <button
      type="button"
      @click="toggleDropdown"
      :disabled="disabled"
      class="w-full flex items-center justify-between gap-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2.5 text-xs font-bold text-gray-700 dark:text-gray-200 outline-none focus:ring-4 focus:ring-blue-500/10 hover:border-gray-300 dark:hover:border-gray-600 transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
      :class="{ 'ring-4 ring-blue-500/10 border-blue-500/50': isOpen }"
      data-testid="model-selector-trigger"
    >
      <div class="flex items-center gap-2 truncate">
        <span class="truncate">{{ modelValue || placeholder || 'Select a model' }}</span>
      </div>
      <div class="flex items-center gap-1.5 shrink-0 ml-1">
        <Loader2 v-if="isFetchingModels" class="w-3 h-3 animate-spin text-gray-400" />
        <ChevronDown 
          class="w-3.5 h-3.5 text-gray-400 transition-transform duration-200"
          :class="{ 'rotate-180': isOpen }"
        />
      </div>
    </button>

    <!-- Dropdown Teleported -->
    <Teleport to="body">
      <div
        v-if="isOpen"
        ref="dropdownRef"
        :style="floatingStyle"
        class="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl overflow-hidden animate-in fade-in duration-200"
        :class="dropdownPosition === 'bottom' ? 'slide-in-from-top-2' : 'slide-in-from-bottom-2'"
        @keydown="handleKeydown"
      >
        <!-- Search and Actions -->
        <div class="p-2 border-b border-gray-100 dark:border-gray-700 flex items-center gap-2 bg-gray-50/50 dark:bg-gray-900/50">
          <div class="relative flex-1">
            <Search class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              ref="searchInputRef"
              v-model="searchQuery"
              type="text"
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg pl-8 pr-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-blue-500/20 placeholder:text-gray-400"
              placeholder="Filter models..."
              @click.stop
            />
            <button 
              v-if="searchQuery" 
              @click="searchQuery = ''"
              class="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-400"
            >
              <X class="w-3 h-3" />
            </button>
          </div>
          <button
            @click="handleRefresh"
            class="p-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 hover:border-blue-200 dark:hover:border-blue-900/50 transition-colors shadow-sm disabled:opacity-50"
            :disabled="isFetchingModels"
            title="Refresh model list"
          >
            <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': isFetchingModels }" />
          </button>
        </div>

        <!-- List -->
        <div ref="listContainerRef" class="max-h-60 overflow-y-auto py-1 custom-scrollbar">
          <!-- Inherited / Default option -->
          <button
            v-if="allowClear"
            @click="selectModel(undefined)"
            class="w-full flex items-center justify-between px-3 py-2 text-xs text-left transition-colors border-b border-gray-50 dark:border-gray-700/50 mb-1"
            :class="[
              !modelValue 
                ? 'text-blue-600 dark:text-blue-400 font-bold' 
                : 'text-gray-500 dark:text-gray-400',
              highlightedIndex === 0 
                ? 'bg-gray-100 dark:bg-gray-700/50' 
                : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
            ]"
            data-testid="model-selector-clear"
            data-index="0"
            @mouseenter="highlightedIndex = 0"
          >
            <div class="flex items-center gap-2">
              <X v-if="modelValue" class="w-3.5 h-3.5" />
              <span class="truncate">{{ clearLabel || placeholder || 'Inherit' }}</span>
            </div>
            <Check v-if="!modelValue" class="w-3.5 h-3.5 shrink-0" />
          </button>

          <div v-if="filteredModels.length === 0" class="px-4 py-8 text-center">
            <p class="text-xs text-gray-500 dark:text-gray-400">No models found</p>
          </div>
          <button
            v-for="(model, index) in filteredModels"
            :key="model"
            @click="selectModel(model)"
            class="w-full flex items-center justify-between px-3 py-2 text-xs text-left transition-colors"
            :class="[
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
            <span class="break-all whitespace-normal pr-2">{{ model }}</span>
            <Check v-if="model === modelValue" class="w-3.5 h-3.5 shrink-0" />
          </button>
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
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slide-in-from-bottom-2 {
  from { transform: translateY(0.5rem); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

@keyframes slide-in-from-top-2 {
  from { transform: translateY(-0.5rem); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
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
