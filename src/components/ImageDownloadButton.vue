<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { ref } from 'vue';
import { DownloadIcon, ChevronDownIcon } from 'lucide-vue-next';
import { useEventTargetListener } from '@/composables/useEventTargetListener';

const props = defineProps<{
  /** Download action handler */
  onDownload: ({ withMetadata }: { withMetadata: boolean }) => void,
  /** Whether metadata embedding is supported for the current image format */
  isSupported?: boolean,
  /** Alignment of the dropdown: 'left' or 'right' (default) */
  align?: 'left' | 'right',
}>();

const isOpen = ref(false);
const dropdownRef = ref<HTMLElement | null>(null);

function toggleDropdown({ event }: { event: Event }) {
  event.stopPropagation();
  isOpen.value = !isOpen.value;
}

function handleDownload({ withMetadata, event }: { withMetadata: boolean, event: Event }) {
  event.stopPropagation();
  props.onDownload({ withMetadata });
  isOpen.value = false;
}

function handleClickOutside({ event }: { event: MouseEvent }) {
  if (dropdownRef.value && !dropdownRef.value.contains(event.target as Node)) {
    isOpen.value = false;
  }
}

useEventTargetListener(document, 'mousedown', (event) => handleClickOutside({ event }));


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div
    class="relative inline-flex shadow-sm border border-gray-200 dark:border-gray-700 rounded-lg overflow-visible bg-white dark:bg-gray-800 z-30"
    ref="dropdownRef"
  >
    <!-- Main Button (Standard Download) -->
    <button
      @click="handleDownload({ withMetadata: false, event: $event })"
      class="flex items-center justify-center p-1.5 text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors rounded-l-lg"
      :title="lazyStrings.ImageDownloadButton__download_image()"
      data-testid="download-gen-image-button"
    >
      <DownloadIcon class="w-4 h-4" />
    </button>

    <!-- Split Divider & Dropdown Toggle -->
    <button
      @click="toggleDropdown({ event: $event })"
      class="px-1 text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 border-l border-gray-200 dark:border-gray-700 transition-colors rounded-r-lg flex items-center justify-center"
      :title="lazyStrings.ImageDownloadButton__more_options()"
      data-testid="download-gen-image-dropdown-toggle"
    >
      <ChevronDownIcon class="w-3.5 h-3.5 transition-transform duration-200" :class="{ 'rotate-180': isOpen }" />
    </button>

    <!-- Dropdown Menu -->
    <div
      v-if="isOpen"
      class="absolute top-full mt-1 w-48 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-[100] py-1 overflow-hidden animate-in fade-in slide-in-from-top-1"
      :class="align === 'left' ? 'left-0' : 'right-0'"
    >
      <button
        @click="isSupported !== false ? handleDownload({ withMetadata: true, event: $event }) : null"
        class="w-full flex flex-col px-3 py-2 text-left transition-colors"
        :class="isSupported !== false ? 'hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200' : 'opacity-50 cursor-not-allowed text-gray-400'"
        :disabled="isSupported === false"
        data-testid="download-with-metadata-option"
      >
        <div class="flex items-center gap-2 mb-0.5">
          <DownloadIcon class="w-3.5 h-3.5" :class="isSupported !== false ? 'text-blue-500' : 'text-gray-400'" />
          <span class="font-bold text-xs">{{ lazyStrings.ImageDownloadButton__with_metadata() }}</span>
        </div>
        <span class="text-[10px] ml-5" :class="isSupported !== false ? 'text-gray-500 dark:text-gray-400' : 'text-gray-400'">
          {{ isSupported !== false ? lazyStrings.ImageDownloadButton__embed_prompt_seed_etc() : lazyStrings.ImageDownloadButton__not_supported_for_this_format() }}
        </span>
      </button>
    </div>
  </div>
</template>
