<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { Minimize2Icon } from 'lucide-vue-next';

defineEmits<{
  (e: 'compact'): void,
}>();

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {},
  }) || {}),
});
</script>

<template>
  <button
    tw-class="group flex min-h-9 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40 text-gray-700 hover:bg-gray-100 hover:text-blue-600 dark:text-gray-200 dark:hover:bg-blue-400/10 dark:hover:text-blue-400"
    data-testid="compact-context-button"
    @click="$emit('compact')"
  >
    <Minimize2Icon tw-class="h-4 w-4 shrink-0 text-gray-400 group-hover:text-blue-600 dark:group-hover:text-blue-400" aria-hidden="true" />
    <span>{{ lazyStrings.contextCompact__compact_context() }}</span>
  </button>
</template>
