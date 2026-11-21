<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { CheckIcon, ChevronDownIcon, CopyIcon, FileAudioIcon, FileUpIcon, InfoIcon, Loader2Icon, MicIcon, PauseIcon, PictureInPicture2Icon, PlayIcon, SlidersHorizontalIcon, SquareIcon, XIcon } from 'lucide-vue-next';
import { useAudioTranscriptionPreferences } from '@/features/audio-transcription/composables/useAudioTranscriptionPreferences';
import logoUrl from '@/assets/logo.svg?inline';
import { ensureStrings, lazyStrings } from '@/strings';
import AudioTranscriptionModelSelector from '@/features/audio-transcription/components/AudioTranscriptionModelSelector.vue';
import { useAudioTranscriptionModels } from '@/features/audio-transcription/composables/useAudioTranscriptionModels';
import { useAudioTranscriptionWorkflow } from '@/features/audio-transcription/composables/useAudioTranscriptionWorkflow';
import { useAudioTranscriptionFloatingWindow } from '@/features/audio-transcription/composables/useAudioTranscriptionFloatingWindow';
import AudioTranscriptionPreparation from '@/features/audio-transcription/components/AudioTranscriptionPreparation.vue';
import AudioTranscriptionEditor from '@/features/audio-transcription/components/AudioTranscriptionEditor.vue';
import AudioTranscriptionClipboardNotice from '@/features/audio-transcription/components/AudioTranscriptionClipboardNotice.vue';
import AudioTranscriptionMicrophoneActivity from '@/features/audio-transcription/components/AudioTranscriptionMicrophoneActivity.vue';
import { minimumMicrophoneSegmentSeconds, maximumMicrophoneSegmentSeconds } from '@/features/audio-transcription/logic/continuous-transcription';

