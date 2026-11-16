<script setup lang="ts">
import { computed, useId } from 'vue';
import { FileTextIcon, Loader2Icon, SquareIcon } from 'lucide-vue-next';
import { currentLocale, lazyStrings } from '@/strings';
import type { SpeechRecognitionModelInfo } from '@/features/speech-cpp-browser/recognition/types';
import type { SpeechRecognitionRun } from '@/features/speech-cpp-browser/recognition/controller';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import LiveSpeechRecognitionResult from './LiveSpeechRecognitionResult.vue';

const props = defineProps<{ file: File | undefined, run: SpeechRecognitionRun | undefined, model: SpeechRecognitionModelInfo | undefined, language: string, progress: number | undefined, busy: boolean, blocked: boolean, canTranscribe: boolean, unavailable: string | undefined, failure: string | undefined }>();
const emit = defineEmits<{ generate: [], cancel: [], settings: [], language: [value: string] }>();
const id = useId();
const languageOptions = computed(() => {
  const names = new Intl.DisplayNames([currentLocale.value], { type: 'language', languageDisplay: 'standard' });
  return [{ value: '', label: lazyStrings.liveConversation__automatic_recognition_language() }, ...(props.model?.languages ?? []).map(value => {
    let label = value;
    try {
      label = names.of(value) ?? value;
    } catch { /* Native identifiers are not necessarily BCP 47 tags. */ }
    return { value, label };
  })];
});
const status = computed(() => {
  const value = props.run?.status;
  switch (value) {
  case 'preparing': return lazyStrings.liveConversation__preparing_audio();
  case 'recognizing': return lazyStrings.liveConversation__transcribing_audio_file();
  case 'complete': return lazyStrings.liveConversation__transcription_result();
  case 'cancelled': return lazyStrings.liveConversation__transcription_cancelled();
  case 'model_limit': case 'max_seconds': return lazyStrings.liveConversation__transcription_model_limit();
  case 'failed': return lazyStrings.liveConversation__failed();
  case undefined: return undefined;
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
});

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section tw-class="space-y-5" data-testid="live-recognition-investigation">
    <div v-if="model?.languageSelection === 'supported'" tw-class="space-y-2"><label :for="`${id}-language`" tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__recognition_language() }}</label><span tw-class="block w-full sm:max-w-xs"><SettingsFormSelect :id="`${id}-language`" :model-value="language" :options="languageOptions" :label="lazyStrings.liveConversation__recognition_language()" :disabled="busy || blocked" @update:model-value="emit('language', $event)" data-testid="live-recognition-language" /></span></div>
    <div tw-class="flex flex-wrap items-center gap-3"><button v-if="!busy" type="button" :disabled="!file || !canTranscribe || blocked" @click="emit('generate')" tw-class="inline-flex min-h-10 items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-medium text-white shadow-sm shadow-blue-500/20 hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400 disabled:shadow-none dark:disabled:bg-gray-700 dark:disabled:text-gray-500" data-testid="live-recognition-generate"><FileTextIcon aria-hidden="true" tw-class="h-4 w-4" />{{ run ? lazyStrings.liveConversation__transcribe_again() : lazyStrings.liveConversation__transcribe_file() }}</button><button v-else type="button" @click="emit('cancel')" tw-class="inline-flex min-h-10 items-center gap-2 rounded-xl border border-gray-200 px-4 py-2.5 text-xs font-medium text-gray-700 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800" data-testid="live-recognition-cancel"><SquareIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.liveConversation__cancel_transcription() }}</button><span v-if="status" role="status" tw-class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400" data-testid="live-recognition-status"><Loader2Icon v-if="busy" aria-hidden="true" tw-class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{{ status }}</span></div>
    <p v-if="unavailable" role="status" tw-class="text-xs leading-6 text-amber-700 dark:text-amber-300" data-testid="live-recognition-unavailable">{{ unavailable }} <button type="button" @click="emit('settings')" tw-class="rounded text-blue-600 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400">{{ lazyStrings.liveConversation__manage_models_and_runtime() }}</button></p>
    <p v-if="failure" role="alert" tw-class="break-words text-xs leading-6 text-red-600 dark:text-red-400" data-testid="live-recognition-run-failure">{{ failure }}</p>
    <LiveSpeechRecognitionResult :run="run" :progress="progress" />
  </section>
</template>
