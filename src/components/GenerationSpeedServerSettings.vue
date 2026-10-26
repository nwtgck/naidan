<script setup lang="ts">
import { computed, useId } from 'vue';
import type { LlamaCppServerTimingsMode } from '@/01-models/types';
import { useGenerationSpeedSettings } from '@/composables/useGenerationSpeedSettings';
import { lazyStrings } from '@/strings';
import RadioButton from './RadioButton.vue';

const props = defineProps<{
  presentation: 'settings' | 'popover',
}>();

const groupName = useId();
const { llamaCppServerTimings, saving, update } = useGenerationSpeedSettings();
const options = computed(() => (['auto', 'enabled', 'disabled'] as const).map(mode => ({
  mode,
  label: lazyStrings.GenerationSpeed__llama_cpp_server_timings_mode({ mode }),
})));

function choose({ mode }: { mode: LlamaCppServerTimingsMode }): void {
  if (!saving.value) {
    void update({ patch: { llamaCppServerTimings: mode } });
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <fieldset :disabled="saving" :tw-class="['min-w-0 space-y-2', props.presentation === 'settings' ? 'text-xs' : 'text-[11px]']" data-testid="generation-speed-server-settings">
    <legend tw-class="mb-2 font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.GenerationSpeed__llama_cpp_server_timings() }}</legend>
    <div tw-class="flex flex-wrap gap-x-4 gap-y-2">
      <label v-for="option in options" :key="option.mode" :tw-class="['flex cursor-pointer items-center gap-1.5 text-gray-600', props.presentation === 'settings' ? 'dark:text-gray-400' : 'dark:text-gray-300']">
        <RadioButton tone="amber" :name="groupName" :value="option.mode" :checked="llamaCppServerTimings === option.mode" @change="choose({ mode: option.mode })" />
        <span>{{ option.label }}</span>
      </label>
    </div>
    <p :tw-class="['leading-relaxed', props.presentation === 'settings' ? 'text-xs text-gray-600 dark:text-gray-400' : 'text-[10px] text-gray-400 dark:text-gray-500']">{{ lazyStrings.GenerationSpeed__llama_cpp_server_timings_help() }}</p>
    <p v-if="llamaCppServerTimings === 'enabled'" :tw-class="['leading-relaxed text-amber-700 dark:text-amber-400', props.presentation === 'settings' ? 'text-xs' : 'text-[10px]']" data-testid="generation-speed-server-warning">{{ lazyStrings.GenerationSpeed__llama_cpp_server_timings_warning() }}</p>
  </fieldset>
</template>
