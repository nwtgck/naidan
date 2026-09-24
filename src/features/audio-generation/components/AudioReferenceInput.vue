<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { MicIcon, UploadIcon, Loader2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { useAudioReferences } from '@/features/audio-generation/composables/useAudioReferences';
import { useReferenceRecording } from '@/features/audio-generation/composables/useReferenceRecording';
import { normalizeReferenceAudio, prepareReferenceAudio, ReferenceAudioError, type ReferenceAudioErrorCode } from '@/features/audio-generation/reference-audio';
import { referenceAudioErrorMessage } from '@/features/audio-generation/reference-messages';
import AudioReferenceClip from './AudioReferenceClip.vue';

const props = defineProps<{ disabled: boolean, invalid: boolean }>();
const emit = defineEmits<{ busy: [busy: boolean], changed: [] }>();
const id = useId(); const fileInput = ref<HTMLInputElement>(); const dragDepth = ref(0);
const { entries, selected, sources, totalBytes, add, select, deselectAll, remove, clear } = useAudioReferences();
const issues = ref<{ name: string, code: ReferenceAudioErrorCode }[]>([]);
const preparationFailure = ref<ReferenceAudioErrorCode>();
const recordingTrimmed = ref(false);
const recording = useReferenceRecording({ accept: async ({ blob, signal }) => {
  const { wav, trimmed } = await normalizeReferenceAudio({ source: blob, signal, durationPolicy: 'limit-recording' }); signal.throwIfAborted();
  add({ file: new File([wav], `recording-${Date.now()}.wav`, { type: 'audio/wav' }) });
  preparationFailure.value = undefined; recordingTrimmed.value = trimmed; emit('changed');
} });
const { status: recordingStatus, elapsed, supported: recordingSupported, error: recordingError } = recording;
const locked = computed(() => props.disabled || recordingStatus.value !== 'idle');
watch(recordingStatus, status => emit('busy', status !== 'idle'), { immediate: true, flush: 'sync' });
function reportChange(): void {
  preparationFailure.value = undefined; emit('changed');
}
function addFiles({ files }: { files: readonly File[] }): void {
  if (locked.value) return;
  issues.value = [];
  for (const file of files) {
    try {
      add({ file }); reportChange();
    } catch (error) {
      issues.value.push({ name: file.name, code: error instanceof ReferenceAudioError ? error.code : 'decode' });
    }
  }
}
function choose({ event }: { event: Event }): void {
  if (!(event.target instanceof HTMLInputElement)) return;
  addFiles({ files: Array.from(event.target.files ?? []) }); event.target.value = '';
}
function drop({ event }: { event: DragEvent }): void {
  dragDepth.value = 0;
  addFiles({ files: Array.from(event.dataTransfer?.files ?? []) });
}
function toggle({ id, checked }: { id: number, checked: boolean }): void {
  if (locked.value) return; select({ id, checked }); reportChange();
}
function deselect(): void {
  if (locked.value) return; deselectAll(); reportChange();
}
function deleteReference({ id }: { id: number }): void {
  if (locked.value) return; remove({ id }); reportChange();
}
function deleteAll(): void {
  if (locked.value) return; clear(); reportChange();
}
async function prepare({ signal }: { signal: AbortSignal }): Promise<Blob | undefined> {
  preparationFailure.value = undefined;
  // Capture selection before awaiting browser decode. Files are immutable and no
  // reference data is added to the generated-audio settings/history snapshot.
  const selectedSources = [...sources.value];
  try {
    return await prepareReferenceAudio({ sources: selectedSources, signal });
  } catch (error) {
    if (!signal.aborted) preparationFailure.value = error instanceof ReferenceAudioError ? error.code : 'decode';
    throw error;
  }
}
defineExpose({ prepare, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="space-y-3" data-testid="audio-reference-library" data-audio-field="reference" :aria-invalid="invalid || undefined" :aria-labelledby="`${id}-label`">
    <h2 :id="`${id}-label`" tw-class="text-sm font-medium">{{ lazyStrings.audioGeneration__reference_voice() }}</h2>
    <div @dragover.prevent.stop @dragenter.prevent.stop="dragDepth++" @dragleave.prevent.stop="dragDepth = Math.max(0, dragDepth - 1)" @drop.prevent.stop="drop({ event: $event })" data-testid="audio-reference-drop" :tw-class="['flex flex-wrap items-center gap-2 rounded-xl border border-dashed px-3 py-2.5', !locked && dragDepth > 0 ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : 'border-gray-300 dark:border-gray-600', { 'opacity-60': locked }]">
      <div tw-class="flex min-w-0 grow basis-48 items-center gap-2">
        <UploadIcon tw-class="h-4 w-4 shrink-0 text-purple-500" />
        <p tw-class="min-w-0 flex-1 text-xs">{{ lazyStrings.audioGeneration__drop_reference_audio() }}</p>
      </div>
      <label :for="`${id}-files`" tw-class="sr-only">{{ lazyStrings.audioGeneration__add_reference_files() }}</label>
      <input :id="`${id}-files`" ref="fileInput" type="file" accept="audio/*,.wav,.mp3,.flac,.webm,.ogg,.m4a,.mp4" multiple :disabled="locked" :aria-invalid="invalid || undefined" data-testid="audio-reference" tw-class="sr-only" @change="choose({ event: $event })" />
      <button type="button" :disabled="locked" @click="fileInput?.click()" data-testid="audio-reference-browse" tw-class="shrink-0 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm disabled:opacity-50">{{ lazyStrings.audioGeneration__add_reference_files() }}</button>
    </div>
    <div tw-class="flex flex-wrap items-center gap-2">
      <button type="button" :disabled="locked || !recordingSupported" @click="recordingTrimmed = false; recording.start()" data-testid="audio-reference-record" tw-class="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm disabled:opacity-50"><MicIcon tw-class="h-4 w-4" />{{ lazyStrings.audioGeneration__record_reference() }}</button>
      <button v-if="recordingStatus === 'recording'" type="button" @click="recording.stop" data-testid="audio-reference-record-stop" tw-class="rounded-lg bg-purple-600 px-3 py-2 text-sm text-white">{{ lazyStrings.audioGeneration__stop_and_use_recording() }}</button>
      <button v-if="recordingStatus !== 'idle'" type="button" @click="recording.cancel" data-testid="audio-reference-record-cancel" tw-class="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm">{{ lazyStrings.audioGeneration__discard_recording() }}</button>
    </div>
    <p v-if="!recordingSupported" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__recording_unavailable() }}</p>
    <p v-if="recordingStatus !== 'idle'" role="status" data-testid="audio-recording-status" tw-class="flex items-center gap-2 text-sm text-purple-600 dark:text-purple-400">
      <Loader2Icon tw-class="h-4 w-4 animate-spin motion-reduce:animate-none" />
      <template v-if="recordingStatus === 'requesting'">{{ lazyStrings.audioGeneration__requesting_microphone() }}</template>
      <template v-else-if="recordingStatus === 'recording'">{{ lazyStrings.audioGeneration__recording_audio() }} {{ elapsed.toFixed(1) }} / 30 s</template>
      <template v-else>{{ lazyStrings.audioGeneration__preparing_recording() }}</template>
    </p>
    <p v-if="recordingTrimmed" role="status" tw-class="text-xs text-amber-700 dark:text-amber-400">{{ lazyStrings.audioGeneration__recording_limited_to_thirty_seconds() }}</p>
    <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__recording_help() }}</p>
    <div v-if="issues.length || preparationFailure || recordingError" role="alert" data-testid="audio-reference-error" tw-class="space-y-1 rounded-lg bg-red-50 dark:bg-red-900/10 p-3 text-sm text-red-700 dark:text-red-400">
      <p v-for="(issue, index) in issues" :key="index" tw-class="break-words">{{ issue.name }}: {{ referenceAudioErrorMessage({ code: issue.code }) }}</p>
      <p v-if="preparationFailure">{{ referenceAudioErrorMessage({ code: preparationFailure }) }}</p>
      <p v-if="recordingError">{{ referenceAudioErrorMessage({ code: recordingError }) }}</p>
    </div>
    <div v-if="entries.length" tw-class="space-y-3">
      <div tw-class="flex flex-wrap items-center gap-3 text-xs">
        <span data-testid="audio-reference-count">{{ lazyStrings.audioGeneration__selected_references() }}: {{ selected.size }} / {{ entries.length }} · {{ (totalBytes / 1048576).toFixed(2) }} MiB</span>
        <button type="button" :disabled="locked || selected.size === 0" @click="deselect" data-testid="audio-clear-reference" tw-class="text-purple-600 dark:text-purple-400 underline disabled:opacity-50">{{ lazyStrings.audioGeneration__deselect_all_references() }}</button>
        <button type="button" :disabled="locked" @click="deleteAll" data-testid="audio-reference-delete-all" tw-class="text-gray-600 dark:text-gray-400 underline disabled:opacity-50">{{ lazyStrings.audioGeneration__delete_all_references() }}</button>
      </div>
      <div tw-class="max-h-96 overflow-y-auto overscroll-y-contain space-y-3 pr-1" data-testid="audio-reference-list">
        <AudioReferenceClip v-for="entry in entries" :key="entry.id" :entry="entry" :selected="selected.has(entry.id)" :disabled="locked" @select="toggle({ id: entry.id, checked: $event })" @remove="deleteReference({ id: entry.id })" />
      </div>
      <p v-if="selected.size === 0" data-testid="audio-reference-none" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__no_reference_selected() }}</p>
    </div>
    <details tw-class="text-xs text-gray-500 dark:text-gray-400" data-testid="audio-reference-notes">
      <summary tw-class="cursor-pointer">{{ lazyStrings.audioGeneration__reference_usage_notes() }}</summary>
      <div tw-class="mt-2 space-y-2 leading-relaxed">
        <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__reference_collection_help() }}</p>
        <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__reference_help() }}</p>
      </div>
    </details>
  </section>
</template>
