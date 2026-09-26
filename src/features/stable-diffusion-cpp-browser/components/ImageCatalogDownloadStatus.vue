<script setup lang="ts">
import { computed } from 'vue';
import { Loader2Icon, PauseIcon, PlayIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import LlamaCppBrowserDownloadProgress from '@/features/llama-cpp-browser/components/LlamaCppBrowserDownloadProgress.vue';
import type { ImageLibraryView } from '@/features/stable-diffusion-cpp-browser/library-view';
import type { DownloadProgress } from '@/features/llama-cpp-browser/hugging-face/types';
const props = defineProps<{ view: ImageLibraryView, disabled: boolean }>();
const { downloadState, downloadProgress, downloading } = props.view;
const progress = computed<DownloadProgress | undefined>(() => {
  const value = downloadProgress.value;
  if (!value || value.total === 0) return undefined;
  const phase = (() => {
    switch (value.phase) {
    case 'transferring': return 'transferring';
    case 'checking': case 'verifying': case 'complete': return 'verifying';
    default: { const exhaustive: never = value.phase; throw new Error(String(exhaustive)); }
    }
  })();
  return { completed: value.completed, total: value.total, processed: value.processed, phase };
});
const status = computed(() => {
  switch (downloadState.value) {
  case 'idle': return undefined;
  case 'downloading': {
    const phase = downloadProgress.value?.phase;
    switch (phase) {
    case 'checking': return lazyStrings.llamaCppBrowserDownloads__checking_hugging_face();
    case 'transferring': case 'verifying': case 'complete': case undefined: return lazyStrings.stableDiffusionCppBrowser__downloading_selected();
    default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
    }
  }
  case 'complete': return lazyStrings.stableDiffusionCppBrowser__download_complete();
  case 'paused': return lazyStrings.llamaCppBrowserDownloads__paused();
  case 'failed': return lazyStrings.stableDiffusionCppBrowser__download_failed();
  case 'incomplete': return lazyStrings.stableDiffusionCppBrowser__downloaded_but_incomplete();
  default: { const exhaustive: never = downloadState.value; throw new Error(String(exhaustive)); }
  }
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div v-if="status" tw-class="mt-2 space-y-2" data-testid="image-download-job">
    <div tw-class="flex flex-wrap items-center justify-between gap-2 text-xs">
      <span role="status" :tw-class="['inline-flex min-w-0 items-center gap-1.5', downloadState === 'failed' || downloadState === 'incomplete' ? 'text-amber-700 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400']">
        <Loader2Icon v-if="downloading" tw-class="w-3.5 h-3.5 shrink-0 animate-spin motion-reduce:animate-none" />{{ status }}
      </span>
      <button v-if="downloading" type="button" :disabled="disabled" @click="view.cancelDownload()" data-testid="image-cancel-download" tw-class="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"><PauseIcon tw-class="w-3 h-3" />{{ lazyStrings.llamaCppBrowserDownloads__pause() }}</button>
      <button v-else-if="downloadState === 'paused' || downloadState === 'failed'" type="button" :disabled="disabled" @click="view.resumeDownload()" data-testid="image-resume-download" tw-class="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 font-medium text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 disabled:opacity-50"><PlayIcon tw-class="w-3 h-3" />{{ downloadState === 'paused' ? lazyStrings.llamaCppBrowserDownloads__resume() : lazyStrings.llamaCppBrowserDownloads__retry() }}</button>
    </div>
    <template v-if="downloading && downloadProgress">
      <p tw-class="min-w-0 truncate text-[11px] text-gray-500 dark:text-gray-400" :title="downloadProgress.path">{{ downloadProgress.index + 1 }}/{{ downloadProgress.count }} · {{ downloadProgress.path.split('/').at(-1) }}</p>
      <LlamaCppBrowserDownloadProgress v-if="progress" :key="downloadProgress.phase" :progress="progress" />
    </template>
  </div>
</template>
