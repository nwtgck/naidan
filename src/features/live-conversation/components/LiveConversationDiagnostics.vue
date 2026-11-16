<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { FileAudioIcon, FolderOpenIcon, XIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { LiveInvestigationTask } from '@/features/live-conversation/navigation';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';

const props = defineProps<{ file: File | undefined, busy: boolean, blocked: boolean, task?: LiveInvestigationTask, fileInput?: 'shown' | 'hidden', playbackBlocked?: boolean }>();
const emit = defineEmits<{ select: [files: File[]], clear: [], task: [value: LiveInvestigationTask], replayStart: [element: HTMLAudioElement], replayEnd: [element: HTMLAudioElement] }>();
const transcriptionTask = computed(() => props.task === 'transcription');
const engineOptions = computed(() => [
  { value: 'speech', label: lazyStrings.liveConversation__speech_cpp_in_browser() },
  { value: 'llama', label: lazyStrings.liveConversation__llama_cpp_investigation_unavailable(), disabled: true },
]);
const picker = ref<HTMLInputElement>();
const root = ref<HTMLElement>();
const sourceUrl = ref<string>();
const dragging = ref(false);

watch(() => props.file, file => {
  if (sourceUrl.value) {
    URL.revokeObjectURL(sourceUrl.value);
  }
  sourceUrl.value = file ? URL.createObjectURL(file) : undefined;
}, { immediate: true });
onBeforeUnmount(() => {
  pauseAudio();
  if (sourceUrl.value) {
    URL.revokeObjectURL(sourceUrl.value);
  }
});

function selected({ event }: { event: Event }): void {
  if (event.target instanceof HTMLInputElement && !props.busy && !props.blocked) {
    emit('select', Array.from(event.target.files ?? []));
    event.target.value = '';
  }
}

function drag({ event }: { event: DragEvent }): void {
  if (event.dataTransfer?.types.includes('Files')) {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = props.busy || props.blocked ? 'none' : 'copy';
    dragging.value = !props.busy && !props.blocked;
  }
}

function drop({ event }: { event: DragEvent }): void {
  event.preventDefault();
  event.stopPropagation();
  dragging.value = false;
  if (!props.busy && !props.blocked && event.dataTransfer) {
    emit('select', Array.from(event.dataTransfer.files));
  }
}

function replay({ event, action }: { event: Event, action: 'start' | 'end' }): void {
  if (!(event.target instanceof HTMLAudioElement)) {
    return;
  }
  switch (action) {
  case 'start':
    root.value?.querySelectorAll('audio').forEach(audio => {
      if (audio !== event.target) {
        audio.pause();
      }
    });
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

function pauseAudio(): void {
  root.value?.querySelectorAll('audio').forEach(audio => audio.pause());
}

defineExpose({ pauseAudio, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section ref="root" tw-class="space-y-5" data-testid="live-diagnostics">
    <header tw-class="space-y-1.5"><h2 tw-class="text-base font-semibold tracking-tight text-gray-800 dark:text-gray-100">{{ transcriptionTask ? lazyStrings.liveConversation__transcribe_audio_file() : lazyStrings.liveConversation__generate_from_audio_file() }}</h2><p tw-class="max-w-2xl text-xs leading-6 text-gray-500 dark:text-gray-400">{{ transcriptionTask ? lazyStrings.liveConversation__transcribe_audio_file_help() : lazyStrings.liveConversation__compare_the_same_audio() }}</p></header>
    <div role="tablist" :aria-label="lazyStrings.liveConversation__investigation_task()" tw-class="flex flex-wrap gap-1 border-b border-gray-200 pb-2 dark:border-gray-800"><button type="button" role="tab" :aria-selected="!transcriptionTask" @click="emit('task', 'response')" :tw-class="['rounded-lg px-3 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40', !transcriptionTask ? 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-100' : 'text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800/40']" data-testid="live-diagnostics-response-task">{{ lazyStrings.liveConversation__audio_to_response() }}</button><button type="button" role="tab" :aria-selected="transcriptionTask" @click="emit('task', 'transcription')" :tw-class="['rounded-lg px-3 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40', transcriptionTask ? 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-100' : 'text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800/40']" data-testid="live-diagnostics-transcription-task">{{ lazyStrings.liveConversation__audio_to_transcription() }}</button><button type="button" role="tab" aria-selected="false" disabled :title="lazyStrings.liveConversation__text_to_speech_unavailable()" tw-class="rounded-lg px-3 py-2 text-xs text-gray-500 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400" data-testid="live-diagnostics-tts">{{ lazyStrings.liveConversation__text_to_speech() }}</button></div>
    <div tw-class="space-y-2"><p tw-class="text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__inference_engine() }}</p><span tw-class="block w-full sm:max-w-xs"><SettingsFormSelect model-value="speech" :options="engineOptions" :label="lazyStrings.liveConversation__inference_engine()" :disabled="false" data-testid="live-diagnostics-engine" /></span></div>
    <slot name="model" />
    <slot name="input-controls" />
    <div v-if="fileInput !== 'hidden'" @dragenter="drag({ event: $event })" @dragover="drag({ event: $event })" @dragleave="dragging = false" @drop="drop({ event: $event })" :tw-class="['space-y-4 rounded-2xl border bg-white p-4 transition-colors dark:bg-gray-800/40 sm:p-5', dragging ? 'border-blue-400 bg-blue-50/50 dark:border-blue-500 dark:bg-blue-900/10' : 'border-gray-200/70 dark:border-gray-700/60']" data-testid="live-diagnostics-input">
      <div tw-class="flex items-start gap-3"><FileAudioIcon aria-hidden="true" tw-class="mt-0.5 h-5 w-5 shrink-0 text-blue-500 dark:text-blue-400" /><div tw-class="min-w-0 flex-1"><h3 tw-class="text-xs font-medium text-gray-700 dark:text-gray-200">{{ lazyStrings.liveConversation__input_audio() }}</h3><p v-if="file" tw-class="mt-1 break-all text-sm text-gray-800 dark:text-gray-100" data-testid="live-diagnostics-input-name">{{ file.name }}</p><p v-else tw-class="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__drop_or_choose_audio() }}</p></div><button v-if="file" type="button" :disabled="busy || blocked" @click="emit('clear')" :aria-label="lazyStrings.liveConversation__remove()" :title="lazyStrings.liveConversation__remove()" tw-class="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 dark:hover:bg-gray-700" data-testid="live-diagnostics-clear"><XIcon aria-hidden="true" tw-class="h-4 w-4" /></button></div>
      <audio v-if="sourceUrl" :src="sourceUrl" controls preload="none" :inert="playbackBlocked ? true : undefined" :aria-disabled="playbackBlocked" @play="replay({ event: $event, action: 'start' })" @pause="replay({ event: $event, action: 'end' })" @ended="replay({ event: $event, action: 'end' })" :aria-label="lazyStrings.liveConversation__input_audio()" tw-class="h-10 w-full" data-testid="live-diagnostics-source-replay" />
      <div tw-class="flex flex-wrap items-center gap-3"><button type="button" :disabled="busy || blocked" @click="picker?.click()" tw-class="inline-flex min-h-9 items-center gap-2 rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300 dark:hover:bg-gray-800" data-testid="live-diagnostics-choose"><FolderOpenIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.liveConversation__choose_audio_file() }}</button><p tw-class="text-[11px] text-gray-400 dark:text-gray-500">{{ lazyStrings.liveConversation__audio_file_limits() }}</p></div>
      <input ref="picker" type="file" accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.webm" :disabled="busy || blocked" @change="selected({ event: $event })" :aria-label="lazyStrings.liveConversation__choose_audio_file()" tw-class="sr-only" data-testid="live-diagnostics-file" />
    </div>
    <slot />
  </section>
</template>
