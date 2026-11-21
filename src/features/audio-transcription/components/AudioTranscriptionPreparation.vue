<script setup lang="ts">
import { Loader2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import LiveModelLoadProgress from '@/features/live-conversation/components/LiveModelLoadProgress.vue';
import LlamaCppBrowserDownloadProgress from '@/features/llama-cpp-browser/components/LlamaCppBrowserDownloadProgress.vue';
import type { DownloadProgress } from '@/features/llama-cpp-browser/hugging-face/types';
import type { SpeechLoadProgress } from '@/features/speech-cpp-browser/types';

defineProps<{ downloadProgress: DownloadProgress | undefined, modelLoading: boolean, loadProgress: SpeechLoadProgress | undefined }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="audio-transcription-preparation" tw-class="min-w-0 w-[45%] max-w-64">
    <LlamaCppBrowserDownloadProgress v-if="downloadProgress" :progress="downloadProgress" appearance="welcome" activity="active" compact />
    <LiveModelLoadProgress v-else-if="modelLoading" :progress="loadProgress" compact />
    <p v-else role="status" tw-class="flex min-w-0 items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400"><Loader2Icon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 animate-spin" /><span tw-class="truncate">{{ lazyStrings.AudioTranscriptionWorkspace__preparing_model() }}</span></p>
  </div>
</template>
