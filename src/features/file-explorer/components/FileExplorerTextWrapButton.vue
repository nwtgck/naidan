<script setup lang="ts">
import { WrapTextIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { fileExplorerTextWrap } from '@/features/file-explorer/composables/file-explorer-text-wrap';

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <button
    type="button"
    :title="lazyStrings.FileExplorerTextWrapButton__wrap_text()"
    :aria-label="lazyStrings.FileExplorerTextWrapButton__wrap_text()"
    :aria-pressed="fileExplorerTextWrap"
    :tw-class="['p-1.5 rounded-lg transition-colors', fileExplorerTextWrap
      ? 'text-blue-500 bg-blue-50 dark:bg-blue-900/20'
      : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800']"
    @click="fileExplorerTextWrap = !fileExplorerTextWrap"
  >
    <WrapTextIcon aria-hidden="true" tw-class="w-3.5 h-3.5" />
  </button>
</template>
