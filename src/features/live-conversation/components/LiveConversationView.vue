<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, useId, watch } from 'vue';
import { AudioLinesIcon, ChevronRightIcon, FolderOpenIcon, InfoIcon, Loader2Icon, MessageSquarePlusIcon, SlidersHorizontalIcon, SquareIcon, Trash2Icon } from 'lucide-vue-next';
import { ensureStrings, lazyStrings } from '@/strings';
import { storageService } from '@/00-storage/service';
import { idToRaw } from '@/01-models/ids';
import type { Volume } from '@/01-models/types';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { listModelInventory } from '@/features/llama-cpp-browser/composables/model-inventory';
import { llamaCppBrowserModelFiles } from '@/features/llama-cpp-browser/model-files';
import LlamaCppBrowserManager from '@/features/llama-cpp-browser/components/LlamaCppBrowserManager.vue';
import LlamaCppBrowserModelSuggestions from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelSuggestions.vue';
import ModelSelector from '@/components/ModelSelector.vue';
import SettingsChoiceControl from '@/components/SettingsChoiceControl.vue';
import { useConfirm } from '@/composables/useConfirm';
import { useLiveConversation } from '@/features/live-conversation/composables/useLiveConversation';
import { useLiveModelPreference } from '@/features/live-conversation/composables/useLiveModelPreference';
import { useLiveComposer, type LiveDraft, type LivePendingMessage } from '@/features/live-conversation/composables/useLiveComposer';
import type { LiveTurnSettings } from '@/features/live-conversation/logic/controller';
import { readLiveShellCall } from '@/features/live-conversation/logic/wesh-policy';
import { liveModelCatalog } from '@/features/live-conversation/model-catalog';
import LiveConversationInput from './LiveConversationInput.vue';
import LiveConversationHistory from './LiveConversationHistory.vue';

const id = useId();
const input = ref<InstanceType<typeof LiveConversationInput>>();
const history = ref<InstanceType<typeof LiveConversationHistory>>();
const scroll = ref<HTMLElement>();
const historyEnd = ref<HTMLElement>();
const { state, controller } = useLiveConversation();
const preference = useLiveModelPreference();
const { showConfirm } = useConfirm();
const models = ref<LocalModel[]>([]);
const modelId = ref(preference.remembered.value ?? '');
const residentModelId = ref('');
const runtimeReady = ref(false);
const instructions = ref('');
const microphone = ref(true);
const textInput = ref(true);
const imageInput = ref(true);
const voiceOutput = ref(true);
const textOutput = ref(true);
const transcription = ref(true);
const keepAudio = ref(false);
const hideText = ref(false);
const muted = ref(false);
const tools = ref(false);
const volumes = ref<Volume[]>([]);
const volumeId = ref('');
const writable = ref(false);
const folderFailure = ref<string>();
const preferenceFailure = ref(false);
const inventoryFailure = ref(false);
const changingConversation = ref(false);
const talkPending = ref(false);
const manualReplay = shallowRef<HTMLAudioElement>();
const dragDepth = ref(0);
let manualSelection = false;
let disposed = false;
let scan: AbortController | undefined;
let unsubscribeModels: (() => void) | undefined;
let nearBottom = true;
const active = computed(() => state.value.phase !== 'idle');
const idleForTurn = computed(() => state.value.phase === 'ready' && !state.value.playing && !changingConversation.value && !talkPending.value && !manualReplay.value);
const vision = computed(() => state.value.info?.vision !== 'unavailable');
const selectedFolder = computed(() => volumes.value.find(volume => idToRaw({ id: volume.id }) === volumeId.value));
const selectedAvailable = computed(() => models.value.some(model => model.modelId === modelId.value));
const outputSelected = computed(() => voiceOutput.value || textOutput.value);
const output = computed<LiveTurnSettings['output']>(() => voiceOutput.value ? textOutput.value ? 'mixed' : 'audio' : 'text');
const busy = computed(() => active.value && (state.value.phase !== 'ready' || state.value.playing));
const canStart = computed(() => !active.value && runtimeReady.value && selectedAvailable.value && (!tools.value || !!selectedFolder.value));
const canQueue = computed(() => active.value && state.value.phase !== 'closing' && !changingConversation.value);
const canTalk = computed(() => active.value && !changingConversation.value && !talkPending.value && !['loading', 'closing', 'stopping', 'preparing-input', 'recording'].includes(state.value.phase) && microphone.value && outputSelected.value);
const canReset = computed(() => !changingConversation.value && !['loading', 'closing', 'stopping'].includes(state.value.phase));
const settings = computed<LiveTurnSettings>(() => ({ output: output.value, transcription: transcription.value ? 'on' : 'off' }));
const composer = useLiveComposer({ canProcess: () => idleForTurn.value, deliver });
const { draft, pending, failure: draftFailure, held } = composer;
const draftSupported = computed(() => (!draft.value.images.length || (imageInput.value && vision.value)) && (!draft.value.text.trim() || textInput.value));
const canSubmit = computed(() => canQueue.value && outputSelected.value && composer.hasDraft.value && draftSupported.value);

