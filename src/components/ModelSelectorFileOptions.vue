<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { computed, ref, watch } from 'vue';
import { useResizeObserver } from '@vueuse/core';
import { compareModelVariantsBySize, formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/presentation';

type Choice = { id: string, label: string, filePath: string, bytes: number };
const props = defineProps<{
  choices: readonly Choice[],
  modelName: string,
  selected?: string,
  disabled: boolean,
  testId?: string,
}>();
const emit = defineEmits<{ select: [id: string] }>();
defineSlots<{ action?({ choice }: { choice: Choice }): unknown }>();
const list = ref<HTMLUListElement>();
const scrollable = ref(false);
const orderedChoices = computed(() => props.choices.map(choice => ({ choice, path: choice.filePath, bytes: choice.bytes }))
  .sort((left, right) => compareModelVariantsBySize({ left, right })));

function measureOverflow(): void {
  const element = list.value;
  scrollable.value = element !== undefined && element !== null && element.scrollHeight > element.clientHeight;
}

useResizeObserver(list, measureOverflow);
watch(() => orderedChoices.value.length, measureOverflow, { flush: 'post' });


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
  <fieldset :aria-label="lazyStrings.ModelSelectorFileOptions__files_for_model({ model: modelName })" tw-class="min-w-0">
    <legend v-if="scrollable" :title="modelName" tw-class="mb-1.5 max-w-full truncate px-1 text-xs font-medium text-gray-600 dark:text-gray-300">{{ modelName }}</legend>
    <ul ref="list" class="quantization-choices" tw-class="space-y-0.5 overflow-y-auto rounded-lg">
      <li v-for="{ choice } in orderedChoices" :key="choice.id" :tw-class="['flex min-w-0 items-center rounded-lg', selected === choice.id && 'bg-blue-50/70 ring-1 ring-inset ring-blue-500/20 dark:ring-blue-400/25 dark:bg-blue-500/10']">
        <button type="button" :aria-pressed="selected === choice.id" :disabled="disabled" :data-testid="testId" tw-class="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors aria-pressed:text-blue-700 dark:aria-pressed:text-blue-300 enabled:hover:bg-gray-100 enabled:aria-pressed:hover:bg-blue-100/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/50 disabled:opacity-50 dark:enabled:hover:bg-gray-800 dark:enabled:aria-pressed:hover:bg-blue-500/20 motion-reduce:transition-none" @click="emit('select', choice.id)">
          <span tw-class="min-w-0 flex-1">
            <span tw-class="block font-medium">{{ choice.label }}</span>
            <span v-if="choice.filePath !== choice.label" :title="choice.filePath" tw-class="block truncate text-[11px] text-gray-500 dark:text-gray-400">{{ choice.filePath }}</span>
          </span>
          <span tw-class="shrink-0 tabular-nums text-gray-500 dark:text-gray-400">{{ formatDownloadBytes({ bytes: choice.bytes }) }}</span>
        </button>
        <div v-if="$slots.action" tw-class="shrink-0 pr-1"><slot name="action" :choice="choice" /></div>
      </li>
    </ul>
  </fieldset>
</template>

<style scoped>
.quantization-choices {
  max-block-size: min(15rem, 34dvh);
}
@container model-picker (min-width: 42rem) {
  .quantization-choices {
    max-block-size: min(23rem, 46dvh);
  }
}
</style>
