<script setup lang="ts">
import { computed, onScopeDispose, ref } from 'vue';
import { CheckIcon, ChevronDownIcon, CopyIcon, FileAudioIcon, FileUpIcon, InfoIcon, DownloadIcon, Loader2Icon, MicIcon, PauseIcon, PlayIcon, SlidersHorizontalIcon, SquareIcon, XIcon } from 'lucide-vue-next';
import { useAudioTranscriptionPreferences } from '@/features/audio-transcription/composables/useAudioTranscriptionPreferences';
import { ensureStrings, lazyStrings } from '@/strings';
import ModelSelectorV2 from '@/components/ModelSelectorV2.vue';
import AudioTranscriptionModelSources from '@/features/audio-transcription/components/AudioTranscriptionModelSources.vue';
import AudioTranscriptionModelDetails from '@/features/audio-transcription/components/AudioTranscriptionModelDetails.vue';
import LlamaCppBrowserDownloadDestination from '@/features/llama-cpp-browser/components/LlamaCppBrowserDownloadDestination.vue';
import { useAudioTranscriptionModels } from '@/features/audio-transcription/composables/useAudioTranscriptionModels';
import { useAudioTranscriptionWorkflow } from '@/features/audio-transcription/composables/useAudioTranscriptionWorkflow';
import LiveModelLoadProgress from '@/features/live-conversation/components/LiveModelLoadProgress.vue';
import LlamaCppBrowserDownloadProgress from '@/features/llama-cpp-browser/components/LlamaCppBrowserDownloadProgress.vue';

