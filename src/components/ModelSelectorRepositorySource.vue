<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { ChevronDownIcon, ExternalLinkIcon } from 'lucide-vue-next';
import { formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/presentation';

defineProps<{
  repository: string,
  url: string,
  files?: readonly { name: string, url: string, bytes: number }[],
}>();


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
  <details data-testid="model-selector-repository-source" tw-class="group min-w-0 self-start">
    <summary tw-class="inline-flex min-h-7 cursor-pointer list-none items-center gap-1.5 rounded-md px-1.5 text-xs text-gray-500 transition-colors hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-400 dark:hover:bg-gray-800 motion-reduce:transition-none [&::-webkit-details-marker]:hidden">
      <ChevronDownIcon aria-hidden="true" tw-class="h-3.5 w-3.5 transition-transform group-open:rotate-180 motion-reduce:transition-none" />{{ lazyStrings.ModelSelectorRepositorySource__source() }}
    </summary>
    <div class="repository-details-content" tw-class="space-y-2 px-1.5 pb-1 pt-1 text-xs">
      <a :href="url" target="_blank" rel="noopener noreferrer" tw-class="break-all text-gray-600 hover:underline focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-300">{{ repository }} <ExternalLinkIcon aria-hidden="true" tw-class="inline h-3 w-3 align-text-bottom" /></a>
      <dl v-if="files?.length" tw-class="space-y-2">
        <div v-for="file in files" :key="file.url">
          <dt tw-class="flex justify-between gap-2 text-gray-500 dark:text-gray-400">
            <span tw-class="min-w-0 break-words">{{ file.name }}</span>
            <span tw-class="shrink-0 whitespace-nowrap tabular-nums">{{ formatDownloadBytes({ bytes: file.bytes }) }}</span>
          </dt>
          <dd><a :href="file.url" target="_blank" rel="noopener noreferrer" tw-class="break-all hover:underline focus-visible:outline-2 focus-visible:outline-blue-500">{{ file.url }} <ExternalLinkIcon aria-hidden="true" tw-class="inline h-3 w-3 align-text-bottom" /></a></dd>
        </div>
      </dl>
    </div>
  </details>
</template>

<style scoped>
details[open] .repository-details-content {
  animation: repository-details-reveal 140ms ease-out both;
}
@keyframes repository-details-reveal {
  from {
    opacity: 0;
    translate: 0 -2px;
  }
}
@media (prefers-reduced-motion: reduce) {
  details[open] .repository-details-content {
    animation: none;
  }
}
</style>