const props = defineProps<{ source: 'microphone' | 'file' }>();
const emit = defineEmits<{ changeSource: [source: 'microphone' | 'file'] }>();
const preferences = useAudioTranscriptionPreferences();
const { autoCopy, saving: savingAutoCopy, updateAutoCopy } = preferences;
const text = ref('');
const copied = ref(false);
const notice = ref('');
const fileInput = ref<HTMLInputElement>();
const selectedFile = ref<File>();
const dragging = ref(false);
// Single-language recognizers do not accept an explicit language override.
// Start with the model's automatic/default behavior so every catalog model can run.
const language = computed({
  get: () => preferences.recognitionLanguage.value,
  set(value: 'ja' | 'auto' | 'en') {
    void preferences.updateRecognitionLanguage({ value });
  },
});
const modelAutoLoad = computed({
  get: () => preferences.modelAutoLoad.value === 'enabled',
  set(value: boolean) {
    void preferences.updateModelAutoLoad({ value: value ? 'enabled' : 'disabled' });
  },
});
const languageTitle = computed(() => {
  switch (language.value) {
  case 'ja': return lazyStrings.AudioTranscriptionWorkspace__japanese();
  case 'auto': return lazyStrings.AudioTranscriptionWorkspace__automatic_detection();
  case 'en': return lazyStrings.AudioTranscriptionWorkspace__english();
  default: {
    const exhaustive: never = language.value;
    return exhaustive;
  }
  }
});
const modelSelection = useAudioTranscriptionModels({ preference: preferences });
const { models: selectableModels, selectedId: selectedModelId } = modelSelection;
const recognitionLanguage = computed(() => {
  switch (language.value) {
  case 'auto': return undefined;
  case 'ja': case 'en': return language.value;
  default: {
    const exhaustive: never = language.value;
    return exhaustive;
  }
  }
});
const floatingWindow = useAudioTranscriptionFloatingWindow({
  microphone: computed(() => props.source === 'microphone'),
  title: () => lazyStrings.launcher__audio_transcription() ?? document.title,
});
const floatingDocument = floatingWindow.document;
const workflow = useAudioTranscriptionWorkflow({ source: computed(() => props.source), text, autoCopy, models: modelSelection, language: recognitionLanguage, microphoneSegmentMaxSeconds: preferences.microphoneSegmentMaxSeconds, getClipboardWindow: floatingWindow.clipboardWindow });
const { phase, pending, preloading, runtimeState, provisionalText, failureDetails, clipboardError, visibleText, autoCopyCurrent, state: recognitionState } = workflow;
const hasTranscript = computed(() => visibleText.value !== '');
const floatingWindowLabel = computed(() => floatingWindow.supported ? lazyStrings.AudioTranscriptionWorkspace__open_floating_window() : lazyStrings.AudioTranscriptionWorkspace__floating_window_unavailable());
const floatingModelLabel = computed(() => modelSelection.pickerModels.value.find(model => model.id === selectedModelId.value)?.label);
const transcriptCopyStatus = computed(() => {
  const count = visibleText.value.length;
  if (count === 0) {
    return '';
  }
  return autoCopyCurrent.value ? lazyStrings.AudioTranscriptionWorkspace__full_transcription_copied({ count }) : lazyStrings.AudioTranscriptionWorkspace__full_transcription_not_copied({ count });
});
const clipboardNotice = computed(() => {
  const error = clipboardError.value;
  switch (error) {
  case 'interaction': return lazyStrings.AudioTranscriptionWorkspace__tap_to_resume_auto_copy();
  case 'write': return lazyStrings.AudioTranscriptionWorkspace__could_not_auto_copy();
  case undefined: return undefined;
  default: {
    const exhaustive: never = error;
    throw new Error(String(exhaustive));
  }
  }
});
const showModelPreparation = computed(() => phase.value === 'preparing' || runtimeState.value.phase === 'loading_model');
const fileRunning = computed(() => pending.value && !preloading.value);
const inputActionLabel = computed(() => {
  if (preloading.value) {
    return lazyStrings.AudioTranscriptionWorkspace__start_voice_input();
  }
  switch (phase.value) {
  case 'idle': return lazyStrings.AudioTranscriptionWorkspace__start_voice_input();
  case 'recording': case 'paused': return lazyStrings.AudioTranscriptionWorkspace__end_voice_input();
  case 'preparing': case 'finishing': return lazyStrings.AudioTranscriptionWorkspace__cancel();
  default: {
    const exhaustive: never = phase.value;
    return exhaustive;
  }
  }
});
const canPause = computed(() => {
  switch (phase.value) {
  case 'recording': case 'paused': return true;
  case 'idle': case 'preparing': case 'finishing': return false;
  default: {
    const exhaustive: never = phase.value;
    return exhaustive;
  }
  }
});
const stopNotice = computed(() => {
  const reason = recognitionState.value.stopReason;
  switch (reason) {
  case 'backpressure': case 'buffer_limit': return lazyStrings.AudioTranscriptionWorkspace__input_stopped_backpressure();
  case 'text_limit': return lazyStrings.AudioTranscriptionWorkspace__input_stopped_text_limit();
  case undefined: return undefined;
  default: {
    const exhaustive: never = reason;
    return exhaustive;
  }
  }
});
let active = true;
let copyTimer: ReturnType<typeof setTimeout> | undefined;
let preloadAttempt: string | undefined;
const fileSize = computed(() => selectedFile.value === undefined ? '' : selectedFile.value.size < 1024 * 1024 ? `${Math.max(1, Math.round(selectedFile.value.size / 1024))} KB` : `${(selectedFile.value.size / (1024 * 1024)).toFixed(1)} MB`);

watch([() => props.source, modelAutoLoad, selectableModels, selectedModelId, phase], ([source, enabled, models, selected, currentPhase]) => {
  if (!enabled) {
    preloadAttempt = undefined;
    return;
  }
  const choice = models.find(model => model.id === selected && model.availability === 'local');
  const modelId = modelSelection.selectedModelId.value;
  const key = modelId === undefined ? undefined : `${source}:${modelId}`;
  if (currentPhase === 'idle' && choice !== undefined && key !== undefined && key !== preloadAttempt) {
    preloadAttempt = key;
    void workflow.preload();
  }
}, { immediate: true });