const status = computed(() => {
  if (state.value.phase === 'ready' && state.value.playing) {
    return lazyStrings.liveConversation__playing();
  }
  switch (state.value.phase) {
  case 'idle': return lazyStrings.liveConversation__idle();
  case 'loading': return lazyStrings.liveConversation__loading();
  case 'ready': return lazyStrings.liveConversation__ready();
  case 'preparing-input': return lazyStrings.liveConversation__preparing_audio();
  case 'recording': return lazyStrings.liveConversation__listening();
  case 'transcribing': return lazyStrings.liveConversation__transcribing();
  case 'responding': return lazyStrings.liveConversation__responding();
  case 'approval': return lazyStrings.liveConversation__approval();
  case 'tool-running': return lazyStrings.liveConversation__working();
  case 'stopping': return lazyStrings.liveConversation__stopping();
  case 'closing': return lazyStrings.liveConversation__releasing_model();
  default: {
    const exhaustive: never = state.value.phase;
    throw new Error(String(exhaustive));
  }
  }
});
const audioWarning = computed(() => {
  const warning = state.value.audioWarning;
  switch (warning) {
  case 'retention-limit': return lazyStrings.liveConversation__audio_retention_limit();
  case 'retention-failed': return lazyStrings.liveConversation__audio_retention_failed();
  case undefined: return undefined;
  default: {
    const exhaustive: never = warning;
    throw new Error(String(exhaustive));
  }
  }
});
const draftMessage = computed(() => {
  switch (draftFailure.value) {
  case 'images-unavailable': return lazyStrings.liveConversation__images_require_omni();
  case 'invalid-attachment': return lazyStrings.liveConversation__attachment_limits();
  case 'queue-full': return lazyStrings.liveConversation__pending_limit();
  case 'send-failed': return lazyStrings.liveConversation__pending_failed();
  case undefined: return undefined;
  default: {
    const exhaustive: never = draftFailure.value;
    throw new Error(String(exhaustive));
  }
  }
});

function updateModels({ entries }: { entries: LocalModel[] }): void {
  models.value = entries;
  if (!modelId.value && !manualSelection && !active.value) {
    modelId.value = preference.remembered.value ?? entries.find(model => /LFM3-(Audio|Omni)-2B/i.test(model.modelId))?.modelId ?? '';
  }
}

async function refreshInventory(): Promise<void> {
  scan?.abort();
  const current = new AbortController();
  scan = current;
  try {
    const entries = await listModelInventory({ signal: current.signal });
    if (!disposed && scan === current) {
      updateModels({ entries });
      inventoryFailure.value = false;
    }
  } catch {
    if (!disposed && !current.signal.aborted) {
      inventoryFailure.value = true;
    }
  }
}

function selectModel({ value }: { value: string | undefined }): void {
  if (value === undefined || disposed) {
    return;
  }
  manualSelection = true;
  modelId.value = value;
  preferenceFailure.value = false;
  void preference.remember({ modelId: value }).catch(() => {
    if (!disposed) {
      preferenceFailure.value = true;
    }
  });
}

function catalogSelect({ model }: { model: LocalModel }): void {
  if (!models.value.some(entry => entry.modelId === model.modelId)) {
    models.value = [...models.value, model];
  }
  selectModel({ value: model.modelId });
}

watch(preference.remembered, value => {
  if (!manualSelection && !active.value && value !== undefined) {
    modelId.value = value;
  }
});

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

