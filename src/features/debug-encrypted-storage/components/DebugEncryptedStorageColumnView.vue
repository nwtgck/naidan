<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { BracesIcon, ChevronRightIcon } from 'lucide-vue-next';
import type { EncryptedStorageDebugNodeRef } from '@/features/debug-encrypted-storage/worker/types';
import {
  areDebugEncryptedStorageNodeRefsEqual,
  type DebugEncryptedStorageNavigationColumn,
} from '@/features/debug-encrypted-storage/logic/navigation';

const props = defineProps<{
  columns: readonly DebugEncryptedStorageNavigationColumn[],
}>();

const emit = defineEmits<{
  navigate: [payload: { ref: EncryptedStorageDebugNodeRef, columnIndex: number }],
}>();

const scrollContainer = ref<HTMLElement>();

watch(
  () => props.columns.length,
  async () => {
    await nextTick();
    if (scrollContainer.value !== undefined) {
      scrollContainer.value.scrollLeft = scrollContainer.value.scrollWidth;
    }
  },
);

function navigate({
  ref,
  columnIndex,
}: {
  ref: EncryptedStorageDebugNodeRef,
  columnIndex: number,
}): void {
  emit('navigate', { ref, columnIndex });
}

function isSelected({
  ref,
  columnIndex,
}: {
  ref: EncryptedStorageDebugNodeRef,
  columnIndex: number,
}): boolean {
  const nextColumn = props.columns[columnIndex + 1];
  return nextColumn !== undefined && areDebugEncryptedStorageNodeRefsEqual({
    left: ref,
    right: nextColumn.ref,
  });
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
  <div
    ref="scrollContainer"
    data-testid="encrypted-storage-column-view"
    tw-class="flex min-h-0 flex-1 overflow-x-auto bg-white dark:bg-gray-900"
  >
    <section
      v-for="(column, columnIndex) in props.columns"
      :key="`${columnIndex}:${JSON.stringify(column.ref)}`"
      tw-class="flex w-[270px] shrink-0 flex-col border-r border-gray-200 last:border-r-0 dark:border-gray-800"
      :data-testid="`encrypted-storage-column-${columnIndex}`"
    >
      <header tw-class="border-b border-gray-100 px-3 py-2 dark:border-gray-800">
        <div tw-class="truncate text-[10px] font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400">
          {{ column.kind }}
        </div>
        <div tw-class="mt-0.5 truncate text-xs font-semibold text-gray-800 dark:text-gray-100" :title="column.title">
          {{ column.title }}
        </div>
      </header>
      <div tw-class="min-h-0 flex-1 overflow-y-auto p-1.5">
        <div
          v-if="column.references.length === 0"
          tw-class="px-2 py-3 text-[11px] text-gray-400"
        >
          No outgoing references
        </div>
        <button
          v-for="reference in column.references"
          :key="`${reference.label}:${JSON.stringify(reference.ref)}`"
          :tw-class="[
            'mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left',
            isSelected({ ref: reference.ref, columnIndex })
              ? 'bg-blue-50 text-blue-800 dark:bg-blue-950/50 dark:text-blue-200'
              : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800',
          ]"
          @click="navigate({ ref: reference.ref, columnIndex })"
        >
          <BracesIcon tw-class="h-3.5 w-3.5 shrink-0 text-blue-500" />
          <span tw-class="min-w-0 flex-1 truncate text-xs" :title="reference.label">{{ reference.label }}</span>
          <ChevronRightIcon tw-class="h-3 w-3 shrink-0 text-gray-300 dark:text-gray-600" />
        </button>
      </div>
    </section>
  </div>
</template>
