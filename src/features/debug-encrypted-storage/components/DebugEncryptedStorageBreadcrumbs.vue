<script setup lang="ts">
import { ChevronRightIcon } from 'lucide-vue-next';
import type { DebugEncryptedStorageNavigationColumn } from '@/features/debug-encrypted-storage/logic/navigation';

const props = defineProps<{
  columns: readonly DebugEncryptedStorageNavigationColumn[],
}>();

const emit = defineEmits<{
  navigate: [payload: { index: number }],
}>();

function navigate({ index }: { index: number }): void {
  emit('navigate', { index });
}


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
  <nav
    data-testid="encrypted-storage-breadcrumbs"
    tw-class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto py-1"
    aria-label="Inspector navigation trail"
  >
    <template v-for="(column, index) in props.columns" :key="JSON.stringify(column.ref)">
      <button
        v-if="index < props.columns.length - 1"
        :title="column.title"
        :data-testid="`encrypted-storage-breadcrumb-${index}`"
        tw-class="max-w-[220px] shrink-0 truncate rounded-md px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
        @click="navigate({ index })"
      >
        {{ column.title }}
      </button>
      <span
        v-else
        data-testid="encrypted-storage-breadcrumb-current"
        tw-class="max-w-[320px] shrink-0 truncate px-2 py-1 text-[11px] font-semibold text-gray-800 dark:text-gray-100"
        :title="column.title"
      >
        {{ column.title }}
      </span>
      <ChevronRightIcon
        v-if="index < props.columns.length - 1"
        tw-class="h-3 w-3 shrink-0 text-gray-300 dark:text-gray-600"
      />
    </template>
  </nav>
</template>