function replayStarted({ element }: { element: HTMLAudioElement }): void {
  if (manualReplay.value !== element) {
    manualReplay.value?.pause();
  }
  manualReplay.value = element;
  // Keep inference intact while listening to a previous message; only mute the
  // automatic output so two voices never overlap. The mute setting stays visible.
  if (busy.value) {
    muted.value = true;
    controller.mute({ value: 'off' });
  }
}

function replayEnded({ element }: { element: HTMLAudioElement }): void {
  if (manualReplay.value === element) {
    manualReplay.value = undefined;
  }
}

function pauseReplays(): void {
  manualReplay.value?.pause();
  manualReplay.value = undefined;
  input.value?.pauseAudio();
  history.value?.pauseAudio();
}

function removeAttachment({ url }: { url: string }): void {
  if (draft.value.audio?.url === url) {
    pauseReplays();
  }
  composer.remove({ url });
}

function attach({ files }: { files: File[] }): void {
  composer.attach({ files, imagesAllowed: imageInput.value && vision.value });
}

function drop({ event }: { event: DragEvent }): void {
  if (!event.dataTransfer?.types.includes('Files')) {
    return;
  }
  event.preventDefault();
  dragDepth.value = 0;
  attach({ files: Array.from(event.dataTransfer.files) });
}

function dragEnter({ event }: { event: DragEvent }): void {
  if (event.dataTransfer?.types.includes('Files')) {
    event.preventDefault();
    dragDepth.value++;
  }
}

function dragOver({ event }: { event: DragEvent }): void {
  if (event.dataTransfer?.types.includes('Files')) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }
}

function dragLeave(): void {
  dragDepth.value = Math.max(0, dragDepth.value - 1);
}

function rememberScroll(): void {
  const element = scroll.value;
  nearBottom = !element || element.scrollHeight - element.scrollTop - element.clientHeight < 220;
}

watch(() => state.value.entries, async () => {
  if (nearBottom) {
    await nextTick();
    historyEnd.value?.scrollIntoView?.({ block: 'nearest' });
  }
});

async function start(): Promise<void> {
  if (!canStart.value) {
    return;
  }
  pauseReplays();
  const selected = modelId.value;
  selectModel({ value: selected });
  residentModelId.value = selected;
  const folder = selectedFolder.value;
  await controller.open({ modelId: selected, instructions: instructions.value, folder: tools.value && folder ? { volumeId: folder.id, access: writable.value ? 'read-write' : 'read-only' } : undefined });
  controller.mute({ value: muted.value ? 'off' : 'on' });
  if (!active.value) {
    residentModelId.value = '';
  }
}

async function deliver({ message }: { message: LivePendingMessage }): Promise<'accepted' | 'rejected'> {
  pauseReplays();
  if (message.draft.images.length && state.value.info?.vision !== 'available') {
    return 'rejected';
  }
  const before = state.value.entries.length;
  const base = { text: message.draft.text, images: message.draft.images.map(item => ({ blob: item.file, name: item.file.name })), settings: message.settings };
  if (message.draft.audio) {
    await controller.sendAudioFile({ ...base, file: { blob: message.draft.audio.file, name: message.draft.audio.file.name } });
  } else {
    await controller.send(base);
  }
  return state.value.entries.length > before && !state.value.failure ? 'accepted' : 'rejected';
}

function send(): void {
  if (canSubmit.value) {
    // A submitted attachment leaves the composer. Stop its preview explicitly;
    // a detached audio element must not keep the queue waiting for pause/end.
    // This does not stop the model's separate automatic response player.
    pauseReplays();
    composer.enqueue({ settings: settings.value });
  }
}

