<script setup lang="ts">
import { computed } from 'vue';
import {
  createBinaryHexRows,
  formatBinaryRange,
} from '@/features/debug-hizofs/logic/binary-inspection-hex';

const props = defineProps<{
  readonly bytes: Uint8Array;
  readonly offset: number | bigint;
  readonly regionByteLength: number;
  readonly truncatedAfter: boolean;
}>();

const rows = computed(() => createBinaryHexRows({
  bytes: props.bytes,
  baseOffset: props.offset,
  bytesPerRow: 16,
}));
const rangeLabel = computed(() => formatBinaryRange({
  offset: props.offset,
  byteLength: props.regionByteLength,
}));

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
    },
  }) || {}),
});
</script>

<template>
  <div tw-class="font-mono text-[10px] text-gray-700 dark:text-gray-200">
    <div tw-class="flex items-center justify-between gap-3 border-b border-gray-200 bg-gray-50 px-3 py-1.5 text-[9px] text-gray-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-400">
      <span>{{ rangeLabel }}</span>
      <span>{{ bytes.byteLength }} / {{ regionByteLength }} bytes shown</span>
    </div>
    <div v-if="rows.length === 0" tw-class="px-3 py-3 text-gray-400">No bytes in this region.</div>
    <div v-else tw-class="overflow-x-auto px-3 py-2">
      <div v-for="row in rows" :key="row.offsetLabel" tw-class="flex min-w-max leading-5">
        <span tw-class="w-24 shrink-0 select-none text-gray-400">{{ row.offsetLabel }}</span>
        <span tw-class="w-[31rem] shrink-0 whitespace-pre">{{ row.hexGroups.join(' ').padEnd(47, ' ') }}</span>
        <span tw-class="border-l border-gray-200 pl-3 text-gray-500 dark:border-gray-700 dark:text-gray-400">{{ row.ascii }}</span>
      </div>
    </div>
    <div v-if="truncatedAfter" tw-class="border-t border-gray-200 px-3 py-2 text-[9px] text-amber-600 dark:border-gray-700 dark:text-amber-400">
      Additional bytes exist after this preview.
    </div>
  </div>
</template>
