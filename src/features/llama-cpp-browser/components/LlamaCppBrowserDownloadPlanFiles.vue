<script setup lang="ts">
import { DownloadIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { fileDownloadUrl, formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/download-plan';
import type { RepositoryFile } from '@/features/llama-cpp-browser/hugging-face/types';
defineProps<{ repository: string, revision: string, files: RepositoryFile[] }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <!-- Anchors are intentional user navigation. Never prefetch or fetch-to-Blob
       here: that would contact Hugging Face on render or buffer multi-GB files. -->
  <ul tw-class="space-y-2" data-testid="llama-download-plan-files">
    <li v-for="file in files" :key="file.path" tw-class="flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400">
      <span tw-class="min-w-0 flex-1 break-all font-mono leading-relaxed">{{ file.path }}</span>
      <span tw-class="shrink-0 tabular-nums pt-0.5">{{ formatDownloadBytes({ bytes: file.size }) }}</span>
      <a :href="fileDownloadUrl({ repository, revision, file })" target="_blank" rel="noopener noreferrer" download data-testid="llama-download-plan-save" :title="lazyStrings.llamaCppBrowserDownloads__save_file_to_device()" :aria-label="lazyStrings.llamaCppBrowserDownloads__save_file_to_device()" tw-class="shrink-0 p-1 rounded-lg text-gray-400 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 transition-colors"><DownloadIcon tw-class="w-3.5 h-3.5" /></a>
    </li>
  </ul>
</template>
