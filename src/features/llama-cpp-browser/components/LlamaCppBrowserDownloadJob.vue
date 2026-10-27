<script setup lang="ts">
import { computed } from 'vue';
import { AlertCircleIcon, Loader2Icon, PauseIcon, PlayIcon, XIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import CspMessageHint from '@/components/csp/CspMessageHint.vue';
import HuggingFaceDownloadFailureHint from '@/components/HuggingFaceDownloadFailureHint.vue';
import LlamaCppBrowserLocalFileRecovery from './LlamaCppBrowserLocalFileRecovery.vue';
import { getDownloadQueue, type DownloadJob } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import type { ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import LlamaCppBrowserDownloadProgress from './LlamaCppBrowserDownloadProgress.vue';
import LlamaCppBrowserDownloadSources from './LlamaCppBrowserDownloadSources.vue';
import LlamaCppBrowserModelActionButton from './LlamaCppBrowserModelActionButton.vue';
const props = defineProps<{ job: DownloadJob, disabled: boolean, acceptLocalInput: (({ directories, controller }: { directories: Promise<ModelDirectoryInput[]>, controller: AbortController }) => void | Promise<void>) | undefined, appearance: 'manager' | 'welcome', sourcesVisibility?: 'visible' | 'hidden', density?: 'regular' | 'compact' }>();
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
  default: {
    const exhaustive: never = props.job.error;
    throw new Error(String(exhaustive));
  }
  }
});
const position = computed(() => queue.position({ id: props.job.id }));
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div v-if="appearance === 'welcome'" tw-class="space-y-1" data-testid="llama-download-job">
    <div :tw-class="['flex justify-between gap-2', density === 'compact' ? 'items-start' : 'min-h-9 items-center']">
      <div tw-class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1"><span role="status" :tw-class="['inline-flex items-center gap-2 font-medium text-gray-700 dark:text-gray-200', density === 'compact' ? 'text-xs' : 'text-sm']"><Loader2Icon v-if="job.status === 'resolving' || job.status === 'pausing'" aria-hidden="true" tw-class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{{ job.status === 'queued' ? (position === undefined ? lazyStrings.llamaCppBrowserDownloads__waiting() : lazyStrings.llamaCppBrowserDownloads__queue_position({ position })) : job.status === 'resolving' ? lazyStrings.llamaCppBrowserDownloads__checking_hugging_face() : job.status === 'pausing' ? lazyStrings.llamaCppBrowserDownloads__pausing() : job.status === 'paused' ? lazyStrings.llamaCppBrowserDownloads__paused() : job.status === 'failed' ? lazyStrings.LlamaCppBrowserHuggingFaceManager__download_failed_retry_or_resume() : lazyStrings.LlamaCppBrowserHuggingFaceManager__downloading_model() }}</span><slot name="metadata" /></div>
      <button v-if="job.status === 'downloading' || job.status === 'queued' || job.status === 'resolving'" type="button" :data-testid="job.status === 'downloading' ? 'llama-download-pause' : 'llama-download-cancel'" tw-class="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-blue-400 focus-visible:outline-2 focus-visible:outline-blue-500 transition-colors motion-reduce:transition-none" @click="queue.cancel({ id: job.id })"><PauseIcon v-if="job.status === 'downloading'" aria-hidden="true" tw-class="h-3 w-3" /><XIcon v-else aria-hidden="true" tw-class="h-3 w-3" />{{ job.status === 'downloading' ? lazyStrings.llamaCppBrowserDownloads__pause() : lazyStrings.SHARED__cancel() }}</button>
      <button v-else-if="job.status === 'paused' || job.status === 'failed'" type="button" :disabled="disabled" data-testid="llama-download-resume" tw-class="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-blue-400 focus-visible:outline-2 focus-visible:outline-blue-500 transition-colors motion-reduce:transition-none disabled:opacity-50" @click="emit('resume')"><PlayIcon aria-hidden="true" tw-class="h-3 w-3" />{{ job.status === 'paused' ? lazyStrings.llamaCppBrowserDownloads__resume() : lazyStrings.llamaCppBrowserDownloads__retry() }}</button>
    </div>
    <p v-if="errorText" role="alert" tw-class="flex items-start gap-2 text-xs text-red-600 dark:text-red-400"><AlertCircleIcon aria-hidden="true" tw-class="mt-0.5 h-3.5 w-3.5 shrink-0" />{{ errorText }}</p>
    <HuggingFaceDownloadFailureHint v-if="job.status === 'failed'" :key="job.id"><LlamaCppBrowserLocalFileRecovery :disabled="disabled" :accept-local-input="acceptLocalInput" /></HuggingFaceDownloadFailureHint>
    <CspMessageHint v-else-if="job.status === 'paused'" :target="{ kind: 'huggingface-download' }" activity-for-display-only="download" presentation="compact" />
    <LlamaCppBrowserDownloadProgress v-if="job.progress" :progress="job.progress" :appearance="density === 'compact' ? 'manager' : 'welcome'" :activity="job.status === 'downloading' ? 'active' : 'inactive'" />
    <LlamaCppBrowserDownloadSources v-if="sourcesVisibility !== 'hidden'" :job="job" />
  </div>
  <div v-else tw-class="space-y-2 rounded-lg bg-gray-50/80 p-2.5 dark:bg-gray-950/20" data-testid="llama-download-job">
    <div v-if="job.status === 'queued'" tw-class="flex items-center justify-between gap-3 text-xs">
      <span role="status" tw-class="text-gray-500 dark:text-gray-400">{{ position === undefined ? lazyStrings.llamaCppBrowserDownloads__waiting() : lazyStrings.llamaCppBrowserDownloads__queue_position({ position }) }}</span>
      <LlamaCppBrowserModelActionButton :disabled="false" data-testid="llama-download-cancel" @click="queue.cancel({ id: job.id })"><XIcon aria-hidden="true" tw-class="h-3 w-3" />{{ lazyStrings.SHARED__cancel() }}</LlamaCppBrowserModelActionButton>
    </div>
    <div v-else-if="job.status === 'resolving' || job.status === 'pausing'" :tw-class="['flex gap-3 text-xs text-gray-500 dark:text-gray-400', 'items-center justify-between']">
      <span role="status" tw-class="inline-flex items-center gap-2"><Loader2Icon tw-class="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" />{{ job.status === 'pausing' ? lazyStrings.llamaCppBrowserDownloads__pausing() : lazyStrings.llamaCppBrowserDownloads__checking_hugging_face() }}</span>
      <LlamaCppBrowserModelActionButton v-if="job.status === 'resolving'" :disabled="false" data-testid="llama-download-cancel" @click="queue.cancel({ id: job.id })"><XIcon aria-hidden="true" tw-class="h-3 w-3" />{{ lazyStrings.SHARED__cancel() }}</LlamaCppBrowserModelActionButton>
    </div>
    <template v-else-if="job.status === 'downloading'">
      <LlamaCppBrowserDownloadProgress :progress="job.progress" :appearance="appearance" />
      <div tw-class="flex justify-end"><LlamaCppBrowserModelActionButton :disabled="false" data-testid="llama-download-pause" @click="queue.cancel({ id: job.id })"><PauseIcon aria-hidden="true" tw-class="h-3 w-3" />{{ lazyStrings.llamaCppBrowserDownloads__pause() }}</LlamaCppBrowserModelActionButton></div>
    </template>
    <template v-else-if="job.status === 'paused' || job.status === 'failed'">
      <p v-if="errorText" role="alert" tw-class="flex items-start gap-2 text-xs text-red-600 dark:text-red-400"><AlertCircleIcon tw-class="w-3.5 h-3.5 shrink-0 mt-0.5" />{{ errorText }}</p>
      <HuggingFaceDownloadFailureHint v-if="job.status === 'failed'" :key="job.id"><LlamaCppBrowserLocalFileRecovery :disabled="disabled" :accept-local-input="acceptLocalInput" /></HuggingFaceDownloadFailureHint>
      <CspMessageHint v-else-if="job.status === 'paused'" :target="{ kind: 'huggingface-download' }" activity-for-display-only="download" presentation="compact" />
      <div :tw-class="['flex gap-3 text-xs text-gray-500 dark:text-gray-400', 'items-center justify-between']">
        <span v-if="job.status === 'paused'" role="status">{{ lazyStrings.llamaCppBrowserDownloads__paused() }}</span>
        <LlamaCppBrowserModelActionButton :disabled="disabled" data-testid="llama-download-resume" tw-class="ml-auto" @click="emit('resume')"><PlayIcon aria-hidden="true" tw-class="h-3 w-3" />{{ job.status === 'paused' ? lazyStrings.llamaCppBrowserDownloads__resume() : lazyStrings.llamaCppBrowserDownloads__retry() }}</LlamaCppBrowserModelActionButton>
      </div>
    </template>

  </div>
</template>
