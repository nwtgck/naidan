<script setup lang="ts">
import { lazyStrings } from '@/strings';
const props = defineProps<{
  keyword: string,
}>();

defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
    // ESLint-required for defineExpose.
  },
});
</script>

<template>
  <div class="min-w-0 truncate text-xs text-gray-600 dark:text-gray-300">
    <span class="font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.chatApproval__keyword_label() }}</span>
    <span class="ml-1 text-gray-900 dark:text-gray-100">{{ props.keyword }}</span>
  </div>
</template>
