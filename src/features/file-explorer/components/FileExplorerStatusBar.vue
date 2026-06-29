<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { inject } from 'vue';
import { FILE_EXPLORER_INJECTION_KEY } from '@/features/file-explorer/composables/useFileExplorer';
import { formatSize } from '@/features/file-explorer/logic/utils';

const ctx = inject(FILE_EXPLORER_INJECTION_KEY)!;


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <div class="flex items-center justify-between px-3 py-1.5 border-t border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-900/50 shrink-0 text-[10px] text-gray-400 dark:text-gray-500 select-none">
    <span>
      {{ lazyStrings.fileExplorer__item_count_label({ count: ctx.statusBarInfo.totalItems }) }}
      <template v-if="ctx.statusBarInfo.totalItems > 0">
        — {{ formatSize({ bytes: ctx.statusBarInfo.totalSize }) }}
      </template>
    </span>
    <span v-if="ctx.statusBarInfo.selectedCount > 0" class="font-bold text-blue-500 dark:text-blue-400">
      {{ lazyStrings.fileExplorer__selected_count_label({ count: ctx.statusBarInfo.selectedCount }) }}
      <template v-if="ctx.statusBarInfo.selectedSize > 0">
        ({{ formatSize({ bytes: ctx.statusBarInfo.selectedSize }) }})
      </template>
    </span>
  </div>
</template>