const props = defineProps<{ source: 'microphone' | 'file' }>();
const emit = defineEmits<{ changeSource: [source: 'microphone' | 'file'] }>();
const { autoCopy, saving: savingAutoCopy, updateAutoCopy } = useAudioTranscriptionPreferences();
const text = ref('');
const copied = ref(false);
const notice = ref('');
const fileInput = ref<HTMLInputElement>();
const selectedFile = ref<File>();
const dragging = ref(false);
// Single-language recognizers do not accept an explicit language override.
// Start with the model's automatic/default behavior so every catalog model can run.
const language = ref<'ja' | 'auto' | 'en'>('auto');
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
const modelSelection = useAudioTranscriptionModels();
const modelFilter = ref('');
const modelPanels = [{ id: 'huggingface', label: 'Hugging Face' }] as const;
const { models: selectableModels, selectedId: selectedModelId, refreshing: refreshingModels } = modelSelection;
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
const workflow = useAudioTranscriptionWorkflow({ source: computed(() => props.source), text, autoCopy, models: modelSelection, language: recognitionLanguage });
const { phase, pending, runtimeState, provisionalText, failureDetails, clipboardError, state: recognitionState } = workflow;
const inputActionLabel = computed(() => {
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
const fileSize = computed(() => selectedFile.value === undefined ? '' : selectedFile.value.size < 1024 * 1024 ? `${Math.max(1, Math.round(selectedFile.value.size / 1024))} KB` : `${(selectedFile.value.size / (1024 * 1024)).toFixed(1)} MB`);

function toggleInput(): void {
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
  if (pending.value) {
    void workflow.cancelPreparation();
    return;
  }
  const file = selectedFile.value;
  if (file !== undefined) {
    void workflow.transcribeFile({ file });
  }
}

function backgroundDownloadActive({ id }: { id: string }): boolean {
  const status = modelSelection.downloadStates.value.get(id)?.status;
  switch (status) {
  case 'queued': case 'resolving': case 'downloading': case 'pausing': return true;
  case 'paused': case 'complete': case 'failed': case 'cancelled': case undefined: return false;
  default: {
    const exhaustive: never = status;
    return exhaustive;
  }
  }
}

function toggleAutoCopy(): void {
  switch (autoCopy.value) {
  case 'enabled': void updateAutoCopy({ value: 'disabled' });
    break;
  case 'disabled': void updateAutoCopy({ value: 'enabled' });
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

async function copyText(): Promise<void> {
  if (text.value === '') {
    return;
  }
  try {
    await navigator.clipboard.writeText(text.value);
    if (!active) {
      return;
    }
    copied.value = true;
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

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="audio-transcription-workspace" tw-class="h-full min-h-0 overflow-y-auto bg-[#fcfcfd] text-gray-900 dark:bg-gray-950 dark:text-gray-100">
    <main tw-class="mx-auto flex min-h-full w-full max-w-[1080px] flex-col px-5 pb-6 pt-7 sm:px-9 sm:pb-8 sm:pt-10">
      <header tw-class="mb-7 flex flex-wrap items-start justify-between gap-4">
        <h1 tw-class="text-xl font-semibold tracking-tight sm:text-2xl">{{ lazyStrings.launcher__audio_transcription() }}</h1>
      </header>

      <div tw-class="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div role="group" :aria-label="lazyStrings.AudioTranscriptionWorkspace__audio_source()" tw-class="inline-flex items-center gap-1 rounded-xl bg-gray-100/80 p-1 dark:bg-gray-800/70">
          <button type="button" :aria-pressed="source === 'microphone'" @click="changeSource({ source: 'microphone' })" :tw-class="['flex min-h-9 items-center gap-2 rounded-lg px-3.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-blue-500', source === 'microphone' ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-white' : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200']"><MicIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.AudioTranscriptionWorkspace__microphone() }}</button>
          <button type="button" :aria-pressed="source === 'file'" @click="changeSource({ source: 'file' })" :tw-class="['flex min-h-9 items-center gap-2 rounded-lg px-3.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-blue-500', source === 'file' ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-white' : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200']"><FileAudioIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.AudioTranscriptionWorkspace__file() }}</button>
        </div>
        <div tw-class="flex max-w-full flex-wrap items-start gap-2">
          <div tw-class="w-64 max-w-full">
            <ModelSelectorV2 v-model:query="modelFilter" :panels="modelPanels" :model-value="selectedModelId" :models="selectableModels" :loading="refreshingModels" surface="composer" data-testid="audio-transcription-model-selector" @update:model-value="modelSelection.select({ id: $event })" @refresh="modelSelection.refresh()">
              <template #toolbar><div tw-class="grid grid-cols-1"><LlamaCppBrowserDownloadDestination :view="modelSelection.downloadDestination.view" :disabled="false" layout="field" /></div></template>
              <template #panel="{ active, close }"><AudioTranscriptionModelSources :models="modelSelection" :disabled="false" mode="huggingface" :active="active" v-model:query="modelFilter" @selected="close" /></template>
              <template #sources="{ close }"><AudioTranscriptionModelSources :models="modelSelection" :disabled="false" mode="files" :active="true" v-model:query="modelFilter" @selected="close" /></template>
              <template #model-action="{ id, model }"><button v-if="model?.availability === 'download_required'" type="button" :disabled="backgroundDownloadActive({ id })" :aria-label="lazyStrings.ModelSelector__download_from_hugging_face()" :title="lazyStrings.ModelSelector__download_from_hugging_face()" @click="modelSelection.backgroundDownload({ id })" tw-class="grid h-8 w-8 place-items-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-blue-600 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-wait dark:hover:bg-gray-700 dark:hover:text-blue-400"><Loader2Icon v-if="backgroundDownloadActive({ id })" aria-hidden="true" tw-class="h-3.5 w-3.5 animate-spin" /><DownloadIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5" /></button></template>
              <template #selection-details><AudioTranscriptionModelDetails :models="modelSelection" /></template>
            </ModelSelectorV2>
          </div>
          <details tw-class="relative">
            <summary tw-class="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-xs text-gray-500 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-400 dark:hover:bg-gray-800 [&::-webkit-details-marker]:hidden"><SlidersHorizontalIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ languageTitle }}<ChevronDownIcon aria-hidden="true" tw-class="h-3 w-3" /></summary>
            <div tw-class="absolute right-0 top-full z-10 mt-2 w-72 max-w-[calc(100vw-3rem)] space-y-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-xl shadow-gray-900/5 dark:border-gray-700 dark:bg-gray-900">

              <label tw-class="block text-xs font-medium">{{ lazyStrings.AudioTranscriptionWorkspace__audio_language() }}<select v-model="language" tw-class="mt-2 block min-h-9 w-full rounded-lg border border-gray-200 bg-gray-50 px-2 text-xs dark:border-gray-700 dark:bg-gray-800"><option value="ja">{{ lazyStrings.AudioTranscriptionWorkspace__japanese() }}</option><option value="auto">{{ lazyStrings.AudioTranscriptionWorkspace__automatic_detection() }}</option><option value="en">{{ lazyStrings.AudioTranscriptionWorkspace__english() }}</option></select></label>
            </div>
          </details>
        </div>
      </div>

      <div v-if="phase === 'preparing' || runtimeState.phase === 'loading_model'" tw-class="mb-4 space-y-2">
        <LlamaCppBrowserDownloadProgress v-if="modelSelection.progress.value" :progress="modelSelection.progress.value" appearance="welcome" activity="active" />
        <LiveModelLoadProgress v-else-if="runtimeState.phase === 'loading_model'" :progress="runtimeState.loadProgress" />
        <p v-else role="status" tw-class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400"><Loader2Icon aria-hidden="true" tw-class="h-3.5 w-3.5 animate-spin" />{{ lazyStrings.AudioTranscriptionWorkspace__preparing_model() }}</p>
      </div>

      <section v-if="source === 'file'" tw-class="mb-5">
        <input ref="fileInput" type="file" accept="audio/*,video/*" :aria-label="lazyStrings.AudioTranscriptionWorkspace__choose_audio_or_video_file()" hidden @change="fileChanged({ event: $event })" />
        <div @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false" @drop.prevent="dropFile({ event: $event })" :tw-class="['flex min-h-40 flex-col items-center justify-center gap-3 rounded-2xl border bg-white px-5 py-6 text-center transition-colors dark:bg-gray-900', dragging ? 'border-blue-400 bg-blue-50/40 dark:bg-blue-500/5' : 'border-gray-200 dark:border-gray-800']">
          <template v-if="!selectedFile">
            <FileUpIcon aria-hidden="true" tw-class="h-6 w-6 text-gray-400" />
            <p tw-class="text-sm font-medium">{{ lazyStrings.AudioTranscriptionWorkspace__drop_audio_or_video_file() }}</p>
            <div tw-class="flex items-center gap-3"><span tw-class="text-xs text-gray-400">{{ lazyStrings.AudioTranscriptionWorkspace__or() }}</span><button type="button" @click="fileInput?.click()" data-testid="audio-transcription-choose-file" tw-class="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-gray-200/70 bg-gray-50/60 px-3 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-gray-700/70 dark:bg-gray-800/40 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"><FileAudioIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.AudioTranscriptionWorkspace__choose_file() }}</button></div>
          </template>
          <template v-else><div tw-class="flex max-w-full items-center gap-3"><span tw-class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-50 dark:bg-blue-500/10"><FileAudioIcon aria-hidden="true" tw-class="h-5 w-5 text-blue-500" /></span><div tw-class="min-w-0 text-left"><p tw-class="truncate text-sm font-medium">{{ selectedFile.name }}</p><p tw-class="mt-1 text-[11px] text-gray-400">{{ fileSize }}<span v-if="selectedFile.type.startsWith('video/')"> · {{ lazyStrings.AudioTranscriptionWorkspace__use_audio_from_video() }}</span></p></div><button type="button" @click="chooseFile({ file: undefined })" data-testid="audio-transcription-remove-file" :aria-label="lazyStrings.AudioTranscriptionWorkspace__remove_file()" tw-class="ml-2 rounded-lg p-2 text-gray-400 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-gray-800"><XIcon aria-hidden="true" tw-class="h-4 w-4" /></button></div></template>
        </div>
        <div v-if="selectedFile || pending" tw-class="mt-3 flex items-center justify-center gap-4"><button type="button" @click="transcribeFile" data-testid="audio-transcription-file-run" tw-class="min-w-28 rounded-xl bg-blue-600 px-5 py-2.5 text-xs font-medium text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500">{{ pending ? lazyStrings.AudioTranscriptionWorkspace__cancel() : lazyStrings.AudioTranscriptionWorkspace__transcribe() }}</button><button type="button" @click="fileInput?.click()" tw-class="rounded px-1 py-2 text-xs text-gray-500 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-400 dark:hover:text-gray-200">{{ lazyStrings.AudioTranscriptionWorkspace__change_file() }}</button></div>
      </section>

      <p v-if="failureDetails" role="alert" tw-class="mb-4 whitespace-pre-wrap break-words rounded-xl border border-red-200 bg-red-50/40 px-4 py-3 text-xs leading-6 text-red-600 dark:border-red-500/30 dark:bg-red-500/5 dark:text-red-400">{{ failureDetails }}</p>
      <p v-if="stopNotice" role="status" tw-class="mb-3 text-xs leading-6 text-gray-500 dark:text-gray-400">{{ stopNotice }}</p>
      <p v-if="clipboardError" role="status" tw-class="mb-3 text-xs leading-6 text-amber-700 dark:text-amber-300">{{ lazyStrings.AudioTranscriptionWorkspace__could_not_auto_copy() }}</p>

      <section :aria-label="lazyStrings.AudioTranscriptionWorkspace__transcribed_text()" tw-class="flex min-h-[380px] flex-1 flex-col overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-sm shadow-gray-900/[0.02] dark:border-gray-800 dark:bg-gray-900">
        <div tw-class="relative flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-3 dark:border-gray-800">
          <h2 tw-class="text-xs font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.AudioTranscriptionWorkspace__text() }}</h2>
          <div tw-class="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
            <div v-if="source === 'microphone'" tw-class="flex items-center gap-1">
              <button type="button" role="switch" :aria-checked="autoCopy === 'enabled'" :disabled="savingAutoCopy" :aria-label="lazyStrings.AudioTranscriptionWorkspace__automatic_copy()" @click="toggleAutoCopy" tw-class="flex min-h-11 items-center gap-2.5 rounded-lg px-1 text-xs text-gray-600 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-wait dark:text-gray-300">
                <span>{{ lazyStrings.AudioTranscriptionWorkspace__automatic_copy() }}</span><span aria-hidden="true" :tw-class="['flex h-5 w-8 items-center rounded-full p-1 transition-colors', autoCopy === 'enabled' ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-700']"><span :tw-class="['h-3 w-3 rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none', autoCopy === 'enabled' ? 'translate-x-3' : 'translate-x-0']" /></span>
              </button>
              <details>
                <summary :aria-label="lazyStrings.AudioTranscriptionWorkspace__about_automatic_copy()" tw-class="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-gray-800 [&::-webkit-details-marker]:hidden"><InfoIcon aria-hidden="true" tw-class="h-3.5 w-3.5" /></summary>
                <p tw-class="absolute right-3 top-full z-10 mt-2 w-72 max-w-[calc(100%-1.5rem)] rounded-xl border border-gray-200 bg-white p-3 text-xs leading-6 text-gray-600 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">{{ lazyStrings.AudioTranscriptionWorkspace__automatically_copy_recognized_text() }}</p>
              </details>
            </div>
            <button type="button" data-testid="audio-transcription-copy" :disabled="!text" @click="copyText" tw-class="flex min-h-8 items-center gap-1.5 rounded-lg border border-gray-200/70 px-2.5 text-xs font-medium text-gray-600 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-35 dark:border-gray-700 dark:text-gray-300 dark:hover:border-blue-500/30 dark:hover:bg-blue-500/10 dark:hover:text-blue-400"><CheckIcon v-if="copied" aria-hidden="true" tw-class="h-3.5 w-3.5 text-green-500" /><CopyIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ copied ? lazyStrings.AudioTranscriptionWorkspace__copied() : lazyStrings.AudioTranscriptionWorkspace__copy() }}</button>
          </div>
        </div>
        <textarea v-model="text" data-testid="audio-transcription-editor" :aria-label="lazyStrings.AudioTranscriptionWorkspace__edit_transcribed_text()" :placeholder="lazyStrings.AudioTranscriptionWorkspace__transcription_result()" spellcheck="false" tw-class="min-h-64 w-full flex-1 resize-none bg-transparent px-6 py-5 text-[15px] leading-8 text-gray-800 outline-none placeholder:text-gray-300 sm:px-8 sm:py-7 sm:text-base sm:leading-9 dark:text-gray-100 dark:placeholder:text-gray-600" />
        <div v-if="provisionalText" :aria-label="lazyStrings.AudioTranscriptionWorkspace__partial_transcription()" data-testid="audio-transcription-provisional" tw-class="border-t border-gray-100 bg-gray-50/50 px-6 py-3 text-sm leading-7 text-gray-400 dark:border-gray-800 dark:bg-gray-800/20 dark:text-gray-500">{{ provisionalText }}</div>
        <footer tw-class="border-t border-gray-100 px-5 py-3 text-[11px] text-gray-400 dark:border-gray-800">{{ lazyStrings.AudioTranscriptionWorkspace__characters({ count: text.length }) }}</footer>
      </section>

      <div v-if="source === 'microphone'" tw-class="sticky bottom-0 mt-3 bg-[#fcfcfd]/95 pb-2 pt-4 backdrop-blur-sm dark:bg-gray-950/95">
        <div tw-class="flex min-h-14 items-center justify-center">
          <!-- Equal side columns keep the primary action centered even when the pause control appears. -->
          <div tw-class="grid w-full max-w-96 grid-cols-[minmax(0,1fr)_11rem_minmax(0,1fr)] items-center gap-2">
            <button type="button" @click="toggleInput" data-testid="audio-transcription-input-toggle" :tw-class="['col-start-2 flex h-12 items-center justify-center gap-2 rounded-2xl px-3 text-sm font-semibold text-white shadow-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500', phase === 'idle' ? 'bg-blue-600 shadow-blue-500/15 hover:bg-blue-700' : 'bg-gray-900 hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900']"><Loader2Icon v-if="pending" aria-hidden="true" tw-class="h-4 w-4 shrink-0 animate-spin" /><MicIcon v-else-if="phase === 'idle'" aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><SquareIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 fill-current" />{{ inputActionLabel }}</button>
            <button type="button" :disabled="!canPause" :aria-hidden="!canPause ? true : undefined" :tabindex="!canPause ? -1 : undefined" @click="workflow.pauseOrResume()" :aria-label="phase === 'paused' ? lazyStrings.AudioTranscriptionWorkspace__resume_voice_input() : lazyStrings.AudioTranscriptionWorkspace__pause_voice_input()" :title="phase === 'paused' ? lazyStrings.AudioTranscriptionWorkspace__resume_voice_input() : lazyStrings.AudioTranscriptionWorkspace__pause_voice_input()" data-testid="audio-transcription-input-pause" :tw-class="['col-start-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-2 text-xs font-medium text-gray-500 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-gray-700 dark:bg-gray-900', { invisible: !canPause }]"><PlayIcon v-if="phase === 'paused'" aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><PauseIcon v-else aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><span tw-class="hidden md:inline">{{ phase === 'paused' ? lazyStrings.AudioTranscriptionWorkspace__resume() : lazyStrings.AudioTranscriptionWorkspace__pause() }}</span></button>
          </div>
        </div>
      </div>
      <p role="status" tw-class="mt-3 min-h-5 text-center text-[11px] leading-5 text-gray-400">{{ notice || (phase === 'finishing' ? lazyStrings.AudioTranscriptionWorkspace__finishing_input() : undefined) }}</p>
    </main>
  </div>
</template>
