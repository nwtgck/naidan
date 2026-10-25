<script setup lang="ts">
import { computed, useId } from 'vue';
import type { LlamaCppServerTimingsMode } from '@/01-models/types';
import { useGenerationSpeedSettings } from '@/composables/useGenerationSpeedSettings';
import { lazyStrings } from '@/strings';

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
  <fieldset :disabled="saving" tw-class="min-w-0 space-y-2 text-[11px]" data-testid="generation-speed-server-settings">
    <legend tw-class="mb-2 font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.GenerationSpeed__llama_cpp_server_timings() }}</legend>
    <div tw-class="flex flex-wrap gap-x-4 gap-y-2">
      <label v-for="option in options" :key="option.mode" tw-class="flex cursor-pointer items-center gap-1.5 text-gray-600 dark:text-gray-300">
        <input type="radio" :name="groupName" :value="option.mode" :checked="llamaCppServerTimings === option.mode" tw-class="accent-blue-500 disabled:cursor-not-allowed" @change="choose({ mode: option.mode })" />
        <span>{{ option.label }}</span>
      </label>
    </div>
    <p tw-class="text-[10px] leading-relaxed text-gray-400 dark:text-gray-500">{{ lazyStrings.GenerationSpeed__llama_cpp_server_timings_help() }}</p>
    <p v-if="llamaCppServerTimings === 'enabled'" tw-class="text-[10px] leading-relaxed text-amber-700 dark:text-amber-400" data-testid="generation-speed-server-warning">{{ lazyStrings.GenerationSpeed__llama_cpp_server_timings_warning() }}</p>
  </fieldset>
</template>
