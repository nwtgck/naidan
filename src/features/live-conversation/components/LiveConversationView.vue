<script setup lang="ts">
import { liveControls } from '@/features/live-conversation/logic/controller';
import { computed, onMounted, onUnmounted, ref, useId } from 'vue';
import { MicIcon, AudioLinesIcon, ImageIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { storageService } from '@/00-storage/service';
import { idToRaw } from '@/01-models/ids';
import type { Volume } from '@/01-models/types';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import LlamaCppBrowserManager from '@/features/llama-cpp-browser/components/LlamaCppBrowserManager.vue';
import ModelSelector from '@/components/ModelSelector.vue';
import { useLiveConversation } from '@/features/live-conversation/composables/useLiveConversation';
import type { LiveTurnSettings } from '@/features/live-conversation/logic/controller';
import { readLiveShellCall } from '@/features/live-conversation/logic/wesh-policy';

const id = useId();
const manager = ref<InstanceType<typeof LlamaCppBrowserManager>>();
const { state, controller } = useLiveConversation();
const models = ref<LocalModel[]>([]);
const modelId = ref('');
const runtimeReady = ref(false);
const instructions = ref('');
const text = ref('');
const microphone = ref('on');
const textInput = ref('on');
const imageInput = ref('on');
const voiceOutput = ref('on');
const textOutput = ref('on');
const transcription = ref<'on' | 'off'>('off');
const hideText = ref(false);
const muted = ref(false);
const images = ref<{ blob: File, name: string, url: string }[]>([]);
const imageFailure = ref(false);
const tools = ref(false);
const volumes = ref<Volume[]>([]);
const volumeId = ref('');
const writable = ref(false);
const folderFailure = ref<string>();
let disposed = false;
const active = computed(() => state.value.phase !== 'idle');
// A completed native response can still have queued speech. Finish it or use
// the explicit interrupt action before accepting another input turn.
const ready = computed(() => state.value.phase === 'ready' && !state.value.playing);
const vision = computed(() => state.value.info?.vision === 'available');
const selectedFolder = computed(() => volumes.value.find(volume => idToRaw({ id: volume.id }) === volumeId.value));
const outputSelected = computed(() => voiceOutput.value === 'on' || textOutput.value === 'on');
const output = computed<LiveTurnSettings['output']>(() => voiceOutput.value === 'on' ? textOutput.value === 'on' ? 'mixed' : 'audio' : 'text');
const canStart = computed(() => !active.value && runtimeReady.value && !!modelId.value && (!tools.value || !!selectedFolder.value));
const pendingImages = computed(() => imageInput.value === 'on' ? images.value.map(({ blob, name }) => ({ blob, name })) : []);
const pendingText = computed(() => textInput.value === 'on' ? text.value : '');
const status = computed(() => {
  switch (state.value.phase) {
  case 'idle': return lazyStrings.liveConversation__idle();
  case 'loading': return lazyStrings.liveConversation__loading();
  case 'ready': return lazyStrings.liveConversation__ready();
  case 'recording': return lazyStrings.liveConversation__recording();
  case 'transcribing': return lazyStrings.liveConversation__transcribing();
  case 'responding': return lazyStrings.liveConversation__responding();
  case 'approval': return lazyStrings.liveConversation__approval();
  case 'tool-running': return lazyStrings.liveConversation__working();
  case 'stopping': return lazyStrings.liveConversation__stopping();
  case 'closing': return lazyStrings.liveConversation__closing();
  default: {
    const exhaustive: never = state.value.phase;
    throw new Error(String(exhaustive));
  }
  }
});

function updateModels({ entries }: { entries: LocalModel[] }): void {
  models.value = entries;
}

function selectModel({ value }: { value: string | undefined }): void {
  if (!active.value && value !== undefined) {
    modelId.value = value;
  }
}

async function refreshFolders(): Promise<void> {
  try {
    const next: Volume[] = [];
    for await (const volume of storageService.listVolumes()) {
      next.push(volume);
    }
    if (!disposed) {
      volumes.value = next;
      folderFailure.value = undefined;
    }
  } catch (error) {
    if (!disposed) {
      folderFailure.value = error instanceof Error ? error.message : String(error);
    }
  }
}

function clearDraft(): void {
  text.value = '';
  for (const image of images.value) {
    URL.revokeObjectURL(image.url);
  }
  images.value = [];
}

function attach({ event }: { event: Event }): void {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  const files = Array.from(input.files ?? []);
  input.value = '';
  imageFailure.value = files.length + images.value.length > 4 || files.some(file => file.size > 16 * 1024 * 1024 || !file.type.startsWith('image/'));
  if (imageFailure.value || !ready.value || !vision.value) {
    return;
  }
  images.value = [...images.value, ...files.map(blob => ({ blob, name: blob.name, url: URL.createObjectURL(blob) }))];
}

function removeImage({ url }: { url: string }): void {
  URL.revokeObjectURL(url);
  images.value = images.value.filter(image => image.url !== url);
}

async function start(): Promise<void> {
  const folder = selectedFolder.value;
  await controller.open({
    modelId: modelId.value,
    instructions: instructions.value,
    folder: tools.value && folder ? { volumeId: folder.id, access: writable.value ? 'read-write' : 'read-only' } : undefined,
  });
  controller.mute({ value: muted.value ? 'off' : 'on' });
}

async function send(): Promise<void> {
  if (!ready.value || !outputSelected.value || (!pendingText.value.trim() && !pendingImages.value.length)) {
    return;
  }
  const before = state.value.entries.length;
  await controller.send({ text: pendingText.value, images: pendingImages.value, settings: { output: output.value, transcription: 'off' } });
  if (state.value.entries.length > before && state.value.entries.at(-1)?.status !== 'discarded') {
    clearDraft();
  }
}

async function record(): Promise<void> {
  if (!ready.value || !outputSelected.value || microphone.value !== 'on') {
    return;
  }
  await controller.record({ text: pendingText.value, images: pendingImages.value, settings: { output: output.value, transcription: transcription.value } });
  if (liveControls({ phase: state.value.phase }).recording) {
    clearDraft();
  }
}

onMounted(() => {
  void refreshFolders();
});
onUnmounted(() => {
  disposed = true;
  clearDraft();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="absolute inset-0 overflow-y-auto overscroll-y-contain bg-[#fcfcfd] text-gray-900 dark:bg-gray-900 dark:text-gray-100" data-testid="live-conversation-page">
    <main tw-class="mx-auto w-full max-w-6xl space-y-5 px-4 py-6 sm:px-8">
      <header tw-class="space-y-2">
        <h1 tw-class="flex items-center gap-3 text-xl font-semibold"><AudioLinesIcon aria-hidden="true" tw-class="h-6 w-6 text-blue-500" />{{ lazyStrings.liveConversation__live_conversation() }}</h1>
        <p tw-class="text-sm text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__introduction() }}</p>
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__ephemeral_session() }}</p>
      </header>
      <details :open="models.length === 0" tw-class="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
        <summary tw-class="cursor-pointer text-sm font-medium">{{ lazyStrings.liveConversation__manage_models_and_runtime() }}</summary>
        <p tw-class="my-3 text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__model_setup() }}</p>
        <LlamaCppBrowserManager ref="manager" presentation="embedded" suggestions="none" :suspended="active" @models-changed="updateModels({ entries: $event })" @model-selected="selectModel({ value: $event })" @runtime-ready="runtimeReady = $event" />
      </details>
      <section tw-class="space-y-4 rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800/40">
        <fieldset :disabled="active" tw-class="space-y-3 disabled:opacity-60">
          <label :for="`${id}-model`" tw-class="block text-sm font-medium">{{ lazyStrings.liveConversation__model() }}</label>
          <ModelSelector :input-id="`${id}-model`" :model-value="modelId || undefined" :models="models.map(model => model.modelId)" :loading="false" :disabled="active" :placeholder="lazyStrings.liveConversation__choose_model()" @update:model-value="selectModel({ value: $event })" @refresh="manager?.refresh()" data-testid="live-model" />
          <label tw-class="block text-sm">{{ lazyStrings.liveConversation__instructions() }}<textarea v-model="instructions" maxlength="16384" rows="2" tw-class="mt-1 w-full rounded-lg border border-gray-200 bg-transparent p-2 text-sm dark:border-gray-600" data-testid="live-instructions" /></label>
          <details>
            <summary tw-class="cursor-pointer text-sm">Wesh</summary>
            <label tw-class="my-3 flex items-center gap-2 text-sm"><input v-model="tools" type="checkbox" data-testid="live-wesh-enabled" />{{ lazyStrings.liveConversation__wesh_tools() }}</label>
            <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__wesh_help() }}</p>
            <label tw-class="mt-2 block text-sm">{{ lazyStrings.liveConversation__folder() }}<select v-model="volumeId" :disabled="!tools" tw-class="mt-1 w-full rounded-lg border border-gray-200 bg-transparent p-2 dark:border-gray-600" data-testid="live-volume"><option value="">{{ lazyStrings.liveConversation__no_folder() }}</option><option v-for="volume in volumes" :key="idToRaw({ id: volume.id })" :value="idToRaw({ id: volume.id })">{{ volume.name }}</option></select></label>
            <button type="button" @click="refreshFolders" tw-class="my-2 text-xs text-blue-600 underline dark:text-blue-400">{{ lazyStrings.liveConversation__refresh_folders() }}</button>
            <label tw-class="flex items-center gap-2 text-sm"><input v-model="writable" type="checkbox" :disabled="!tools" />{{ lazyStrings.liveConversation__allow_writes() }}</label>
            <p v-if="folderFailure" role="alert" tw-class="mt-2 text-xs text-red-600">{{ folderFailure }}</p>
          </details>
        </fieldset>
        <div tw-class="flex flex-wrap items-center gap-3">
          <button v-if="!active" type="button" :disabled="!canStart" @click="start" tw-class="rounded-xl bg-blue-600 px-5 py-3 text-sm font-medium text-white disabled:opacity-40" data-testid="live-start">{{ lazyStrings.liveConversation__start_session() }}</button>
          <button v-else type="button" :disabled="state.phase === 'closing'" @click="controller.close()" tw-class="rounded-xl border border-gray-300 px-4 py-3 text-sm disabled:opacity-40 dark:border-gray-600" data-testid="live-end">{{ lazyStrings.liveConversation__end_session() }}</button>
          <button type="button" :disabled="!ready" @click="controller.reset()" tw-class="rounded-xl px-4 py-3 text-sm text-gray-500 disabled:opacity-40" data-testid="live-clear">{{ lazyStrings.liveConversation__clear_conversation() }}</button>
          <p role="status" aria-live="polite" tw-class="text-sm text-blue-600 dark:text-blue-400" data-testid="live-status">{{ status }}<span v-if="state.playing"> · {{ lazyStrings.liveConversation__playing() }}</span></p>
        </div>
      </section>
      <div v-if="state.failure || imageFailure" role="alert" tw-class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/10 dark:text-red-300" data-testid="live-error"><p>{{ imageFailure ? lazyStrings.liveConversation__image_limit() : lazyStrings.liveConversation__failed() }}</p><code v-if="state.failure" tw-class="mt-2 block break-words text-xs">{{ state.failure }}</code></div>
      <div tw-class="grid gap-5 lg:grid-cols-2">
        <section tw-class="space-y-4 rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800/40">
          <fieldset tw-class="space-y-2"><legend tw-class="mb-2 text-sm font-semibold">{{ lazyStrings.liveConversation__input_channels() }}</legend>
            <div tw-class="flex flex-wrap gap-4 text-sm"><label tw-class="flex items-center gap-2"><input v-model="microphone" type="checkbox" true-value="on" false-value="off" />{{ lazyStrings.liveConversation__microphone() }}</label><label tw-class="flex items-center gap-2"><input v-model="textInput" type="checkbox" true-value="on" false-value="off" />{{ lazyStrings.liveConversation__text_input() }}</label><label tw-class="flex items-center gap-2"><input v-model="imageInput" type="checkbox" true-value="on" false-value="off" :disabled="!vision" />{{ lazyStrings.liveConversation__images() }}</label></div>
            <p v-if="!vision" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__images_require_omni() }}</p>
          </fieldset>
          <fieldset tw-class="space-y-2"><legend tw-class="mb-2 text-sm font-semibold">{{ lazyStrings.liveConversation__output_channels() }}</legend><div tw-class="flex gap-4 text-sm"><label tw-class="flex items-center gap-2"><input v-model="voiceOutput" type="checkbox" true-value="on" false-value="off" data-testid="live-output-voice" />{{ lazyStrings.liveConversation__voice() }}</label><label tw-class="flex items-center gap-2"><input v-model="textOutput" type="checkbox" true-value="on" false-value="off" data-testid="live-output-text" />{{ lazyStrings.liveConversation__answer_text() }}</label></div><p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__channels_help() }}</p></fieldset>
          <label tw-class="flex items-center gap-2 text-sm"><input v-model="transcription" type="checkbox" true-value="on" false-value="off" data-testid="live-transcription" />{{ lazyStrings.liveConversation__transcribe_my_audio() }}</label><p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__transcription_cost() }}</p>
          <label tw-class="flex items-center gap-2 text-xs"><input v-model="muted" type="checkbox" @change="controller.mute({ value: muted ? 'off' : 'on' })" />{{ lazyStrings.liveConversation__mute_playback() }}</label><label tw-class="flex items-center gap-2 text-xs"><input v-model="hideText" type="checkbox" />{{ lazyStrings.liveConversation__hide_answer_text() }}</label>
          <form @submit.prevent="send" tw-class="space-y-3">
            <label tw-class="block text-sm">{{ lazyStrings.liveConversation__input_text() }}<textarea v-model="text" :disabled="!ready || textInput !== 'on'" maxlength="32768" rows="3" tw-class="mt-1 w-full rounded-xl border border-gray-200 bg-transparent p-3 disabled:opacity-40 dark:border-gray-600" data-testid="live-text" /></label>
            <label tw-class="block text-xs"><ImageIcon aria-hidden="true" tw-class="mr-1 inline h-4 w-4" />{{ lazyStrings.liveConversation__attach_images() }}<input type="file" multiple accept="image/*" :disabled="!ready || !vision || imageInput !== 'on'" @change="attach({ event: $event })" tw-class="mt-2 block max-w-full text-xs disabled:opacity-40" data-testid="live-images" /></label>
            <div tw-class="flex flex-wrap gap-3"><div v-for="image in images" :key="image.url" tw-class="w-24 space-y-1"><img :src="image.url" :alt="image.name" tw-class="h-20 w-24 rounded-lg object-contain" /><button type="button" :disabled="!ready" @click="removeImage({ url: image.url })" tw-class="text-xs underline">{{ lazyStrings.liveConversation__remove() }}</button></div></div>
            <div tw-class="flex flex-wrap gap-2">
              <button type="submit" :disabled="!ready || !outputSelected || (!pendingText.trim() && !pendingImages.length)" tw-class="rounded-xl bg-blue-600 px-4 py-3 text-sm text-white disabled:opacity-40" data-testid="live-send">{{ lazyStrings.liveConversation__send() }}</button>
              <button v-if="state.phase !== 'recording'" type="button" :disabled="!ready || !outputSelected || microphone !== 'on'" @click="record" tw-class="flex items-center gap-2 rounded-xl border border-gray-300 px-4 py-3 text-sm disabled:opacity-40 dark:border-gray-600" data-testid="live-record"><MicIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.liveConversation__start_recording() }}</button>
              <button v-else type="button" @click="controller.finishRecording()" tw-class="rounded-xl bg-blue-600 px-4 py-3 text-sm text-white" data-testid="live-finish">{{ lazyStrings.liveConversation__stop_and_send() }}</button>
              <button type="button" :disabled="!active || state.phase === 'loading' || state.phase === 'closing' || state.phase === 'stopping' || (ready && !state.playing)" @click="controller.interrupt()" tw-class="rounded-xl border border-red-200 px-4 py-3 text-sm text-red-600 disabled:opacity-40 dark:border-red-800 dark:text-red-400" data-testid="live-interrupt">{{ lazyStrings.liveConversation__interrupt() }}</button>
            </div>
            <p tw-class="text-xs leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__interruption_help() }}</p>
          </form>
          <section v-if="state.pendingTools.length" tw-class="space-y-3 rounded-xl border border-amber-300 p-3" data-testid="live-tool-approval"><h2 tw-class="text-sm font-semibold">{{ lazyStrings.liveConversation__approval_required() }}</h2><pre v-for="call in state.pendingTools" :key="call.id" tw-class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-gray-50 p-2 text-xs dark:bg-gray-900">{{ readLiveShellCall({ call }).shell_script }}</pre><div tw-class="flex flex-wrap gap-2"><button type="button" @click="controller.approve({ decision: 'run' })" tw-class="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white" data-testid="live-tool-run">{{ lazyStrings.liveConversation__approve_commands() }}</button><button type="button" @click="controller.approve({ decision: 'deny' })" tw-class="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600" data-testid="live-tool-deny">{{ lazyStrings.liveConversation__deny_commands() }}</button></div></section>
        </section>
        <section tw-class="space-y-4 rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800/40" data-testid="live-history">
          <p v-if="!state.entries.length" tw-class="text-sm leading-6 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__empty_conversation() }}</p>
          <article v-for="turn in state.entries" :key="turn.id" :tw-class="['space-y-3 border-b border-gray-100 pb-5 dark:border-gray-700', { 'opacity-50': turn.status === 'discarded' }]" data-testid="live-turn">
            <h2 tw-class="text-xs font-semibold text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__you() }}</h2>
            <p v-if="turn.inputText" tw-class="whitespace-pre-wrap break-words text-sm">{{ turn.inputText }}</p><p v-if="turn.hasAudio" tw-class="text-sm">{{ lazyStrings.liveConversation__recorded_audio() }}</p><p v-for="name in turn.imageNames" :key="name" tw-class="break-words text-xs text-gray-500">{{ name }}</p>
            <details v-if="turn.transcript" open><summary tw-class="cursor-pointer text-xs text-gray-500">{{ lazyStrings.liveConversation__transcript() }}</summary><p tw-class="mt-1 whitespace-pre-wrap break-words text-sm">{{ turn.transcript }}</p></details>
            <h2 tw-class="text-xs font-semibold text-blue-600 dark:text-blue-400">{{ lazyStrings.liveConversation__assistant() }}</h2>
            <p v-if="turn.answer && !hideText" tw-class="whitespace-pre-wrap break-words text-sm leading-6">{{ turn.answer }}</p><p v-else-if="turn.output !== 'text'" tw-class="text-xs text-gray-500">{{ lazyStrings.liveConversation__voice_response() }}</p>
            <details v-for="result in turn.toolResults" :key="result.id"><summary tw-class="cursor-pointer text-xs">shell_execute</summary><pre tw-class="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{{ result.command }}{{ '\n' }}{{ result.result }}</pre></details>
            <p v-if="turn.status === 'discarded'" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.liveConversation__discarded() }}</p><p v-if="turn.status === 'limit'" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.liveConversation__limit() }}</p>
          </article>
        </section>
      </div>
    </main>
  </div>
</template>
