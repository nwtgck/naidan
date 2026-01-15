<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, useAttrs, nextTick } from 'vue';
import { Search, RefreshCw, Check, ChevronDown, Loader2, X } from 'lucide-vue-next';
import { useSettings } from '../composables/useSettings';

const props = defineProps<{
  modelValue: string | undefined;
  placeholder?: string;
  loading?: boolean;
  allowClear?: boolean;
  models?: string[];
  disabled?: boolean;
  clearLabel?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | undefined): void;
  (e: 'refresh'): void;
}>();

const attrs = useAttrs();
const { availableModels: settingsModels, isFetchingModels: isInternalFetching, fetchModels: internalFetch } = useSettings();

const availableModels = computed(() => props.models ?? settingsModels.value);
const isFetchingModels = computed(() => props.loading || (isInternalFetching?.value ?? false));

const isOpen = ref(false);
const searchQuery = ref('');
const containerRef = ref<HTMLElement | null>(null);
const searchInputRef = ref<HTMLInputElement | null>(null);

const filteredModels = computed(() => {
  if (!searchQuery.value) return availableModels.value;
  const query = searchQuery.value.toLowerCase();
  return availableModels.value.filter(m => m.toLowerCase().includes(query));
});

function toggleDropdown() {
  isOpen.value = !isOpen.value;
  if (isOpen.value) {
    searchQuery.value = '';
    nextTick(() => {
      searchInputRef.value?.focus();
    });
  }
}

function selectModel(model: string | undefined) {
  emit('update:modelValue', model);
  isOpen.value = false;
}

async function handleRefresh(e: Event) {
  e.stopPropagation();
  if (attrs.onRefresh) {
    emit('refresh');
  } else {
    await internalFetch();
  }
}

function handleClickOutside(event: MouseEvent) {
  if (containerRef.value && !containerRef.value.contains(event.target as Node)) {
    isOpen.value = false;
  }
}

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside);
});

onUnmounted(() => {
  document.removeEventListener('mousedown', handleClickOutside);
});
</script>

<template>
  <div class="relative w-full" ref="containerRef">
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

    <!-- Dropdown -->
    <div
      v-if="isOpen"
      class="absolute z-50 bottom-full mb-2 left-0 min-w-full w-max max-w-[min(480px,calc(100vw-2rem))] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-200"
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
      <div class="max-h-60 overflow-y-auto py-1 custom-scrollbar">
        <!-- Clear selection option -->
        <button
          v-if="allowClear && modelValue"
          @click="selectModel(undefined)"
          class="w-full flex items-center px-3 py-2 text-xs text-left text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50 hover:text-gray-600 transition-colors border-b border-gray-50 dark:border-gray-700/50 mb-1"
          data-testid="model-selector-clear"
        >
          <X class="w-3.5 h-3.5 mr-2" />
          <span>{{ clearLabel || (placeholder ? (placeholder.startsWith('Use') ? placeholder : `Use ${placeholder}`) : 'Clear override') }}</span>
        </button>

        <div v-if="filteredModels.length === 0" class="px-4 py-8 text-center">
          <p class="text-xs text-gray-500 dark:text-gray-400">No models found</p>
        </div>
        <button
          v-for="model in filteredModels"
          :key="model"
          @click="selectModel(model)"
          class="w-full flex items-center justify-between px-3 py-2 text-xs text-left transition-colors"
          :class="model === modelValue 
            ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 font-bold' 
            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50'"
        >
          <span class="break-all whitespace-normal pr-2">{{ model }}</span>
          <Check v-if="model === modelValue" class="w-3.5 h-3.5 shrink-0" />
        </button>
      </div>
    </div>
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
  from { transform: translateY(0.5rem); }
  to { transform: translateY(0); }
}

.fade-in {
  animation-name: fade-in;
}

.slide-in-from-bottom-2 {
  animation-name: slide-in-from-bottom-2;
}
</style>