function toggleInput(): void {
  if (preloading.value) {
    void workflow.start();
    return;
  }
  switch (phase.value) {
  case 'idle': void workflow.start();
    break;
  case 'recording': case 'paused': void workflow.stop();
    break;
  case 'preparing': case 'finishing': void workflow.cancelPreparation();
    break;
  default: {
    const exhaustive: never = phase.value;
    throw new Error(String(exhaustive));
  }
  }
}

function transcribeFile(): void {
  if (fileRunning.value) {
    void workflow.cancelPreparation();
    return;
  }
  const file = selectedFile.value;
  if (file !== undefined) {
    void workflow.transcribeFile({ file });
  }
}

function updateMicrophoneSegmentLength({ event }: { event: Event }): void {
  if (!(event.target instanceof HTMLInputElement)) {
    return;
  }
  const input = event.target;
  const seconds = input.valueAsNumber;
  if (!input.validity.valid || !Number.isInteger(seconds)) {
    input.value = String(preferences.microphoneSegmentMaxSeconds.value);
    return;
  }
  void preferences.updateMicrophoneSegmentMaxSeconds({ seconds });
}

function toggleAutoCopy(): void {
  switch (autoCopy.value) {
  case 'enabled': void updateAutoCopy({ value: 'disabled' });
    break;
  case 'disabled':
    workflow.copyOnEnable();
    void updateAutoCopy({ value: 'enabled' });
    break;
  default: {
    const exhaustive: never = autoCopy.value;
    throw new Error(String(exhaustive));
  }
  }
}

function changeSource({ source }: { source: 'microphone' | 'file' }): void {
  emit('changeSource', source);
}

onScopeDispose(() => {
  active = false;
  clearTimeout(copyTimer);
});

function clearText(): void {
  workflow.clearText();
  notice.value = '';
  copied.value = false;
  clearTimeout(copyTimer);
}

function chooseFile({ file }: { file: File | undefined }): void {
  selectedFile.value = file;
  notice.value = '';
}

function dropFile({ event }: { event: DragEvent }): void {
  dragging.value = false;
  chooseFile({ file: event.dataTransfer?.files[0] });
}

function fileChanged({ event }: { event: Event }): void {
  if (event.target instanceof HTMLInputElement) {
    chooseFile({ file: event.target.files?.[0] });
    event.target.value = '';
  }
}

async function copyText({ clipboard }: { clipboard: Clipboard | undefined }): Promise<void> {
  const value = text.value;
  if (value === '') {
    return;
  }
  try {
    if (clipboard === undefined) {
      throw new Error('Clipboard is unavailable');
    }
    await clipboard.writeText(value);
    if (!active) {
      return;
    }
    copied.value = true;
    notice.value = '';
    workflow.recordClipboardWrite({ value });
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copied.value = false;
    }, 1800);
  } catch {
    const message = await ensureStrings.AudioTranscriptionWorkspace__could_not_copy_select_the_text();
    if (active) {
      notice.value = message;
    }
  }
}

function copyMainText(): Promise<void> {
  return copyText({ clipboard: navigator.clipboard });
}

