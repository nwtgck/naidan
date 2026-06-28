<script setup lang="ts">
import { ref, watch } from 'vue';
import type { ChoicesActiveRequest } from '@/features/tools/choices/runtime';

const props = defineProps<{
  request: ChoicesActiveRequest,
}>();

const emit = defineEmits<{
  (event: 'select', index: number): void,
}>();

const selectedIndex = ref<number | undefined>(undefined);

watch(
  () => props.request.requestId,
  () => {
    selectedIndex.value = undefined;
  },
);

function selectChoice({
  index,
}: {
  index: number,
}): void {
  if (selectedIndex.value !== undefined) {
    return;
  }
  selectedIndex.value = index;
  emit('select', index);
}

defineExpose({
  TEST_ONLY: {
    selectedIndex,
  },
});
</script>

<template>
  <div
    class="rounded-2xl border border-gray-100 bg-white p-3 shadow-lg ring-1 ring-black/5 dark:border-gray-700 dark:bg-gray-800 dark:ring-white/10"
    data-testid="chat-choices-panel"
  >
    <div class="flex flex-col gap-2.5">
      <div class="min-w-0">
        <div class="whitespace-pre-wrap break-words text-sm font-semibold text-gray-900 dark:text-gray-100">
          {{ props.request.prompt }}
        </div>
      </div>

      <div class="grid max-h-64 gap-1.5 overflow-y-auto">
        <button
          v-for="(choice, index) in props.request.choices"
          :key="`${props.request.requestId}:${index}`"
          type="button"
          class="flex min-h-9 w-full items-center rounded-xl border border-gray-200 bg-white px-3 py-2 text-left text-xs font-semibold whitespace-normal break-words text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-default disabled:opacity-60 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          :data-testid="`chat-choice-${index}`"
          :disabled="selectedIndex !== undefined"
          @click="selectChoice({ index })"
        >
          {{ choice }}
        </button>
      </div>
    </div>
  </div>
</template>
