<script setup lang="ts">
import {
  formatBinaryRange,
  formatBytesAsHex,
} from '@/features/debug-hizofs/logic/binary-hex';
import type { HizoFSDecodedBinaryFieldView } from '@/features/debug-hizofs/worker/types';

defineProps<{
  readonly fields: readonly HizoFSDecodedBinaryFieldView[];
}>();

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
    },
  }) || {}),
});
</script>

<template>
  <div tw-class="divide-y divide-gray-200 border-y border-gray-200 dark:divide-gray-700 dark:border-gray-700">
    <div v-for="field in fields" :key="`${field.offset}:${field.name}`" tw-class="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 px-3 py-2 text-[10px]">
      <div tw-class="font-mono text-gray-400">{{ formatBinaryRange({ offset: field.offset, byteLength: field.byteLength }) }}</div>
      <div tw-class="font-semibold text-gray-700 dark:text-gray-200">{{ field.name }}</div>
      <div tw-class="text-[9px] uppercase text-gray-400">Raw</div>
      <div tw-class="break-all font-mono text-gray-700 dark:text-gray-200">{{ formatBytesAsHex({ bytes: field.rawBytes }) }}</div>
      <div tw-class="text-[9px] uppercase text-gray-400">Encoding</div>
      <div tw-class="font-mono text-gray-500">{{ field.encoding }}</div>
      <div tw-class="text-[9px] uppercase text-gray-400">Decoded</div>
      <div tw-class="text-gray-700 dark:text-gray-200">{{ field.interpretation }}</div>
    </div>
  </div>
</template>
