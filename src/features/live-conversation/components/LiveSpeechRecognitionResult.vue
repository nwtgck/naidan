<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { CheckIcon, CopyIcon, FileTextIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { SpeechRecognitionRun } from '@/features/speech-cpp-browser/recognition/controller';

const props = defineProps<{ run: SpeechRecognitionRun | undefined, progress: number | undefined }>();
const copyState = ref<'idle' | 'copying' | 'copied' | 'failed'>('idle');
let disposed = false;
const pending = computed(() => props.run?.status === 'preparing' || props.run?.status === 'recognizing');
const percentage = computed(() => props.run?.status === 'recognizing' && props.progress !== undefined ? Math.min(100, Math.max(0, Math.floor(props.progress * 100))) : undefined);
const progressLabel = computed(() => {
  const status = props.run?.status;
  switch (status) {
  case 'preparing': return lazyStrings.liveConversation__preparing_audio();
  case 'recognizing': return lazyStrings.liveConversation__transcribing_audio_file();
  case 'complete': case 'cancelled': case 'model_limit': case 'max_seconds': case 'failed': case undefined: return undefined;
  default: {
    const exhaustive: never = status;
    throw new Error(String(exhaustive));
  }
  }
});
const resultAvailable = computed(() => props.run !== undefined && !pending.value);
const completion = computed(() => {
  const status = props.run?.status;
  switch (status) {
  case 'cancelled': return lazyStrings.liveConversation__transcription_cancelled();
  case 'model_limit': case 'max_seconds': return lazyStrings.liveConversation__transcription_model_limit();
  case 'failed': return lazyStrings.liveConversation__failed();
  case 'preparing': case 'recognizing': case 'complete': case undefined: return undefined;
  default: {
    const exhaustive: never = status;
    throw new Error(String(exhaustive));
  }
  }
});

watch([() => props.run?.id, () => props.run?.text], () => {
  copyState.value = 'idle';
});
onBeforeUnmount(() => {
  disposed = true;
});

async function copyTranscript(): Promise<void> {
  const run = props.run;
  if (!run || !resultAvailable.value || !run.text.trim() || copyState.value === 'copying') {
    return;
  }
  const { id, text } = run;
  copyState.value = 'copying';
  try {
    await navigator.clipboard.writeText(text);
    if (!disposed && props.run?.id === id && props.run.text === text) {
      copyState.value = 'copied';
    }
  } catch {
    if (!disposed && props.run?.id === id && props.run.text === text) {
      copyState.value = 'failed';
    }
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div v-if="run" tw-class="space-y-5" data-testid="live-recognition-result">
    <div v-if="pending" tw-class="w-full space-y-2" data-testid="live-recognition-progress"><div tw-class="flex items-center justify-between gap-3 text-xs text-gray-600 dark:text-gray-300"><span role="status">{{ progressLabel }}</span><span v-if="percentage !== undefined" tw-class="tabular-nums">{{ percentage }}%</span></div><div role="progressbar" :aria-label="progressLabel" :aria-valuemin="0" :aria-valuemax="100" :aria-valuenow="percentage" tw-class="h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800" data-testid="live-recognition-progress-bar"><div v-if="percentage !== undefined" :style="{ width: `${percentage}%` }" tw-class="h-full rounded-full bg-blue-500 transition-[width] motion-reduce:transition-none" /><div v-else tw-class="h-full w-1/3 animate-pulse rounded-full bg-blue-500/70 motion-reduce:animate-none" /></div></div>
    <section v-if="resultAvailable" tw-class="space-y-4 rounded-2xl border border-gray-200/70 bg-white p-4 dark:border-gray-700/60 dark:bg-gray-800/40 sm:p-5">
      <div tw-class="flex flex-wrap items-center justify-between gap-3"><h3 tw-class="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-100"><FileTextIcon aria-hidden="true" tw-class="h-4 w-4 text-blue-500" />{{ lazyStrings.liveConversation__transcription_result() }}</h3><button type="button" :disabled="!run.text.trim() || copyState === 'copying'" @click="copyTranscript" tw-class="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800" data-testid="live-recognition-copy"><CheckIcon v-if="copyState === 'copied'" aria-hidden="true" tw-class="h-3.5 w-3.5" /><CopyIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ copyState === 'copied' ? lazyStrings.liveConversation__transcription_copied() : lazyStrings.liveConversation__copy_transcription() }}</button></div>
      <p tw-class="break-all text-[11px] leading-5 text-gray-500 dark:text-gray-400" data-testid="live-recognition-source">{{ run.modelName }} · {{ run.inputName }}</p>
      <p v-if="run.text" tw-class="whitespace-pre-wrap break-words text-sm leading-7" data-testid="live-recognition-text">{{ run.text }}</p>
      <p v-if="run.status === 'complete' && !run.text.trim()" tw-class="text-xs leading-6 text-gray-500 dark:text-gray-400" data-testid="live-recognition-empty">{{ lazyStrings.liveConversation__no_text_recognized() }}</p>
      <p v-if="completion" role="status" tw-class="text-xs leading-6 text-amber-700 dark:text-amber-300" data-testid="live-recognition-completion">{{ completion }}</p>
      <p v-if="copyState === 'failed'" role="status" tw-class="text-xs leading-6 text-amber-700 dark:text-amber-300" data-testid="live-recognition-copy-failure">{{ lazyStrings.liveConversation__could_not_copy_transcription() }}</p>
      <span v-if="copyState === 'copied'" role="status" tw-class="sr-only">{{ lazyStrings.liveConversation__transcription_copied() }}</span>
    </section>
    <section tw-class="space-y-3 rounded-xl border border-gray-200/70 bg-white/70 p-4 dark:border-gray-800 dark:bg-gray-900/40" data-testid="live-recognition-timings">
      <h3 tw-class="text-xs font-medium text-gray-700 dark:text-gray-200">{{ lazyStrings.liveConversation__timings() }}</h3>
      <dl tw-class="grid grid-cols-2 gap-4 sm:grid-cols-3"><div><dt tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__input_audio_length() }}</dt><dd tw-class="mt-1 text-sm font-medium tabular-nums text-gray-800 dark:text-gray-100" data-testid="live-recognition-input-seconds">{{ run.inputSeconds === undefined ? '—' : `${run.inputSeconds.toFixed(2)} s` }}</dd></div><div><dt tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__input_preparation_time() }}</dt><dd tw-class="mt-1 text-sm font-medium tabular-nums text-gray-800 dark:text-gray-100" data-testid="live-recognition-preparation-seconds">{{ run.preparationSeconds === undefined ? '—' : `${run.preparationSeconds.toFixed(2)} s` }}</dd></div><div><dt tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__transcription_processing_time() }}</dt><dd tw-class="mt-1 text-sm font-medium tabular-nums text-gray-800 dark:text-gray-100" data-testid="live-recognition-processing-seconds">{{ run.recognitionSeconds === undefined ? '—' : `${run.recognitionSeconds.toFixed(2)} s` }}</dd></div></dl>
      <p tw-class="text-[11px] leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__transcription_processing_time_help() }}</p>
    </section>
    <details v-if="run.failure" tw-class="rounded-xl border border-red-200 px-4 py-3 text-xs text-red-600 dark:border-red-900 dark:text-red-400" data-testid="live-recognition-failure"><summary tw-class="cursor-pointer font-medium">{{ lazyStrings.liveConversation__failed() }}</summary><code tw-class="mt-3 block whitespace-pre-wrap break-words">{{ run.failure.message }}<template v-if="run.failure.nativeStatus !== undefined">{{ '\n' }}{{ run.failure.nativeStatus }}</template><template v-if="run.failure.nativeInput !== undefined">{{ '\n' }}{{ run.failure.nativeInput }}</template></code></details>
  </div>
</template>
