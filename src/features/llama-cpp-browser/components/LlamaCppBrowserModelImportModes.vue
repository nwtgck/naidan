<script setup lang="ts">
import { useLlamaCppBrowserSettingsTypography } from '@/features/llama-cpp-browser/composables/useLlamaCppBrowserSettingsTypography';
import { lazyStrings } from '@/strings';

type ImportMode = 'opfs' | 'host' | 'temp';
const props = defineProps<{
  modelValue: ImportMode,
  modes: readonly { mode: ImportMode, label: string | undefined, availability: 'available' | 'unavailable' }[],
  disabled: boolean,
}>();
const emit = defineEmits<{ 'update:modelValue': [mode: ImportMode] }>();

function select({ mode }: { mode: ImportMode }): void {
  if (!props.disabled && props.modes.some(choice => choice.mode === mode)) {
    emit('update:modelValue', mode);
  }
}

const isSettingsTypography = useLlamaCppBrowserSettingsTypography();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div role="group" :aria-label="lazyStrings.SHARED__model_import_how_to_use_files()" :tw-class="['grid gap-1 rounded-xl bg-gray-100 p-1 dark:bg-gray-800', modes.length === 2 ? 'grid-cols-2' : 'grid-cols-1 sm:grid-cols-3']">
    <button v-for="choice in modes" :key="choice.mode" type="button" :aria-pressed="modelValue === choice.mode" :disabled="disabled" :data-testid="`llama-import-mode-${choice.mode}`" :tw-class="[['rounded-lg px-3 py-2 font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed motion-reduce:transition-none', isSettingsTypography ? 'text-sm' : 'text-xs'], modelValue === choice.mode ? 'bg-white text-blue-700 shadow-sm dark:bg-gray-700 dark:text-blue-300' : 'text-gray-600 dark:text-gray-300', choice.availability === 'unavailable' ? 'opacity-50' : 'opacity-100']" @click="select({ mode: choice.mode })">{{ choice.label }}</button>
  </div>
</template>
