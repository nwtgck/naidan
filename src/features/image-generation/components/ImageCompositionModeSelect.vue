<script setup lang="ts">
import { computed, nextTick } from 'vue';
import { ListIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';

const props = defineProps<{ id: string, mode: 'single' | 'multiple', disabled: boolean }>();
const emit = defineEmits<{ 'update:mode': [mode: 'single' | 'multiple'] }>();
const options = computed(() => [
  { value: 'single', label: lazyStrings.imageComposition__single() },
  { value: 'multiple', label: lazyStrings.imageComposition__multiple() },
] as const);

async function select({ mode }: { mode: 'single' | 'multiple' }): Promise<void> {
  if (props.disabled || props.mode === mode) {
    return;
  }
  emit('update:mode', mode);
  await nextTick();
  // Both editors render the same logical control after changing the mode.
  const control = document.getElementById(props.id);
  const target = control?.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ?? control?.querySelector('button');
  target?.focus({ preventScroll: true });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div :id="id" role="group" :aria-label="lazyStrings.ImageCompositionModeSelect__input_mode()" data-testid="composition-mode" tw-class="min-w-0 max-w-full">
    <button v-if="mode === 'single'" type="button" :disabled="disabled" data-testid="composition-mode-multiple" @click="select({ mode: 'multiple' })" tw-class="inline-flex min-h-7 min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-gray-500 transition-colors hover:bg-gray-100 hover:text-blue-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-blue-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-40"><ListIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" /><span>{{ lazyStrings.imageComposition__multiple() }}</span></button>
    <div v-else tw-class="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg bg-gray-100/70 p-0.5 dark:bg-gray-800/60">
      <button v-for="option in options" :key="option.value" type="button" :disabled="disabled" :aria-pressed="mode === option.value" :data-testid="'composition-mode-' + option.value" @click="select({ mode: option.value })" :tw-class="['min-h-7 min-w-0 flex-auto whitespace-nowrap rounded-md px-2 py-1 text-xs leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-40', mode === option.value ? 'bg-white font-medium text-blue-700 dark:bg-gray-700/70 dark:text-blue-300' : 'text-gray-500 hover:bg-white/60 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700/40 dark:hover:text-gray-200']">{{ option.label }}</button>
    </div>
  </div>
</template>
