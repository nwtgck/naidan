<script setup lang="ts">
import SettingsChoiceControl from '@/components/SettingsChoiceControl.vue';
import { lazyStrings } from '@/strings';
import type { ImageGenerationView } from '@/features/image-generation/use-image-generation-types';
const props = defineProps<{ view: ImageGenerationView }>();
const debug = props.view.debug;
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <label :title="lazyStrings.stableDiffusionCppBrowser__debug_mode()" :tw-class="['shrink-0 min-h-10 inline-flex items-center gap-2 rounded-xl px-2 py-1.5', view.formDisabled.value ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer']">
    <SettingsChoiceControl presentation="switch"><input v-model="debug" type="checkbox" role="switch" true-value="on" false-value="off" :disabled="view.formDisabled.value" data-testid="image-debug-mode" /></SettingsChoiceControl>
    <span tw-class="flex flex-col leading-tight"><span tw-class="text-xs font-bold text-gray-700 dark:text-gray-200">{{ lazyStrings.ImageGenerationLab__debug() }}</span><span tw-class="text-[10px] text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationLab__record_detailed_logs() }}</span></span>
  </label>
</template>