async function openFloatingWindow(): Promise<void> {
  try {
    await floatingWindow.show();
  } catch {
    const message = await ensureStrings.AudioTranscriptionWorkspace__could_not_open_floating_window();
    if (active) {
      notice.value = message;
    }
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="audio-transcription-workspace" tw-class="h-full min-h-0 overflow-y-auto bg-gray-50/50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
    <main tw-class="mx-auto flex h-full w-full max-w-[1040px] flex-col px-5 pb-5 pt-5 sm:px-8 sm:pb-7 sm:pt-7">
      <header tw-class="mb-2.5 flex min-h-9 items-center justify-between gap-3 sm:mb-3">
        <h1 tw-class="min-w-0 text-base font-semibold leading-snug text-gray-800 sm:text-lg dark:text-gray-100">{{ lazyStrings.launcher__audio_transcription() }}</h1>
        <button v-if="source === 'microphone'" type="button" :disabled="!floatingWindow.supported || floatingWindow.opening.value" :title="floatingWindowLabel" :aria-label="floatingWindowLabel" data-testid="audio-transcription-open-floating" @click="openFloatingWindow" tw-class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800"><PictureInPicture2Icon aria-hidden="true" tw-class="h-4 w-4" /></button>
      </header>

      <div tw-class="mb-4 flex flex-wrap items-center justify-between gap-x-5 gap-y-2">
        <div role="group" :aria-label="lazyStrings.AudioTranscriptionWorkspace__audio_source()" tw-class="inline-flex items-center gap-0.5 rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800/70">
          <button type="button" :aria-pressed="source === 'microphone'" @click="changeSource({ source: 'microphone' })" :tw-class="['flex min-h-9 items-center gap-2 rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-blue-500', source === 'microphone' ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-white' : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200']"><MicIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.AudioTranscriptionWorkspace__microphone() }}</button>
          <button type="button" :aria-pressed="source === 'file'" @click="changeSource({ source: 'file' })" :tw-class="['flex min-h-9 items-center gap-2 rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-blue-500', source === 'file' ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-white' : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200']"><FileAudioIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.AudioTranscriptionWorkspace__file() }}</button>
        </div>
        <div tw-class="flex min-w-0 max-w-full items-start gap-2">
          <div tw-class="w-80 min-w-0">
            <AudioTranscriptionModelSelector :models="modelSelection" />
          </div>
          <details tw-class="relative shrink-0">
            <summary tw-class="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-xs text-gray-500 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-400 dark:hover:bg-gray-800 [&::-webkit-details-marker]:hidden"><SlidersHorizontalIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ languageTitle }}<ChevronDownIcon aria-hidden="true" tw-class="h-3 w-3" /></summary>
            <div tw-class="absolute right-0 top-full z-10 mt-2 w-72 max-w-[calc(100vw-3rem)] space-y-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-xl shadow-gray-900/5 dark:border-gray-700 dark:bg-gray-900">

              <label tw-class="block text-xs font-medium">{{ lazyStrings.AudioTranscriptionWorkspace__audio_language() }}<select v-model="language" tw-class="mt-2 block min-h-9 w-full rounded-lg border border-gray-200 bg-gray-50 px-2 text-xs dark:border-gray-700 dark:bg-gray-800"><option value="ja">{{ lazyStrings.AudioTranscriptionWorkspace__japanese() }}</option><option value="auto">{{ lazyStrings.AudioTranscriptionWorkspace__automatic_detection() }}</option><option value="en">{{ lazyStrings.AudioTranscriptionWorkspace__english() }}</option></select></label>
              <label tw-class="flex items-start gap-2 text-xs leading-5 text-gray-600 dark:text-gray-300">
                <input v-model="modelAutoLoad" type="checkbox" tw-class="mt-0.5 h-4 w-4 shrink-0 accent-blue-600" />
                {{ lazyStrings.AudioTranscriptionWorkspace__load_local_model_automatically() }}
              </label>
              <label v-if="source === 'microphone'" tw-class="flex items-center justify-between gap-2 text-xs leading-5 text-gray-600 dark:text-gray-300">
                <span>{{ lazyStrings.AudioTranscriptionWorkspace__microphone_segment_max_seconds() }}</span>
                <input type="number" data-testid="audio-transcription-segment-length" :value="preferences.microphoneSegmentMaxSeconds.value" :min="minimumMicrophoneSegmentSeconds" :max="maximumMicrophoneSegmentSeconds" step="1" @change="updateMicrophoneSegmentLength({ event: $event })" tw-class="w-16 shrink-0 rounded-md border border-gray-200 bg-white px-2 py-1 text-right text-sm tabular-nums dark:border-gray-700 dark:bg-gray-800" />
              </label>
            </div>
          </details>
        </div>
      </div>

      <section v-if="source === 'file'" tw-class="mb-5">
        <input ref="fileInput" type="file" accept="audio/*,video/*" :aria-label="lazyStrings.AudioTranscriptionWorkspace__choose_audio_or_video_file()" hidden @change="fileChanged({ event: $event })" />
        <div @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false" @drop.prevent="dropFile({ event: $event })" :tw-class="['flex min-h-32 flex-col items-start justify-center gap-2.5 rounded-xl border bg-white px-5 py-4 transition-colors dark:bg-gray-900', dragging ? 'border-blue-400 bg-blue-50/40 dark:bg-blue-500/5' : 'border-dashed border-gray-300 dark:border-gray-700']">
          <template v-if="!selectedFile">
            <p tw-class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300"><FileUpIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-gray-400" />{{ lazyStrings.AudioTranscriptionWorkspace__drop_audio_or_video_file() }}</p>
            <button type="button" @click="fileInput?.click()" data-testid="audio-transcription-choose-file" tw-class="inline-flex min-h-8 items-center justify-center rounded-md border border-gray-200 px-3 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">{{ lazyStrings.AudioTranscriptionWorkspace__choose_file() }}</button>
          </template>
          <template v-else><div tw-class="flex max-w-full items-center gap-3"><span tw-class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-50 dark:bg-blue-500/10"><FileAudioIcon aria-hidden="true" tw-class="h-5 w-5 text-blue-500" /></span><div tw-class="min-w-0 text-left"><p tw-class="truncate text-sm font-medium">{{ selectedFile.name }}</p><p tw-class="mt-1 text-[11px] text-gray-400">{{ fileSize }}<span v-if="selectedFile.type.startsWith('video/')"> · {{ lazyStrings.AudioTranscriptionWorkspace__use_audio_from_video() }}</span></p></div><button type="button" @click="chooseFile({ file: undefined })" data-testid="audio-transcription-remove-file" :aria-label="lazyStrings.AudioTranscriptionWorkspace__remove_file()" tw-class="ml-2 rounded-lg p-2 text-gray-400 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-gray-800"><XIcon aria-hidden="true" tw-class="h-4 w-4" /></button></div></template>
        </div>
        <div v-if="selectedFile || fileRunning" tw-class="mt-3 flex items-center justify-end gap-4"><button type="button" @click="fileInput?.click()" tw-class="rounded px-1 py-2 text-xs text-gray-500 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-400 dark:hover:text-gray-200">{{ lazyStrings.AudioTranscriptionWorkspace__change_file() }}</button><button type="button" @click="transcribeFile" data-testid="audio-transcription-file-run" tw-class="min-w-28 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500">{{ fileRunning ? lazyStrings.AudioTranscriptionWorkspace__cancel() : lazyStrings.AudioTranscriptionWorkspace__transcribe() }}</button></div>
      </section>

      <p v-if="failureDetails" role="alert" tw-class="mb-4 whitespace-pre-wrap break-words rounded-xl border border-red-200 bg-red-50/40 px-4 py-3 text-xs leading-6 text-red-600 dark:border-red-500/30 dark:bg-red-500/5 dark:text-red-400">{{ failureDetails }}</p>
      <p v-if="stopNotice" role="status" tw-class="mb-3 text-xs leading-6 text-gray-500 dark:text-gray-400">{{ stopNotice }}</p>
      <section :aria-label="lazyStrings.AudioTranscriptionWorkspace__transcribed_text()" tw-class="flex min-h-[340px] flex-1 flex-col rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <div tw-class="relative flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 border-b border-gray-100 px-4 py-1.5 dark:border-gray-800 sm:px-5">
          <h2 tw-class="text-sm font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.AudioTranscriptionWorkspace__text() }}</h2>
          <div tw-class="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-0.5">
            <div v-if="source === 'microphone'" tw-class="flex items-center gap-1">
              <button type="button" role="switch" :aria-checked="autoCopy === 'enabled'" :disabled="savingAutoCopy" :aria-label="lazyStrings.AudioTranscriptionWorkspace__automatic_copy()" @click="toggleAutoCopy" tw-class="flex min-h-11 items-center gap-2.5 rounded-lg px-1 text-xs text-gray-600 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-wait dark:text-gray-300">
                <span>{{ lazyStrings.AudioTranscriptionWorkspace__automatic_copy() }}</span><span aria-hidden="true" :tw-class="['flex h-4 w-7 items-center rounded-full p-0.5 transition-colors', autoCopy === 'enabled' ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-700']"><span :tw-class="['h-3 w-3 rounded-full bg-white transition-transform motion-reduce:transition-none', autoCopy === 'enabled' ? 'translate-x-3' : 'translate-x-0']" /></span>
              </button>
              <details>
                <summary :aria-label="lazyStrings.AudioTranscriptionWorkspace__about_automatic_copy()" :tw-class="['flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-md hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-gray-800 [&::-webkit-details-marker]:hidden', clipboardError ? 'text-amber-700 dark:text-amber-300' : 'text-gray-400']"><InfoIcon aria-hidden="true" tw-class="h-3.5 w-3.5" /></summary>
                <p tw-class="absolute right-3 top-full z-20 mt-2 w-72 max-w-[calc(100%-1.5rem)] rounded-lg border border-gray-200 bg-white p-3 text-xs leading-6 text-gray-600 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">{{ lazyStrings.AudioTranscriptionWorkspace__automatically_copy_recognized_text() }}</p>
              </details>
            </div>
            <button type="button" data-testid="audio-transcription-copy" :disabled="!text" @click="copyMainText" tw-class="flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-800">
              <CheckIcon v-if="copied" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />
              <CopyIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />
              <span tw-class="inline-grid whitespace-nowrap">
                <span :aria-hidden="copied" :tw-class="['col-start-1 row-start-1', { invisible: copied }]">{{ lazyStrings.AudioTranscriptionWorkspace__copy() }}</span>
                <span :aria-hidden="!copied" :tw-class="['col-start-1 row-start-1', { invisible: !copied }]">{{ lazyStrings.AudioTranscriptionWorkspace__copied() }}</span>
              </span>
            </button>
          </div>
        </div>
        <AudioTranscriptionEditor v-model="text" :provisional-text="provisionalText" :confirmed-revision="recognitionState.confirmedRevision" :clear-disabled="!hasTranscript || (source === 'file' && fileRunning)" surface="workspace" @clear="clearText">
          <template #status>
            <AudioTranscriptionClipboardNotice v-if="clipboardNotice" :message="clipboardNotice" data-testid="audio-transcription-copy-status" />
            <span v-else data-testid="audio-transcription-full-copy-status">{{ transcriptCopyStatus }}</span>
          </template>
          <template #preparation><AudioTranscriptionPreparation v-if="showModelPreparation" :download-progress="modelSelection.progress.value" :model-loading="runtimeState.phase === 'loading_model'" :load-progress="runtimeState.loadProgress" /></template>
        </AudioTranscriptionEditor>
      </section>

      <div v-if="source === 'microphone'" tw-class="sticky bottom-0 flex items-center justify-end gap-2 bg-gray-50/95 pb-2 pt-4 backdrop-blur-sm dark:bg-gray-950/95">
        <button type="button" :disabled="!canPause" :aria-hidden="!canPause ? true : undefined" :tabindex="!canPause ? -1 : undefined" @click="workflow.pauseOrResume()" :aria-label="phase === 'paused' ? lazyStrings.AudioTranscriptionWorkspace__resume_voice_input() : lazyStrings.AudioTranscriptionWorkspace__pause_voice_input()" :title="phase === 'paused' ? lazyStrings.AudioTranscriptionWorkspace__resume_voice_input() : lazyStrings.AudioTranscriptionWorkspace__pause_voice_input()" data-testid="audio-transcription-input-pause" :tw-class="['flex h-10 items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300', { invisible: !canPause }]"><PlayIcon v-if="phase === 'paused'" aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><PauseIcon v-else aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><span tw-class="hidden sm:inline">{{ phase === 'paused' ? lazyStrings.AudioTranscriptionWorkspace__resume() : lazyStrings.AudioTranscriptionWorkspace__pause() }}</span></button>
        <button type="button" @click="toggleInput" data-testid="audio-transcription-input-toggle" :aria-description="phase === 'recording' ? lazyStrings.AudioTranscriptionWorkspace__microphone_input_active() : undefined" :tw-class="['flex h-10 w-44 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium text-white transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500', phase === 'idle' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-gray-900 hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200']">
          <AudioTranscriptionMicrophoneActivity v-if="phase === 'recording'" :level="recognitionState.microphoneLevel" />
          <Loader2Icon v-else-if="pending" aria-hidden="true" tw-class="h-4 w-4 shrink-0 animate-spin" />
          <MicIcon v-else-if="phase === 'idle'" aria-hidden="true" tw-class="h-4 w-4 shrink-0" />
          <SquareIcon v-else aria-hidden="true" tw-class="h-4 w-4 shrink-0 fill-current" />
          {{ inputActionLabel }}
        </button>
      </div>
      <p role="status" tw-class="mt-3 min-h-5 text-center text-[11px] leading-5 text-gray-400">{{ notice || (phase === 'finishing' ? lazyStrings.AudioTranscriptionWorkspace__finishing_input() : undefined) }}</p>
    </main>
    <Teleport v-if="floatingDocument" :to="floatingDocument.body">
      <main data-testid="audio-transcription-floating" @click="workflow.retryClipboardAfterInteraction()" @keyup="workflow.retryClipboardAfterInteraction()" tw-class="flex h-dvh min-h-0 flex-col bg-gray-50 px-4 py-3 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
        <header tw-class="mb-2 flex items-center justify-between gap-2">
          <div tw-class="flex min-w-0 items-center gap-2">
            <span tw-class="flex shrink-0 items-center gap-1.5 text-sm font-semibold"><img :src="logoUrl" alt="" width="18" height="18" />Naidan</span>
            <span tw-class="min-w-0 truncate border-l border-gray-200 pl-2 text-xs font-medium text-gray-500 dark:border-gray-700 dark:text-gray-400">{{ lazyStrings.launcher__audio_transcription() }}</span>
          </div>
          <div tw-class="flex min-w-0 items-center gap-1">
            <span v-if="floatingModelLabel" :title="floatingModelLabel" tw-class="truncate text-xs text-gray-500 dark:text-gray-400">{{ floatingModelLabel }}</span>
            <button type="button" :disabled="!text" @click="copyText({ clipboard: floatingDocument.defaultView?.navigator.clipboard })" tw-class="flex min-h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-800">
              <CopyIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.AudioTranscriptionWorkspace__copy() }}
            </button>
          </div>
        </header>
        <AudioTranscriptionEditor v-model="text" :provisional-text="provisionalText" :confirmed-revision="recognitionState.confirmedRevision" :clear-disabled="!hasTranscript" surface="floating" @clear="clearText">
          <template #status>
            <span v-if="failureDetails || stopNotice || notice" role="status" :title="failureDetails || stopNotice || notice">{{ failureDetails || stopNotice || notice }}</span>
            <AudioTranscriptionClipboardNotice v-else-if="clipboardNotice" :message="clipboardNotice" />
            <span v-else>{{ transcriptCopyStatus }}</span>
          </template>
          <template #preparation><AudioTranscriptionPreparation v-if="showModelPreparation" :download-progress="modelSelection.progress.value" :model-loading="runtimeState.phase === 'loading_model'" :load-progress="runtimeState.loadProgress" /></template>
        </AudioTranscriptionEditor>
        <footer tw-class="mt-2 flex items-center justify-end gap-1.5">
          <button v-if="canPause" type="button" @click="workflow.pauseOrResume()" tw-class="min-h-8 rounded-md px-2 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800">{{ phase === 'paused' ? lazyStrings.AudioTranscriptionWorkspace__resume() : lazyStrings.AudioTranscriptionWorkspace__pause() }}</button>
          <button type="button" @click="toggleInput" data-testid="audio-transcription-floating-input-toggle" :aria-description="phase === 'recording' ? lazyStrings.AudioTranscriptionWorkspace__microphone_input_active() : undefined" :tw-class="['flex min-h-8 w-32 items-center justify-center gap-1 rounded-md px-2 text-xs font-medium text-white', phase === 'idle' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-gray-900 hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200']">
            <AudioTranscriptionMicrophoneActivity v-if="phase === 'recording'" :level="recognitionState.microphoneLevel" />
            <SquareIcon v-else-if="phase === 'paused'" aria-hidden="true" tw-class="h-4 w-4 shrink-0 fill-current" />
            {{ inputActionLabel }}
          </button>
        </footer>
      </main>
    </Teleport>
  </div>
</template>
