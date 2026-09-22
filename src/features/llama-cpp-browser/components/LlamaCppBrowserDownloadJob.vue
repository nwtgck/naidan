<script setup lang="ts">
import { computed } from 'vue';
import { AlertCircleIcon, Loader2Icon, PauseIcon, PlayIcon, XIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { getDownloadQueue, type DownloadJob } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import LlamaCppBrowserDownloadProgress from './LlamaCppBrowserDownloadProgress.vue';
const props = defineProps<{ job: DownloadJob, disabled: boolean }>();
const emit = defineEmits<{ resume: [] }>();
const queue = getDownloadQueue();
const errorText = computed(() => {
  switch (props.job.error) {
  case 'selection-unavailable': return lazyStrings.llamaCppBrowserDownloads__plan_needs_review();
  case 'projector-conflict': return lazyStrings.LlamaCppBrowserHuggingFaceManager__shared_multimodal_file_conflict();
  case 'existing-files': return lazyStrings.LlamaCppBrowserHuggingFaceManager__model_files_already_exist();
  case 'different-download': return lazyStrings.LlamaCppBrowserHuggingFaceManager__another_download_already_exists();
  case 'failed': return lazyStrings.LlamaCppBrowserHuggingFaceManager__download_failed_retry_or_resume();
  case undefined: return undefined;
  default: { const exhaustive: never = props.job.error; throw new Error(String(exhaustive)); }
  }
});
const position = computed(() => queue.position({ id: props.job.id }));
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-2" data-testid="llama-download-job">
    <div v-if="job.status === 'queued'" tw-class="flex items-center justify-between gap-3 text-xs">
      <span role="status" tw-class="text-gray-500 dark:text-gray-400">{{ position === undefined ? lazyStrings.llamaCppBrowserDownloads__waiting() : lazyStrings.llamaCppBrowserDownloads__queue_position({ position }) }}</span>
      <button type="button" data-testid="llama-download-cancel" tw-class="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800" @click="queue.cancel({ id: job.id })"><XIcon tw-class="w-3 h-3" />{{ lazyStrings.SHARED__cancel() }}</button>
    </div>
    <div v-else-if="job.status === 'resolving' || job.status === 'pausing'" tw-class="flex items-center justify-between gap-3 text-xs text-gray-500 dark:text-gray-400">
      <span role="status" tw-class="inline-flex items-center gap-2"><Loader2Icon tw-class="w-3.5 h-3.5 animate-spin" />{{ job.status === 'pausing' ? lazyStrings.llamaCppBrowserDownloads__pausing() : lazyStrings.llamaCppBrowserDownloads__checking_hugging_face() }}</span>
      <button v-if="job.status === 'resolving'" type="button" data-testid="llama-download-cancel" tw-class="px-2 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800" @click="queue.cancel({ id: job.id })">{{ lazyStrings.SHARED__cancel() }}</button>
    </div>
    <template v-else-if="job.status === 'downloading'">
      <LlamaCppBrowserDownloadProgress :progress="job.progress" />
      <div tw-class="flex justify-end"><button type="button" data-testid="llama-download-pause" tw-class="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800" @click="queue.cancel({ id: job.id })"><PauseIcon tw-class="w-3 h-3" />{{ lazyStrings.llamaCppBrowserDownloads__pause() }}</button></div>
    </template>
    <template v-else-if="job.status === 'paused' || job.status === 'failed'">
      <p v-if="errorText" role="alert" tw-class="flex items-start gap-2 text-xs text-red-600 dark:text-red-400"><AlertCircleIcon tw-class="w-3.5 h-3.5 shrink-0 mt-0.5" />{{ errorText }}</p>
      <div tw-class="flex items-center justify-between gap-3 text-xs text-gray-500 dark:text-gray-400">
        <span v-if="job.status === 'paused'" role="status">{{ lazyStrings.llamaCppBrowserDownloads__paused() }}</span>
        <button type="button" :disabled="disabled" data-testid="llama-download-resume" tw-class="inline-flex items-center gap-1.5 ml-auto px-2 py-1 rounded-lg font-bold text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 disabled:opacity-50 disabled:cursor-not-allowed" @click="emit('resume')"><PlayIcon tw-class="w-3 h-3" />{{ job.status === 'paused' ? lazyStrings.llamaCppBrowserDownloads__resume() : lazyStrings.llamaCppBrowserDownloads__retry() }}</button>
      </div>
    </template>
  </div>
</template>