async function talk(): Promise<void> {
  if (!canTalk.value || draft.value.audio || !draftSupported.value) {
    return;
  }
  if (composer.hasDraft.value && !composer.reserveSpeechDraft()) {
    return;
  }
  talkPending.value = true;
  held.value = true;
  pauseReplays();
  const value: LiveDraft = composer.take();
  const turnSettings = { ...settings.value };
  try {
    if (busy.value) {
      await controller.interrupt();
    }
    if (disposed) {
      return;
    }
    await controller.record({ text: value.text, images: value.images.map(item => ({ blob: item.file, name: item.file.name })), settings: turnSettings });
    // A denied microphone must not erase a prepared text/image draft. Keep it
    // separate if the user already typed another message while permission waited.
    if (state.value.phase !== 'recording' && !disposed && (value.text || value.images.length)) {
      pending.value = [{ id: crypto.randomUUID(), draft: value, settings: turnSettings, status: 'paused' }, ...pending.value];
    } else {
      composer.release({ value });
    }
  } finally {
    if (disposed) {
      composer.release({ value });
    }
    composer.releaseSpeechDraft();
    talkPending.value = false;
    held.value = false;
  }
}

async function interrupt(): Promise<void> {
  held.value = true;
  try {
    await controller.interrupt();
  } finally {
    held.value = false;
  }
}

async function newConversation(): Promise<void> {
  if (!canReset.value) {
    return;
  }
  const changeModel = active.value && modelId.value !== residentModelId.value;
  if (changeModel && !selectedAvailable.value) {
    inventoryFailure.value = true;
    return;
  }
  changingConversation.value = true;
  held.value = true;
  try {
    if (state.value.entries.length || pending.value.length || composer.hasDraft.value || busy.value) {
      const confirmed = await showConfirm({
        title: await ensureStrings.liveConversation__new_conversation(),
        message: await ensureStrings.liveConversation__new_conversation_confirmation(),
        confirmButtonText: await ensureStrings.liveConversation__new_conversation(),
        confirmButtonVariant: 'danger',
      });
      if (!confirmed || disposed) {
        return;
      }
    }
    pauseReplays();
    await controller.interrupt();
    if (disposed) {
      return;
    }
    if (changeModel) {
      await controller.close();
      residentModelId.value = '';
    }
    await controller.reset();
    composer.clear();
    if (changeModel && !disposed) {
      await start();
    }
  } finally {
    changingConversation.value = false;
    held.value = false;
  }
}

async function releaseModel(): Promise<void> {
  if (!active.value || changingConversation.value) {
    return;
  }
  changingConversation.value = true;
  held.value = true;
  try {
    const confirmed = await showConfirm({ title: await ensureStrings.liveConversation__release_model(), message: await ensureStrings.liveConversation__release_model_confirmation(), confirmButtonText: await ensureStrings.liveConversation__release_model() });
    if (!confirmed || disposed) {
      return;
    }
    pauseReplays();
    await controller.close();
    for (const message of pending.value) {
      composer.cancel({ id: message.id });
    }
    residentModelId.value = '';
  } finally {
    changingConversation.value = false;
    held.value = false;
  }
}

function playbackChanged(): void {
  if (!muted.value) {
    pauseReplays();
  }
  controller.mute({ value: muted.value ? 'off' : 'on' });
}

function retentionChanged(): void {
  pauseReplays();
  controller.retainAudio({ value: keepAudio.value ? 'on' : 'off' });
}

function editPending({ id, event }: { id: string, event: Event }): void {
  if (event.target instanceof HTMLTextAreaElement) {
    composer.edit({ id, text: event.target.value });
  }
}

