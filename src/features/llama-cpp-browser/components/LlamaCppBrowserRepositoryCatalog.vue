<script setup lang="ts">
import { LibraryBigIcon, SearchIcon, ExternalLinkIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import LlamaCppBrowserModelActionButton from './LlamaCppBrowserModelActionButton.vue';
const props = defineProps<{ entries: readonly { name: string, input: string, url: string }[], disabled: boolean }>();
const emit = defineEmits<{ inspect: [input: string] }>();

function inspect({ input }: { input: string }): void {
  if (!props.disabled) {
    emit('inspect', input);
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section data-testid="llama-repository-catalog" tw-class="rounded-2xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 p-4 space-y-3">
    <h3 tw-class="flex items-center gap-2 text-sm font-bold"><LibraryBigIcon tw-class="h-4 w-4 text-blue-500" />{{ lazyStrings.llamaCppBrowserDownloads__model_catalog() }}</h3>
    <ul tw-class="divide-y divide-gray-100 dark:divide-gray-800">
      <li v-for="entry in entries" :key="entry.input" data-testid="llama-repository-catalog-entry" tw-class="flex flex-wrap items-center gap-3 py-3">
        <div tw-class="min-w-0 flex-1 space-y-1">
          <p tw-class="text-sm font-semibold">{{ entry.name }}</p>
          <a :href="entry.url" target="_blank" rel="noopener noreferrer" tw-class="text-xs text-blue-600 dark:text-blue-400 break-all hover:underline">{{ entry.input }} <ExternalLinkIcon aria-hidden="true" tw-class="inline h-3 w-3" /></a>
        </div>
        <LlamaCppBrowserModelActionButton :disabled="disabled" data-testid="llama-repository-catalog-inspect" tw-class="shrink-0" @click="inspect({ input: entry.input })"><SearchIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" />{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__check_model() }}</LlamaCppBrowserModelActionButton>
      </li>
    </ul>
  </section>
</template>
