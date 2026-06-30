<script setup lang="ts">
import { lazyStrings } from '@/strings';
const props = defineProps<{
  title: string | undefined,
  pageId: string,
}>();

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <div class="min-w-0">
    <template v-if="props.title !== undefined">
      <div class="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
        {{ props.title }}
      </div>
      <div class="mt-0.5 truncate text-[11px] font-medium text-gray-500 dark:text-gray-400">
        {{ lazyStrings.chatApproval__page_id_label() }} {{ props.pageId }}
      </div>
    </template>
    <div
      v-else
      class="truncate text-xs text-gray-600 dark:text-gray-300"
    >
      <span class="font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.chatApproval__page_id_label() }}</span>
      <span class="ml-1 text-gray-900 dark:text-gray-100">{{ props.pageId }}</span>
    </div>
  </div>
</template>