onMounted(() => {
  void refreshFolders();
  // Listing model files does not acquire the resident inference lane. The
  // suspended manager can stay safe while the catalog downloads other models.
  unsubscribeModels = llamaCppBrowserModelFiles.subscribeModelList({
    listener: () => {
      void refreshInventory();
    },
  });
});
onUnmounted(() => {
  disposed = true;
  scan?.abort();
  unsubscribeModels?.();
  pauseReplays();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div ref="scroll" @scroll="rememberScroll" @dragenter="dragEnter({ event: $event })" @dragover="dragOver({ event: $event })" @dragleave="dragLeave" @drop="drop({ event: $event })" tw-class="absolute inset-0 overflow-y-auto overscroll-y-contain bg-[#fcfcfd] text-gray-900 dark:bg-gray-900 dark:text-gray-100" data-testid="live-conversation-page">
    <main tw-class="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-5 px-4 py-6 sm:px-8 sm:py-8">
      <header tw-class="space-y-3 pb-2">
        <div tw-class="flex flex-wrap items-center justify-between gap-3">
          <h1 tw-class="flex items-center gap-3 text-xl font-semibold tracking-tight"><span tw-class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50/80 text-blue-500 dark:bg-blue-500/10 dark:text-blue-400"><AudioLinesIcon aria-hidden="true" tw-class="h-5 w-5" /></span>{{ lazyStrings.liveConversation__live_conversation() }}</h1>
          <button type="button" :disabled="!canReset" @click="newConversation" tw-class="flex min-h-10 items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 text-xs font-medium transition-colors hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:bg-gray-800/40 dark:hover:bg-gray-800" data-testid="live-new-conversation"><MessageSquarePlusIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.liveConversation__new_conversation() }}</button>
        </div>
        <p tw-class="text-xs leading-6 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__ephemeral_session() }}</p>
      </header>
      <LlamaCppBrowserModelSuggestions :suggestions="liveModelCatalog" :models="models" :disabled="false" :default-model="undefined" :default-action-disabled="changingConversation" selection-action="select" memory-filter="hide" @select="catalogSelect({ model: $event })" @changed="refreshInventory" />
      <details :open="models.length === 0" tw-class="group/live-manager overflow-hidden rounded-xl border border-gray-200/70 bg-white/60 dark:border-gray-800/80 dark:bg-gray-900/20" data-testid="live-model-manager">
        <summary tw-class="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40 dark:text-gray-200 dark:hover:bg-gray-800/40 [&::-webkit-details-marker]:hidden"><FolderOpenIcon aria-hidden="true" tw-class="h-4 w-4 text-blue-500" /><span tw-class="min-w-0 flex-1">{{ lazyStrings.liveConversation__manage_models_and_runtime() }}</span><ChevronRightIcon aria-hidden="true" tw-class="h-6 w-6 rounded-lg bg-gray-100/70 p-1.5 text-gray-400 transition-transform group-open/live-manager:rotate-90 dark:bg-gray-800" /></summary>
        <div tw-class="max-h-[65dvh] space-y-4 overflow-y-auto overscroll-y-contain border-t border-gray-100 p-4 dark:border-gray-800"><p tw-class="text-xs leading-6 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__model_setup() }}</p><LlamaCppBrowserManager presentation="embedded" suggestions="none" :suspended="active" @models-changed="updateModels({ entries: $event })" @model-selected="selectModel({ value: $event })" @runtime-ready="runtimeReady = $event" /></div>
      </details>
      <section tw-class="space-y-4 rounded-2xl border border-gray-200/70 bg-white/70 p-4 sm:p-5 dark:border-gray-800/80 dark:bg-gray-900/40">
        <div tw-class="space-y-2"><label :for="`${id}-model`" tw-class="block text-sm font-medium">{{ lazyStrings.liveConversation__model() }}</label><ModelSelector :input-id="`${id}-model`" :model-value="modelId || undefined" :models="models.map(model => model.modelId)" :loading="false" :disabled="changingConversation" :placeholder="lazyStrings.liveConversation__choose_model()" @update:model-value="selectModel({ value: $event })" @refresh="refreshInventory" data-testid="live-model" /></div>
        <p v-if="active && modelId !== residentModelId" tw-class="text-xs leading-5 text-amber-700 dark:text-amber-300" data-testid="live-next-model">{{ lazyStrings.liveConversation__model_changes_next_conversation() }}</p>
        <p v-if="preferenceFailure" role="alert" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.liveConversation__model_preference_failed() }}</p>
        <p v-if="inventoryFailure" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.liveConversation__model_inventory_failed() }}</p>
        <div tw-class="flex flex-wrap items-center gap-3">
          <button v-if="!active" type="button" :disabled="!canStart || changingConversation" @click="start" tw-class="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40" data-testid="live-start">{{ lazyStrings.liveConversation__start_session() }}</button>
          <span v-if="active && state.info" tw-class="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-600 dark:bg-blue-500/10 dark:text-blue-400">{{ lazyStrings.liveConversation__model_loaded() }}</span>
          <span role="status" tw-class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400" data-testid="live-status"><Loader2Icon v-if="active && state.phase !== 'ready' && state.phase !== 'recording' && state.phase !== 'approval'" aria-hidden="true" tw-class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{{ status }}</span>
          <button v-if="busy && !['loading', 'closing', 'stopping'].includes(state.phase)" type="button" @click="interrupt" :title="lazyStrings.liveConversation__interruption_help()" tw-class="ml-auto flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800" data-testid="live-interrupt"><SquareIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.liveConversation__stop_response() }}</button>
        </div>
        <details tw-class="group/live-settings rounded-xl bg-gray-50/80 dark:bg-gray-800/35" data-testid="live-settings">
          <summary tw-class="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-xs font-medium text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 dark:text-gray-300 [&::-webkit-details-marker]:hidden"><SlidersHorizontalIcon aria-hidden="true" tw-class="h-4 w-4" /><span tw-class="flex-1">{{ lazyStrings.liveConversation__conversation_settings() }}</span><ChevronRightIcon aria-hidden="true" tw-class="h-4 w-4 transition-transform group-open/live-settings:rotate-90" /></summary>
          <div tw-class="space-y-5 px-3 pb-4 sm:px-4">
            <fieldset tw-class="space-y-2"><legend tw-class="mb-2 text-xs font-semibold">{{ lazyStrings.liveConversation__input_channels() }}</legend><div tw-class="flex flex-wrap gap-4 text-xs"><label tw-class="flex min-h-9 items-center gap-2"><SettingsChoiceControl presentation="checkbox"><input v-model="microphone" type="checkbox" /></SettingsChoiceControl>{{ lazyStrings.liveConversation__microphone() }}</label><label tw-class="flex min-h-9 items-center gap-2"><SettingsChoiceControl presentation="checkbox"><input v-model="textInput" type="checkbox" /></SettingsChoiceControl>{{ lazyStrings.liveConversation__text_input() }}</label><label tw-class="flex min-h-9 items-center gap-2"><SettingsChoiceControl presentation="checkbox"><input v-model="imageInput" type="checkbox" :disabled="!vision" /></SettingsChoiceControl>{{ lazyStrings.liveConversation__images() }}</label></div></fieldset>
            <fieldset tw-class="space-y-2"><legend tw-class="mb-2 flex items-center gap-2 text-xs font-semibold">{{ lazyStrings.liveConversation__output_channels() }}<InfoIcon tabindex="0" role="img" :aria-label="lazyStrings.liveConversation__channels_help()" :title="lazyStrings.liveConversation__channels_help()" tw-class="h-3.5 w-3.5 text-gray-400" /></legend><div tw-class="flex flex-wrap gap-4 text-xs"><label tw-class="flex min-h-9 items-center gap-2"><SettingsChoiceControl presentation="checkbox"><input v-model="voiceOutput" type="checkbox" data-testid="live-output-voice" /></SettingsChoiceControl>{{ lazyStrings.liveConversation__voice() }}</label><label tw-class="flex min-h-9 items-center gap-2"><SettingsChoiceControl presentation="checkbox"><input v-model="textOutput" type="checkbox" data-testid="live-output-text" /></SettingsChoiceControl>{{ lazyStrings.liveConversation__answer_text() }}</label></div></fieldset>
            <div tw-class="space-y-3 text-xs">
              <label tw-class="flex min-h-9 items-center gap-2"><SettingsChoiceControl presentation="checkbox"><input v-model="transcription" type="checkbox" data-testid="live-transcription" /></SettingsChoiceControl><span>{{ lazyStrings.liveConversation__transcribe_my_audio() }}</span><InfoIcon tabindex="0" role="img" :aria-label="lazyStrings.liveConversation__transcription_cost()" :title="lazyStrings.liveConversation__transcription_cost()" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400" /></label>
              <label tw-class="flex min-h-9 items-center gap-2"><SettingsChoiceControl presentation="checkbox"><input v-model="keepAudio" type="checkbox" @change="retentionChanged" data-testid="live-keep-audio" /></SettingsChoiceControl><span>{{ lazyStrings.liveConversation__keep_audio_in_memory() }}</span><InfoIcon tabindex="0" role="img" :aria-label="lazyStrings.liveConversation__keep_audio_help()" :title="lazyStrings.liveConversation__keep_audio_help()" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400" /></label>
              <label tw-class="flex min-h-9 items-center gap-2"><SettingsChoiceControl presentation="checkbox"><input v-model="muted" type="checkbox" @change="playbackChanged" /></SettingsChoiceControl>{{ lazyStrings.liveConversation__mute_playback() }}</label>
              <label tw-class="flex min-h-9 items-center gap-2"><SettingsChoiceControl presentation="checkbox"><input v-model="hideText" type="checkbox" /></SettingsChoiceControl>{{ lazyStrings.liveConversation__hide_answer_text() }}</label>
            </div>
            <fieldset :disabled="active" tw-class="space-y-3 disabled:opacity-60"><legend tw-class="mb-2 text-xs font-semibold">{{ lazyStrings.liveConversation__session_setup() }}</legend><p v-if="active" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__release_to_change_session_setup() }}</p>
              <label tw-class="block text-xs">{{ lazyStrings.liveConversation__instructions() }}<textarea v-model="instructions" maxlength="16384" rows="2" tw-class="mt-2 w-full rounded-lg border border-gray-200 bg-transparent p-3 text-sm dark:border-gray-700" data-testid="live-instructions" /></label>
              <details><summary tw-class="cursor-pointer text-xs font-medium">{{ lazyStrings.liveConversation__shell_in_browser() }}</summary><label tw-class="my-3 flex min-h-9 items-center gap-2 text-xs"><SettingsChoiceControl presentation="checkbox"><input v-model="tools" type="checkbox" data-testid="live-wesh-enabled" /></SettingsChoiceControl>{{ lazyStrings.liveConversation__allow_shell_tools() }}</label><p tw-class="text-xs leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__wesh_help() }}</p><label tw-class="mt-3 block text-xs">{{ lazyStrings.liveConversation__folder() }}<select v-model="volumeId" :disabled="!tools" tw-class="mt-2 w-full rounded-lg border border-gray-200 bg-white p-2 text-xs dark:border-gray-700 dark:bg-gray-800" data-testid="live-volume"><option value="">{{ lazyStrings.liveConversation__no_folder() }}</option><option v-for="volume in volumes" :key="idToRaw({ id: volume.id })" :value="idToRaw({ id: volume.id })">{{ volume.name }}</option></select></label><button type="button" @click="refreshFolders" tw-class="my-3 text-xs text-blue-600 underline dark:text-blue-400">{{ lazyStrings.liveConversation__refresh_folders() }}</button><p v-if="folderFailure" role="alert" tw-class="break-words text-xs text-red-500">{{ folderFailure }}</p><label tw-class="flex min-h-9 items-center gap-2 text-xs"><SettingsChoiceControl presentation="checkbox"><input v-model="writable" type="checkbox" :disabled="!tools" /></SettingsChoiceControl>{{ lazyStrings.liveConversation__allow_writes() }}</label></details>
            </fieldset>
            <button type="button" :disabled="!active || changingConversation" @click="releaseModel" tw-class="rounded-lg border border-gray-200 px-3 py-2 text-xs hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800" data-testid="live-release">{{ lazyStrings.liveConversation__release_model() }}</button>
          </div>
        </details>
      </section>
      <div v-if="state.failure" role="alert" tw-class="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-900/10 dark:text-red-400"><p>{{ lazyStrings.liveConversation__failed() }}</p><code tw-class="mt-2 block break-words">{{ state.failure }}</code></div>
      <p v-if="audioWarning" role="status" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ audioWarning }}</p>
      <div tw-class="min-w-0 flex-1 py-3">
        <p v-if="!state.entries.length" tw-class="py-8 text-center text-sm leading-7 text-gray-500 dark:text-gray-400" data-testid="live-empty">{{ active ? lazyStrings.liveConversation__ready_to_talk() : lazyStrings.liveConversation__download_then_start() }}</p>
        <LiveConversationHistory ref="history" @replay-start="replayStarted({ element: $event })" @replay-end="replayEnded({ element: $event })" :entries="state.entries" :hide-text="hideText" />
        <section v-if="state.pendingTools.length" tw-class="mt-5 space-y-3 rounded-xl border border-amber-300 p-4 dark:border-amber-700" data-testid="live-tool-approval"><h2 tw-class="text-sm font-semibold">{{ lazyStrings.liveConversation__approval_required() }}</h2><pre v-for="call in state.pendingTools" :key="call.id" tw-class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-3 text-xs dark:bg-gray-800">{{ readLiveShellCall({ call }).shell_script }}</pre><div tw-class="flex flex-wrap gap-2"><button type="button" @click="controller.approve({ decision: 'run' })" tw-class="rounded-lg bg-blue-600 px-3 py-2 text-xs text-white" data-testid="live-tool-run">{{ lazyStrings.liveConversation__approve_commands() }}</button><button type="button" @click="controller.approve({ decision: 'deny' })" tw-class="rounded-lg border border-gray-300 px-3 py-2 text-xs dark:border-gray-600" data-testid="live-tool-deny">{{ lazyStrings.liveConversation__deny_commands() }}</button></div></section>
        <div ref="historyEnd" />
      </div>
      <section v-if="pending.length" tw-class="space-y-3 rounded-xl border border-gray-200/70 bg-gray-50/80 p-3 dark:border-gray-700 dark:bg-gray-800/30" data-testid="live-pending">
        <h2 tw-class="text-xs font-semibold">{{ lazyStrings.liveConversation__pending_messages() }}</h2>
        <article v-for="message in pending" :key="message.id" tw-class="space-y-2 rounded-lg bg-white p-3 dark:bg-gray-800" data-testid="live-pending-message"><div tw-class="flex flex-wrap gap-2 text-[11px] text-gray-500 dark:text-gray-400"><span v-if="message.settings.output !== 'text'">{{ lazyStrings.liveConversation__voice() }}</span><span v-if="message.settings.output !== 'audio'">{{ lazyStrings.liveConversation__answer_text() }}</span></div><label tw-class="block text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__edit_pending_message() }}<textarea :value="message.draft.text" maxlength="32768" rows="2" @input="editPending({ id: message.id, event: $event })" tw-class="mt-1 w-full resize-y border-0 bg-transparent text-sm text-gray-900 outline-none dark:text-gray-100" /></label><p v-for="item in message.draft.images" :key="item.url" tw-class="truncate text-xs text-gray-500">{{ item.file.name }}</p><p v-if="message.draft.audio" tw-class="truncate text-xs text-gray-500">{{ message.draft.audio.file.name }}</p><div tw-class="flex items-center justify-end gap-3"><button v-if="message.status === 'paused'" type="button" @click="composer.retry({ id: message.id })" tw-class="text-xs text-blue-600 dark:text-blue-400">{{ lazyStrings.liveConversation__retry_pending() }}</button><button type="button" @click="composer.cancel({ id: message.id })" :title="lazyStrings.liveConversation__cancel_pending()" tw-class="flex items-center gap-1.5 text-xs text-gray-500 hover:text-red-500"><Trash2Icon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.liveConversation__cancel_pending() }}</button></div></article>
      </section>
      <footer tw-class="sticky bottom-0 space-y-2 bg-[#fcfcfd] pb-3 pt-2 dark:bg-gray-900">
        <p v-if="draftMessage" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ draftMessage }}</p>
        <p v-if="!draftSupported" role="alert" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.liveConversation__draft_channel_disabled() }}</p>
        <p v-if="!outputSelected" role="status" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.liveConversation__choose_output_channel() }}</p>
        <p v-if="state.phase === 'recording'" role="status" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.liveConversation__listening() }}</p>
        <LiveConversationInput ref="input" @replay-start="replayStarted({ element: $event })" @replay-end="replayEnded({ element: $event })" :draft="draft" :text-enabled="textInput" :images-allowed="imageInput && vision" :can-submit="canSubmit" :can-talk="canTalk && draftSupported" :recording="state.phase === 'recording'" :busy="busy" @text="draft = { ...draft, text: $event }" @attach="attach({ files: $event })" @remove="removeAttachment({ url: $event })" @send="send" @talk="talk" @finish="controller.finishRecording()" />
        <p v-if="busy && state.phase !== 'recording'" tw-class="text-center text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__prepare_next_message() }}</p>
      </footer>
    </main>
    <div v-if="dragDepth > 0" tw-class="pointer-events-none fixed inset-4 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-blue-400 bg-white/90 text-sm font-semibold text-blue-600 dark:bg-gray-900/90 dark:text-blue-400" data-testid="live-drop-overlay">{{ lazyStrings.liveConversation__drop_attachments() }}</div>
  </div>
</template>
