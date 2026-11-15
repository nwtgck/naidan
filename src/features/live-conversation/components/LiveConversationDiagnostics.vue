<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { AudioLinesIcon, DownloadIcon, FileAudioIcon, FolderOpenIcon, Loader2Icon, PlayIcon, SquareIcon, XIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { SpeechFileRunState } from '@/features/live-conversation/logic/speech-file-run';

const props = defineProps<{
  file: File | undefined,
  run: SpeechFileRunState | undefined,
  text: string,
  busy: boolean,
  blocked: boolean,
  canGenerate: boolean,
  unavailable: string | undefined,
  selectionFailure: string | undefined,
  tailSeconds: number,
  seed: number,
  modelLoadMilliseconds: number | undefined,
}>();
const emit = defineEmits<{ select: [files: File[]], generate: [], cancel: [], clear: [], settings: [], seed: [value: number], replayStart: [element: HTMLAudioElement], replayEnd: [element: HTMLAudioElement] }>();
const picker = ref<HTMLInputElement>();
const root = ref<HTMLElement>();
const sourceUrl = ref<string>();
const dragging = ref(false);
const failure = computed(() => props.selectionFailure ?? props.run?.failure?.message);
const status = computed(() => {
  const phase = props.run?.status;
  switch (phase) {
  case 'decoding': return lazyStrings.liveConversation__preparing_audio();
  case 'running': return lazyStrings.liveConversation__generating_response();
  case 'complete': return lazyStrings.liveConversation__generation_complete();
  case 'partial': return lazyStrings.liveConversation__generation_cancelled();
  case 'failed': return lazyStrings.liveConversation__failed();
  case undefined: return undefined;
  default: {
    const exhaustive: never = phase;
    throw new Error(String(exhaustive));
  }
  }
});

function editSeed({ event }: { event: Event }): void {
  if (event.target instanceof HTMLInputElement && !props.busy && !props.blocked) {
    emit('seed', event.target.valueAsNumber);
  }
}

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

function downloadName({ run, side }: { run: SpeechFileRunState, side: 'input' | 'output' }): string {
  const name = run.inputName.replace(/\.[^.]+$/, '');
  switch (side) {
  case 'input': return `naidan-${name}-${run.id}-input.wav`;
  case 'output': return `naidan-${name}-${run.id}-response.wav`;
  default: {
    const exhaustive: never = side;
    throw new Error(String(exhaustive));
  }
  }
}

defineExpose({ pauseAudio, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section ref="root" tw-class="space-y-5" data-testid="live-diagnostics">
    <header tw-class="space-y-1.5"><h2 tw-class="text-base font-semibold tracking-tight text-gray-800 dark:text-gray-100">{{ lazyStrings.liveConversation__generate_from_audio_file() }}</h2><p tw-class="max-w-2xl text-xs leading-6 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__compare_the_same_audio() }}</p></header>
    <div role="tablist" :aria-label="lazyStrings.liveConversation__investigation_task()" tw-class="flex gap-1 border-b border-gray-200 pb-2 dark:border-gray-800"><button type="button" role="tab" aria-selected="true" tw-class="rounded-lg bg-gray-100 px-3 py-2 text-xs font-medium text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:bg-gray-800 dark:text-gray-100">{{ lazyStrings.liveConversation__audio_to_response() }}</button><button type="button" role="tab" aria-selected="false" disabled :title="lazyStrings.liveConversation__text_to_speech_unavailable()" tw-class="rounded-lg px-3 py-2 text-xs text-gray-500 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400" data-testid="live-diagnostics-tts">{{ lazyStrings.liveConversation__text_to_speech() }}</button></div>
    <slot name="model" />
    <div @dragenter="drag({ event: $event })" @dragover="drag({ event: $event })" @dragleave="dragging = false" @drop="drop({ event: $event })" :tw-class="['space-y-4 rounded-2xl border bg-white p-4 transition-colors dark:bg-gray-800/40 sm:p-5', dragging ? 'border-blue-400 bg-blue-50/50 dark:border-blue-500 dark:bg-blue-900/10' : 'border-gray-200/70 dark:border-gray-700/60']" data-testid="live-diagnostics-input">
      <div tw-class="flex items-start gap-3"><FileAudioIcon aria-hidden="true" tw-class="mt-0.5 h-5 w-5 shrink-0 text-blue-500 dark:text-blue-400" /><div tw-class="min-w-0 flex-1"><h3 tw-class="text-xs font-medium text-gray-700 dark:text-gray-200">{{ lazyStrings.liveConversation__input_audio() }}</h3><p v-if="file" tw-class="mt-1 break-all text-sm text-gray-800 dark:text-gray-100" data-testid="live-diagnostics-input-name">{{ file.name }}</p><p v-else tw-class="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__drop_or_choose_audio() }}</p></div><button v-if="file" type="button" :disabled="busy || blocked" @click="emit('clear')" :aria-label="lazyStrings.liveConversation__remove()" :title="lazyStrings.liveConversation__remove()" tw-class="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 dark:hover:bg-gray-700" data-testid="live-diagnostics-clear"><XIcon aria-hidden="true" tw-class="h-4 w-4" /></button></div>
      <audio v-if="sourceUrl" :src="sourceUrl" controls preload="none" @play="replay({ event: $event, action: 'start' })" @pause="replay({ event: $event, action: 'end' })" @ended="replay({ event: $event, action: 'end' })" :aria-label="lazyStrings.liveConversation__input_audio()" tw-class="h-10 w-full" data-testid="live-diagnostics-source-replay" />
      <div tw-class="flex flex-wrap items-center gap-3"><button type="button" :disabled="busy || blocked" @click="picker?.click()" tw-class="inline-flex min-h-9 items-center gap-2 rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300 dark:hover:bg-gray-800" data-testid="live-diagnostics-choose"><FolderOpenIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.liveConversation__choose_audio_file() }}</button><p tw-class="text-[11px] text-gray-400 dark:text-gray-500">{{ lazyStrings.liveConversation__audio_file_limits() }}</p></div>
      <input ref="picker" type="file" accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.webm" :disabled="busy || blocked" @change="selected({ event: $event })" :aria-label="lazyStrings.liveConversation__choose_audio_file()" tw-class="sr-only" data-testid="live-diagnostics-file" />
    </div>
    <div tw-class="flex flex-wrap items-center gap-3"><button v-if="!busy" type="button" :disabled="!file || !canGenerate" @click="emit('generate')" tw-class="inline-flex min-h-10 items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-medium text-white shadow-sm shadow-blue-500/20 hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400 disabled:shadow-none dark:disabled:bg-gray-700 dark:disabled:text-gray-500" data-testid="live-diagnostics-generate"><PlayIcon aria-hidden="true" tw-class="h-4 w-4" />{{ run ? lazyStrings.liveConversation__generate_again() : lazyStrings.liveConversation__generate_response() }}</button><button v-else type="button" @click="emit('cancel')" tw-class="inline-flex min-h-10 items-center gap-2 rounded-xl border border-gray-200 px-4 py-2.5 text-xs font-medium text-gray-700 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800" data-testid="live-diagnostics-cancel"><SquareIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.liveConversation__cancel_generation() }}</button><span v-if="status" role="status" tw-class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400" data-testid="live-diagnostics-status"><Loader2Icon v-if="busy" aria-hidden="true" tw-class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{{ status }}</span></div>
    <p tw-class="text-[11px] leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__wait_for_response_after_input({ seconds: tailSeconds }) }}</p>
    <details tw-class="rounded-xl border border-gray-200/70 px-4 py-3 text-xs dark:border-gray-800" data-testid="live-diagnostics-settings"><summary tw-class="cursor-pointer font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__investigation_settings() }}</summary><div tw-class="mt-4 space-y-4"><slot name="settings" /><label tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__random_seed() }}<input :value="seed" @change="editSeed({ event: $event })" type="number" min="0" :max="Number.MAX_SAFE_INTEGER" step="1" :disabled="busy || blocked" :aria-invalid="!Number.isSafeInteger(seed) || seed < 0 || undefined" tw-class="mt-2 block w-40 rounded-lg border border-gray-200/80 bg-gray-50/60 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-40 dark:border-gray-700/60 dark:bg-gray-800/40" data-testid="live-diagnostics-seed" /></label><p tw-class="text-[11px] leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__fixed_seed_help() }}</p></div></details>
    <p v-if="unavailable" role="status" tw-class="text-xs leading-6 text-amber-700 dark:text-amber-300" data-testid="live-diagnostics-unavailable">{{ unavailable }} <button type="button" @click="emit('settings')" tw-class="rounded text-blue-600 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400">{{ lazyStrings.liveConversation__conversation_settings() }}</button></p>
    <p v-if="failure" role="alert" tw-class="break-words text-xs leading-6 text-red-600 dark:text-red-400" data-testid="live-diagnostics-failure">{{ failure }}</p>
    <section v-if="run?.output || text" tw-class="space-y-4 rounded-2xl border border-gray-200/70 bg-white p-4 dark:border-gray-700/60 dark:bg-gray-800/40 sm:p-5" data-testid="live-diagnostics-result">
      <div tw-class="flex flex-wrap items-center justify-between gap-3"><h3 tw-class="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-100"><AudioLinesIcon aria-hidden="true" tw-class="h-4 w-4 text-blue-500" />{{ lazyStrings.liveConversation__generated_response() }}</h3><a v-if="run?.output" :href="run.output.url" :download="downloadName({ run, side: 'output' })" tw-class="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800" data-testid="live-diagnostics-download-output"><DownloadIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.liveConversation__save_response_wav() }}</a></div>
      <audio v-if="run?.output" :src="run.output.url" controls preload="none" @play="replay({ event: $event, action: 'start' })" @pause="replay({ event: $event, action: 'end' })" @ended="replay({ event: $event, action: 'end' })" :aria-label="lazyStrings.liveConversation__generated_response()" tw-class="h-10 w-full" data-testid="live-diagnostics-output-replay" />
      <p v-if="text" tw-class="whitespace-pre-wrap break-words text-sm leading-7" data-testid="live-diagnostics-text">{{ text }}</p>
      <p v-if="run?.output?.status === 'partial'" tw-class="text-xs leading-5 text-amber-700 dark:text-amber-300">{{ lazyStrings.liveConversation__partial_generation_saved() }}</p>
      <p v-if="run?.output" tw-class="text-[11px] leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__wav_contains_generated_audio() }}</p>
    </section>
    <section v-if="run" tw-class="space-y-3 rounded-xl border border-gray-200/70 bg-white/70 p-4 dark:border-gray-800 dark:bg-gray-900/40" data-testid="live-diagnostics-timings">
      <h3 tw-class="text-xs font-medium text-gray-700 dark:text-gray-200">{{ lazyStrings.liveConversation__timings() }}</h3>
      <dl tw-class="grid grid-cols-2 gap-4 sm:grid-cols-3"><div><dt tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__model_loading_time() }}</dt><dd tw-class="mt-1 text-sm font-medium tabular-nums text-gray-800 dark:text-gray-100">{{ modelLoadMilliseconds === undefined ? '—' : `${(modelLoadMilliseconds / 1000).toFixed(2)} s` }}</dd></div><div><dt tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__input_preparation_time() }}</dt><dd tw-class="mt-1 text-sm font-medium tabular-nums text-gray-800 dark:text-gray-100" data-testid="live-diagnostics-prepare-time">{{ run.inputPreparationMilliseconds === undefined ? '—' : `${(run.inputPreparationMilliseconds / 1000).toFixed(2)} s` }}</dd></div><div><dt tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__time_to_first_output() }}</dt><dd tw-class="mt-1 text-sm font-medium tabular-nums text-gray-800 dark:text-gray-100" data-testid="live-diagnostics-first-output">{{ run.firstOutputMilliseconds === undefined ? '—' : `${(run.firstOutputMilliseconds / 1000).toFixed(2)} s` }}</dd></div><div><dt tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__generation_time() }}</dt><dd tw-class="mt-1 text-sm font-medium tabular-nums text-gray-800 dark:text-gray-100" data-testid="live-diagnostics-generation-time">{{ run.generationMilliseconds === undefined ? '—' : `${(run.generationMilliseconds / 1000).toFixed(2)} s` }}</dd></div><div><dt tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__output_audio_length() }}</dt><dd tw-class="mt-1 text-sm font-medium tabular-nums text-gray-800 dark:text-gray-100">{{ run.outputStatistics.seconds.toFixed(2) }} s</dd></div><div><dt tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__generation_seconds_per_audio_second() }}</dt><dd tw-class="mt-1 text-sm font-medium tabular-nums text-gray-800 dark:text-gray-100" data-testid="live-diagnostics-rtf">{{ run.generationMilliseconds === undefined || run.outputStatistics.seconds <= 0 ? '—' : `${(run.generationMilliseconds / 1000 / run.outputStatistics.seconds).toFixed(3)} s/s` }}</dd></div></dl>
      <p tw-class="text-[11px] leading-5 text-gray-400 dark:text-gray-500">{{ lazyStrings.liveConversation__rtf_excludes_preparation() }}</p><p tw-class="text-[11px] text-gray-400 dark:text-gray-500">{{ lazyStrings.liveConversation__run_total() }}: {{ (run.elapsedMilliseconds / 1000).toFixed(2) }} s</p>
    </section>
    <details v-if="run" tw-class="rounded-xl border border-gray-200/70 px-4 py-3 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400" data-testid="live-diagnostics-details"><summary tw-class="cursor-pointer font-medium">{{ lazyStrings.liveConversation__audio_details() }}</summary><div tw-class="mt-4 space-y-4"><div><h3 tw-class="mb-1 font-medium">{{ lazyStrings.liveConversation__input_audio() }}</h3><p tw-class="break-words font-mono">{{ lazyStrings.liveConversation__audio_statistics({ seconds: run.inputStatistics.seconds.toFixed(2), sampleRate: run.inputStatistics.sampleRate, peak: run.inputStatistics.peak.toFixed(4), rms: run.inputStatistics.rms.toFixed(4), clipped: run.inputStatistics.clippedSamples }) }}</p><a v-if="run.input" :href="run.input.url" :download="downloadName({ run, side: 'input' })" tw-class="mt-2 inline-flex items-center gap-1.5 rounded text-blue-600 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400" data-testid="live-diagnostics-download-input"><DownloadIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.liveConversation__save_submitted_input_wav() }}</a></div><div><h3 tw-class="mb-1 font-medium">{{ lazyStrings.liveConversation__generated_response() }}</h3><p tw-class="break-words font-mono">{{ lazyStrings.liveConversation__audio_statistics({ seconds: run.outputStatistics.seconds.toFixed(2), sampleRate: run.outputStatistics.sampleRate, peak: run.outputStatistics.peak.toFixed(4), rms: run.outputStatistics.rms.toFixed(4), clipped: run.outputStatistics.clippedSamples }) }}</p></div><p tw-class="break-words font-mono">{{ lazyStrings.liveConversation__file_generation_statistics({ submitted: run.submittedSamples, frames: run.frames, seconds: (run.elapsedMilliseconds / 1000).toFixed(2), tail: run.effectiveTailSeconds.toFixed(2), gaps: run.sequenceDiscontinuities }) }}</p><p>{{ lazyStrings.liveConversation__random_seed() }}: {{ run.seed }} · {{ lazyStrings.liveConversation__conversation_language() }}: {{ run.language }}</p><div v-if="run.firstFrameStatistics"><h3 tw-class="mb-1 font-medium">{{ lazyStrings.liveConversation__first_output_frame() }}</h3><p tw-class="break-words font-mono">{{ lazyStrings.liveConversation__audio_statistics({ seconds: run.firstFrameStatistics.seconds.toFixed(2), sampleRate: run.firstFrameStatistics.sampleRate, peak: run.firstFrameStatistics.peak.toFixed(4), rms: run.firstFrameStatistics.rms.toFixed(4), clipped: run.firstFrameStatistics.clippedSamples }) }}</p></div><code v-if="run.failure" tw-class="block whitespace-pre-wrap break-words">{{ run.failure.message }}<template v-if="run.failure.nativeStatus !== undefined">{{ '\n' }}{{ run.failure.nativeStatus }}</template><template v-if="run.failure.nativeInput !== undefined">{{ '\n' }}{{ run.failure.nativeInput }}</template></code></div></details>
  </section>
</template>
