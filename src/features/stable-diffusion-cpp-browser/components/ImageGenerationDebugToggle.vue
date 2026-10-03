<script setup lang="ts">
import { lazyStrings } from '@/strings';
import type { ImageGenerationView } from '@/features/stable-diffusion-cpp-browser/use-image-generation-types';
const props = defineProps<{ view: ImageGenerationView }>();
const debug = props.view.debug;
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <label :title="lazyStrings.stableDiffusionCppBrowser__debug_mode()" :tw-class="['shrink-0 min-h-10 inline-flex items-center gap-2 rounded-xl px-2 py-1.5', view.formDisabled.value ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer']">
    <input v-model="debug" type="checkbox" role="switch" true-value="on" false-value="off" :disabled="view.formDisabled.value" data-testid="image-debug-mode" tw-class="sr-only peer" />
    <span aria-hidden="true" tw-class="relative h-6 w-10 shrink-0 rounded-full bg-gray-200 dark:bg-gray-700 transition-colors peer-checked:bg-blue-600 peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-offset-gray-900 peer-disabled:opacity-40 after:content-[''] after:absolute after:top-1 after:left-1 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-4 motion-reduce:transition-none motion-reduce:after:transition-none" />
    <span tw-class="flex flex-col leading-tight"><span tw-class="text-xs font-bold text-gray-700 dark:text-gray-200">{{ lazyStrings.ImageGenerationLab__debug() }}</span><span tw-class="text-[10px] text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageGenerationLab__record_detailed_logs() }}</span></span>
  </label>
</template>
