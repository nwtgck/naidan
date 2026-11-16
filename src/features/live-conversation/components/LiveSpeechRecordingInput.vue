<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { DownloadIcon, MicIcon, SquareIcon, Trash2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { SpeechRecordingClip, SpeechRecordingState } from '@/features/live-conversation/logic/speech-recognition-recording';

const props = defineProps<{ purpose: 'transcription' | 'response', source: 'file' | 'microphone', state: SpeechRecordingState, clip: Pick<SpeechRecordingClip, 'id' | 'file' | 'seconds' | 'status'> | undefined, blocked: boolean }>();
const emit = defineEmits<{ source: [value: 'file' | 'microphone'], start: [], stop: [], discard: [], replayStart: [element: HTMLAudioElement], replayEnd: [element: HTMLAudioElement] }>();
const active = computed(() => ['opening', 'recording', 'stopping'].includes(props.state.phase));
const url = ref<string>();
const audio = ref<HTMLAudioElement>();
const testIds = computed(() => {
  const purpose = props.purpose;
  switch (purpose) {
  case 'transcription': return {
    root: 'live-recognition-input',
    file: 'live-recognition-file-source',
    microphone: 'live-recognition-microphone-source',
    start: 'live-recognition-record',
    stop: 'live-recognition-record-stop',
    status: 'live-recognition-record-status',
    discard: 'live-recognition-record-discard',
    replay: 'live-recognition-recording-replay',
    download: 'live-recognition-recording-download',
  };
  case 'response': return {
    root: 'live-response-input',
    file: 'live-response-file-source',
    microphone: 'live-response-microphone-source',
    start: 'live-response-record',
    stop: 'live-response-record-stop',
    status: 'live-response-record-status',
    discard: 'live-response-record-discard',
    replay: 'live-response-recording-replay',
    download: 'live-response-recording-download',
  };
  default: {
    const exhaustive: never = purpose;
    throw new Error(String(exhaustive));
  }
  }
});
watch(() => props.clip?.file, file => {
  pauseAudio();
  if (url.value) {
    URL.revokeObjectURL(url.value);
  }
  url.value = file ? URL.createObjectURL(file) : undefined;
}, { immediate: true });
watch(active, value => {
  if (value) {
    pauseAudio();
  }
});
watch(() => props.source, pauseAudio);
onBeforeUnmount(() => {
  pauseAudio();
  if (url.value) {
    URL.revokeObjectURL(url.value);
  }
});

function pauseAudio(): void {
  if (audio.value && !audio.value.paused) {
    audio.value.pause();
    emit('replayEnd', audio.value);
  }
}

function replay({ event, action }: { event: Event, action: 'start' | 'end' }): void {
  if (!(event.target instanceof HTMLAudioElement)) {
    return;
  }
  switch (action) {
  case 'start':
    if (active.value) {
      event.target.pause();
      return;
    }
    emit('replayStart', event.target);
    break;
  case 'end': emit('replayEnd', event.target);
    break;
  default: {
    const exhaustive: never = action;
    throw new Error(String(exhaustive));
  }
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section tw-class="space-y-4" :data-testid="testIds.root">
    <div><p tw-class="mb-2 text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__audio_input_method() }}</p><div role="group" :aria-label="lazyStrings.liveConversation__audio_input_method()" tw-class="flex flex-wrap gap-2"><button type="button" :aria-pressed="source === 'file'" :disabled="blocked || active" @click="emit('source', 'file')" :tw-class="['min-h-9 rounded-lg border px-3 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40', source === 'file' ? 'border-blue-200 bg-blue-50 text-blue-600 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-400' : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800']" :data-testid="testIds.file">{{ lazyStrings.liveConversation__audio_file() }}</button><button type="button" :aria-pressed="source === 'microphone'" :disabled="blocked || active" @click="emit('source', 'microphone')" :tw-class="['min-h-9 rounded-lg border px-3 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40', source === 'microphone' ? 'border-blue-200 bg-blue-50 text-blue-600 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-400' : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800']" :data-testid="testIds.microphone">{{ lazyStrings.liveConversation__microphone() }}</button></div></div>
    <div v-if="source === 'microphone'" tw-class="space-y-4 rounded-2xl border border-gray-200/70 bg-white p-4 dark:border-gray-700/60 dark:bg-gray-800/40 sm:p-5">
      <div tw-class="flex flex-wrap items-center gap-3"><button v-if="!active" type="button" :disabled="blocked" @click="emit('start')" tw-class="inline-flex min-h-10 items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-medium text-white shadow-sm shadow-blue-500/20 hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40" :data-testid="testIds.start"><MicIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.liveConversation__start_microphone_recording() }}</button><button v-else type="button" :disabled="state.phase === 'stopping'" @click="emit('stop')" tw-class="inline-flex min-h-10 items-center gap-2 rounded-xl border border-gray-200 px-4 py-2.5 text-xs font-medium text-gray-700 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800" :data-testid="testIds.stop"><SquareIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.liveConversation__stop_microphone_recording() }}</button><span v-if="active" role="status" tw-class="text-xs tabular-nums text-gray-500 dark:text-gray-400" :data-testid="testIds.status">{{ state.phase === 'opening' ? lazyStrings.liveConversation__preparing_audio() : state.phase === 'stopping' ? lazyStrings.liveConversation__stopping() : lazyStrings.liveConversation__microphone_recording_in_progress() }} · {{ state.elapsedSeconds.toFixed(1) }} s</span><button v-if="active || clip" type="button" :disabled="blocked && !active" @click="emit('discard')" tw-class="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 py-2 text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800" :data-testid="testIds.discard"><Trash2Icon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.liveConversation__discard_microphone_recording() }}</button></div>
      <p tw-class="text-[11px] leading-6 text-gray-500 dark:text-gray-400">{{ purpose === 'transcription' ? lazyStrings.liveConversation__microphone_recording_help() : lazyStrings.liveConversation__response_microphone_recording_help() }}</p>
      <div v-if="clip && url" tw-class="space-y-2"><p tw-class="text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__recorded_microphone_audio() }} · {{ clip.seconds.toFixed(2) }} s</p><audio ref="audio" :src="url" controls preload="none" :inert="active ? true : undefined" :aria-disabled="active" @play="replay({ event: $event, action: 'start' })" @pause="replay({ event: $event, action: 'end' })" @ended="replay({ event: $event, action: 'end' })" :aria-label="lazyStrings.liveConversation__recorded_microphone_audio()" tw-class="h-10 w-full" :data-testid="testIds.replay" /><a :href="url" :download="`naidan-${purpose}-${clip.id}-input.wav`" tw-class="inline-flex min-h-9 items-center gap-1.5 rounded text-xs text-blue-600 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400" :data-testid="testIds.download"><DownloadIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.liveConversation__save_recorded_audio() }}</a><p v-if="clip.status === 'limit'" role="status" tw-class="text-xs leading-6 text-amber-700 dark:text-amber-300">{{ lazyStrings.liveConversation__recording_limit_reached() }}</p><p v-if="clip.status === 'partial'" role="status" tw-class="text-xs leading-6 text-amber-700 dark:text-amber-300">{{ lazyStrings.liveConversation__partial_microphone_recording() }}</p></div>
      <p v-if="state.failure" role="alert" tw-class="break-words text-xs leading-6 text-red-600 dark:text-red-400">{{ state.failure.message }}</p>
    </div>
  </section>
</template>
