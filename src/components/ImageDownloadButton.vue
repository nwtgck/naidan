<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { Download, ChevronDown } from 'lucide-vue-next';

const props = defineProps<{
  /** Download action handler */
  onDownload: ({ withMetadata }: { withMetadata: boolean }) => void;
  /** Whether metadata embedding is supported for the current image format */
  isSupported?: boolean;
}>();

const isOpen = ref(false);
const dropdownRef = ref<HTMLElement | null>(null);
let closeTimer: number | null = null;

function toggleDropdown(e: Event) {
  e.stopPropagation();
  isOpen.value = !isOpen.value;
}

function openDropdown() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  isOpen.value = true;
}

function closeDropdown() {
  closeTimer = window.setTimeout(() => {
    isOpen.value = false;
    closeTimer = null;
  }, 150); // Small delay to prevent flickering
}

function handleDownload(meta: boolean, e: Event) {
  e.stopPropagation();
  props.onDownload({ withMetadata: meta });
  isOpen.value = false;
}

function handleClickOutside(event: MouseEvent) {
  if (dropdownRef.value && !dropdownRef.value.contains(event.target as Node)) {
    isOpen.value = false;
  }
}

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside);
});

onUnmounted(() => {
  document.removeEventListener('mousedown', handleClickOutside);
  if (closeTimer) clearTimeout(closeTimer);
});


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div
    class="relative inline-flex shadow-sm border border-gray-200 dark:border-gray-700 rounded-lg overflow-visible bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm"
    ref="dropdownRef"
    @mouseenter="openDropdown"
    @mouseleave="closeDropdown"
  >
    <!-- Main Button (Standard Download) -->
    <button
      @click="handleDownload(false, $event)"
      class="flex items-center justify-center p-1.5 text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors rounded-l-lg"
      title="Download image"
      data-testid="download-gen-image-button"
    >
      <Download class="w-4 h-4" />
    </button>

    <!-- Split Divider & Dropdown Toggle -->
    <button
      @click="toggleDropdown"
      class="px-1 text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 border-l border-gray-200 dark:border-gray-700 transition-colors rounded-r-lg flex items-center justify-center"
      title="More options"
      data-testid="download-gen-image-dropdown-toggle"
    >
      <ChevronDown class="w-3.5 h-3.5 transition-transform duration-200" :class="{ 'rotate-180': isOpen }" />
    </button>

    <!-- Dropdown Menu -->
    <div
      v-if="isOpen"
      class="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-50 py-1 overflow-hidden animate-in fade-in slide-in-from-top-1"
    >
      <button
        @click="isSupported !== false ? handleDownload(true, $event) : null"
        class="w-full flex flex-col px-3 py-2 text-left transition-colors"
        :class="isSupported !== false ? 'hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200' : 'opacity-50 cursor-not-allowed text-gray-400'"
        :disabled="isSupported === false"
        data-testid="download-with-metadata-option"
      >
        <div class="flex items-center gap-2 mb-0.5">
          <Download class="w-3.5 h-3.5" :class="isSupported !== false ? 'text-blue-500' : 'text-gray-400'" />
          <span class="font-bold text-xs">With Metadata</span>
        </div>
        <span class="text-[10px] ml-5" :class="isSupported !== false ? 'text-gray-500 dark:text-gray-400' : 'text-gray-400'">
          {{ isSupported !== false ? 'Embed prompt, seed, etc.' : 'Not supported for this format' }}
        </span>
      </button>
    </div>
  </div>
</template>
