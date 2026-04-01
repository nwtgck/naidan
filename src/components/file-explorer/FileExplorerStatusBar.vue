<script setup lang="ts">
import { inject } from 'vue';
import { FILE_EXPLORER_INJECTION_KEY } from './useFileExplorer';
import { formatSize } from './utils';

const ctx = inject(FILE_EXPLORER_INJECTION_KEY)!;


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="flex items-center justify-between px-3 py-1.5 border-t border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-900/50 shrink-0 text-[10px] text-gray-400 dark:text-gray-500 select-none">
    <span>
      {{ ctx.statusBarInfo.totalItems }} item{{ ctx.statusBarInfo.totalItems !== 1 ? 's' : '' }}
      <template v-if="ctx.statusBarInfo.totalItems > 0">
        — {{ formatSize({ bytes: ctx.statusBarInfo.totalSize }) }}
      </template>
    </span>
    <span v-if="ctx.statusBarInfo.selectedCount > 0" class="font-bold text-blue-500 dark:text-blue-400">
      {{ ctx.statusBarInfo.selectedCount }} selected
      <template v-if="ctx.statusBarInfo.selectedSize > 0">
        ({{ formatSize({ bytes: ctx.statusBarInfo.selectedSize }) }})
      </template>
    </span>
  </div>
</template>
