<script setup lang="ts">
import { lazyStrings } from '@/strings';
defineProps<{ field: 'prompt' | 'negativePrompt', before: string, after: string }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-3 text-xs" data-testid="image-generation-prompt-approval">
    <p tw-class="font-semibold">{{ field === 'prompt' ? lazyStrings.stableDiffusionCppBrowser__prompt() : lazyStrings.stableDiffusionCppBrowser__negative_prompt() }}</p>
    <section><h4 tw-class="mb-1 text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__before() }}</h4><p tw-class="max-h-40 overflow-auto whitespace-pre-wrap break-words text-gray-600 dark:text-gray-300">{{ before }}</p></section>
    <section><h4 tw-class="mb-1 text-blue-600 dark:text-blue-400">{{ lazyStrings.imageGeneration__after() }}</h4><p tw-class="max-h-64 overflow-auto whitespace-pre-wrap break-words text-gray-900 dark:text-gray-100">{{ after }}</p></section>
  </div>
</template>
