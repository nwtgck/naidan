<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, useId, watch } from 'vue';
import { ArrowDownIcon, AudioLinesIcon, DownloadIcon, FolderOpenIcon, InfoIcon, Loader2Icon, MessageSquarePlusIcon, SlidersHorizontalIcon, SquareIcon, Trash2Icon, MicIcon, MicOffIcon, Volume2Icon, VolumeXIcon } from 'lucide-vue-next';
import { currentLocale, ensureStrings, lazyStrings } from '@/strings';
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
import SettingsDisclosure from '@/components/SettingsDisclosure.vue';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import { useLiveHistoryScroll } from '@/features/live-conversation/composables/useLiveHistoryScroll';
import LiveConversationSettingsSurface from './LiveConversationSettingsSurface.vue';
import { useConfirm } from '@/composables/useConfirm';
import { useLiveConversation } from '@/features/live-conversation/composables/useLiveConversation';
import { useLiveSpeechConversation } from '@/features/live-conversation/composables/useLiveSpeechConversation';
import { inspectStoredSpeechModel, openStoredSpeechModel } from '@/features/speech-cpp-browser/models';
import { useLiveModelPreference } from '@/features/live-conversation/composables/useLiveModelPreference';
import { useLiveComposer, type LiveDraft, type LivePendingMessage } from '@/features/live-conversation/composables/useLiveComposer';
import type { LiveTurnSettings } from '@/features/live-conversation/logic/controller';
import { readLiveShellCall } from '@/features/live-conversation/logic/wesh-policy';
import { liveModelCatalog } from '@/features/live-conversation/model-catalog';
import { defaultLiveSpeechLanguage, liveSpeechLanguageOptions } from '@/features/live-conversation/logic/speech-language';
import type { SpeechInputPacing } from '@/features/live-conversation/logic/speech-file-run';
import { registerLiveConversationNavigation, type LiveConversationPanel } from '@/features/live-conversation/navigation';
import LiveConversationInput from './LiveConversationInput.vue';
import LiveConversationHistory from './LiveConversationHistory.vue';
import LiveConversationDiagnostics from './LiveConversationDiagnostics.vue';
import LiveModelLoadProgress from './LiveModelLoadProgress.vue';
import { liveAudioFileLimit } from '@/features/live-conversation/logic/audio-file';

const id = useId();
const props = defineProps<{ panel?: LiveConversationPanel }>();
const emit = defineEmits<{ openConversation: [], openDiagnostics: [] }>();
const panel = computed<LiveConversationPanel>(() => props.panel ?? 'conversation');
const diagnostics = computed(() => panel.value === 'diagnostics');
const input = ref<InstanceType<typeof LiveConversationInput>>();
const history = ref<InstanceType<typeof LiveConversationHistory>>();
const fileView = ref<InstanceType<typeof LiveConversationDiagnostics>>();
const scroll = ref<HTMLElement>();
const historyContent = ref<HTMLElement>();
const settingsOpen = ref(false);
const sourceFile = shallowRef<File>();
const lastRunFile = shallowRef<File>();
const filePending = ref(false);
const invalidSourceFile = ref(false);
const fileOperationFailure = ref<string>();
const tailSeconds = 5;
const fileSeed = ref(0);
const fileInputPacing = ref<SpeechInputPacing>('fast');
const modelLoadMilliseconds = ref<number>();
const { state, controller } = useLiveConversation();
const speech = useLiveSpeechConversation();
const speechState = speech.state;
const selectedEngine = ref<'llama' | 'speech' | 'checking'>('checking');
const residentEngine = ref<'llama' | 'speech'>();
const maxSeconds = ref(120);
// A useful initial choice, not a binding to the UI language. Locale changes
// relabel the options without overwriting the user's conversation language.
const conversationLanguage = ref(defaultLiveSpeechLanguage({ locale: currentLocale.value }));
const conversationLanguageOptions = computed(() => liveSpeechLanguageOptions({ locale: currentLocale.value }));
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
const modelFailure = ref<string>();
const startingModel = ref(false);
const changingConversation = ref(false);
const talkPending = ref(false);
const manualReplay = shallowRef<HTMLAudioElement>();
const dragDepth = ref(0);
let manualSelection = false;
let disposed = false;
let scan: AbortController | undefined;
let inspect: AbortController | undefined;
let modelOpening: AbortController | undefined;
let unsubscribeModels: (() => void) | undefined;
let unregisterNavigation: (() => void) | undefined;
const speechMode = computed(() => residentEngine.value && (active.value || startingModel.value) ? residentEngine.value === 'speech' : selectedEngine.value === 'speech');
const active = computed(() => state.value.phase !== 'idle' || speech.state.value.runtime.model !== undefined);
const idleForTurn = computed(() => state.value.phase === 'ready' && !state.value.playing && !changingConversation.value && !talkPending.value && !manualReplay.value);
const vision = computed(() => !speechMode.value && state.value.info?.vision !== 'unavailable');
const selectedFolder = computed(() => volumes.value.find(volume => idToRaw({ id: volume.id }) === volumeId.value));
const selectedAvailable = computed(() => models.value.some(model => model.modelId === modelId.value));
const outputSelected = computed(() => voiceOutput.value || textOutput.value);
const output = computed<LiveTurnSettings['output']>(() => voiceOutput.value ? textOutput.value ? 'mixed' : 'audio' : 'text');
const speechRunning = computed(() => speech.state.value.capture !== 'closed' || ['starting', 'running', 'stopping'].includes(speech.state.value.runtime.phase));
const busy = computed(() => filePending.value || (speechMode.value ? speechRunning.value : active.value && (state.value.phase !== 'ready' || state.value.playing)));
const selectedRuntimeReady = computed(() => {
  switch (selectedEngine.value) {
  case 'checking': return false;
  case 'speech': return speech.controller.capability.kind === 'available';
  case 'llama': return runtimeReady.value && (!tools.value || !!selectedFolder.value);
  default: {
    const exhaustive: never = selectedEngine.value;
    throw new Error(String(exhaustive));
  }
  }
});
const canStart = computed(() => !active.value && !startingModel.value && !changingConversation.value && selectedAvailable.value && selectedRuntimeReady.value);
const canQueue = computed(() => !speechMode.value && active.value && state.value.phase !== 'closing' && !changingConversation.value);
const canTalk = computed(() => !speechMode.value && active.value && !changingConversation.value && !talkPending.value && !['loading', 'closing', 'stopping', 'preparing-input', 'recording'].includes(state.value.phase) && microphone.value && outputSelected.value);
const canReset = computed(() => !startingModel.value && !changingConversation.value && !['loading', 'closing', 'stopping'].includes(state.value.phase) && !['loading_model', 'starting', 'stopping'].includes(speech.state.value.runtime.phase));
const settings = computed<LiveTurnSettings>(() => ({ output: output.value, transcription: transcription.value ? 'on' : 'off' }));
const composer = useLiveComposer({ canProcess: () => idleForTurn.value, deliver });
const { draft, pending, failure: draftFailure, held } = composer;
const historyScroll = useLiveHistoryScroll({ viewport: scroll, content: historyContent, revision: () => [state.value.entries, pending.value, state.value.pendingTools, speech.state.value.sessions], enabled: () => active.value });
const headerModel = computed(() => {
  const value = active.value ? residentModelId.value : modelId.value;
  return value.split('/').at(-1) || value;
});
const draftSupported = computed(() => (!draft.value.images.length || (imageInput.value && vision.value)) && (!draft.value.text.trim() || textInput.value));
const canSubmit = computed(() => canQueue.value && outputSelected.value && composer.hasDraft.value && draftSupported.value);
const navigationBusy = computed(() => busy.value || startingModel.value || changingConversation.value);
const canLoadSelectedModel = computed(() => !navigationBusy.value && selectedAvailable.value && selectedRuntimeReady.value && (!active.value || residentModelId.value !== modelId.value));
const fileRun = computed(() => sourceFile.value !== undefined && lastRunFile.value === sourceFile.value ? speechState.value.fileRun : undefined);
const fileText = computed(() => fileRun.value?.text ?? '');
const fileSelectionFailure = computed(() => invalidSourceFile.value ? lazyStrings.liveConversation__audio_file_limits() : fileOperationFailure.value ?? speechState.value.failure?.message);
const validDuration = computed(() => Number.isFinite(maxSeconds.value) && maxSeconds.value > 0 && maxSeconds.value <= 3600);
const validFileSeed = computed(() => Number.isSafeInteger(fileSeed.value) && fileSeed.value >= 0);
const canGenerateFile = computed(() => speechMode.value && active.value && speech.controller.capability.kind === 'available' && !navigationBusy.value && ['ready', 'completed'].includes(speechState.value.runtime.phase) && validDuration.value && validFileSeed.value);
const effectiveTextInput = computed({
  get: () => !speechMode.value && textInput.value,
  set: value => {
    textInput.value = value;
  },
});
const effectiveImageInput = computed({
  get: () => !speechMode.value && imageInput.value,
  set: value => {
    imageInput.value = value;
  },
});
const effectiveTranscription = computed({
  get: () => !speechMode.value && transcription.value,
  set: value => {
    transcription.value = value;
  },
});
const effectiveTools = computed({
  get: () => !speechMode.value && tools.value,
  set: value => {
    tools.value = value;
  },
});
const effectiveVoiceOutput = computed({
  get: () => speechMode.value || voiceOutput.value,
  set: value => {
    voiceOutput.value = value;
  },
});
const effectiveTextOutput = computed({
  get: () => speechMode.value || textOutput.value,
  set: value => {
    textOutput.value = value;
  },
});
const speechUnavailable = computed(() => {
  const capability = speech.controller.capability;
  switch (capability.kind) {
  case 'available': return undefined;
  case 'unavailable':
    switch (capability.reason) {
    case 'artifact_unavailable': return lazyStrings.liveConversation__speech_sdk_not_available();
    case 'standalone': return lazyStrings.liveConversation__speech_requires_hosted_version();
    case 'worker_unavailable': case 'webgpu_unavailable': case 'memory64_unavailable': case 'jspi_unavailable': return lazyStrings.liveConversation__speech_runtime_unavailable();
    default: {
      const exhaustive: never = capability.reason;
      throw new Error(String(exhaustive));
    }
    }
  default: {
    const exhaustive: never = capability;
    throw new Error(String(exhaustive));
  }
  }
});
const speechWarning = computed(() => {
  switch (speech.state.value.warning) {
  case 'input-backpressure': return lazyStrings.liveConversation__input_audio_cannot_keep_up();
  case 'output-backpressure': return lazyStrings.liveConversation__output_audio_cannot_keep_up();
  case undefined: return undefined;
  default: {
    const exhaustive: never = speech.state.value.warning;
    throw new Error(String(exhaustive));
  }
  }
});
const fileUnavailable = computed(() => {
  if (!speechMode.value) {
    return lazyStrings.liveConversation__audio_file_generation_unavailable();
  }
  if (speechUnavailable.value) {
    return speechUnavailable.value;
  }
  if (!active.value) {
    return lazyStrings.liveConversation__load_model_to_generate();
  }
  if (!validDuration.value) {
    return lazyStrings.liveConversation__choose_a_valid_session_duration();
  }
  if (!validFileSeed.value) {
    return lazyStrings.liveConversation__choose_a_valid_seed();
  }
  return undefined;
});

const status = computed(() => {
  if (speechMode.value) {
    switch (speech.state.value.capture) {
    case 'opening': return lazyStrings.liveConversation__preparing_audio();
    case 'closed': case 'open': break;
    default: {
      const exhaustive: never = speech.state.value.capture;
      throw new Error(String(exhaustive));
    }
    }
    switch (speech.state.value.runtime.phase) {
    case 'unloaded': case 'disposed': return lazyStrings.liveConversation__idle();
    case 'loading_model': return lazyStrings.liveConversation__loading();
    case 'ready': return lazyStrings.liveConversation__ready();
    case 'starting': return lazyStrings.liveConversation__preparing_audio();
    case 'running': return lazyStrings.liveConversation__continuous_conversation_running();
    case 'stopping': return lazyStrings.liveConversation__stopping();
    case 'completed':
      switch (speech.state.value.runtime.completion) {
      case 'max_seconds': return lazyStrings.liveConversation__conversation_time_limit_reached();
      case 'finished': case 'cancelled': case undefined: return lazyStrings.liveConversation__conversation_stopped();
      default: {
        const exhaustive: never = speech.state.value.runtime.completion;
        throw new Error(String(exhaustive));
      }
      }
    case 'failed': return lazyStrings.liveConversation__failed();
    default: {
      const exhaustive: never = speech.state.value.runtime.phase;
      throw new Error(String(exhaustive));
    }
    }
  }
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
const speechAudioWarning = computed(() => {
  const warning = speechState.value.audioWarning;
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

watch([modelId, models], async ([value]) => {
  inspect?.abort();
  const current = new AbortController();
  inspect = current;
  selectedEngine.value = 'checking';
  if (!value) {
    selectedEngine.value = 'llama';
    return;
  }
  try {
    const result = await inspectStoredSpeechModel({ modelId: value, signal: current.signal });
    if (!disposed && inspect === current) {
      modelFailure.value = undefined;
      switch (result.kind) {
      case 'speech': selectedEngine.value = 'speech';
        break;
      case 'other': selectedEngine.value = 'llama';
        break;
      default: {
        const exhaustive: never = result;
        throw new Error(String(exhaustive));
      }
      }
    }
  } catch (error) {
    if (!disposed && !current.signal.aborted) {
      inventoryFailure.value = true;
      modelFailure.value = error instanceof Error ? error.message : String(error);
    }
  }
}, { immediate: true });

watch(microphone, value => {
  speech.controller.muteMicrophone({ value: value ? 'on' : 'off' });
});

watch([active, startingModel], ([resident, starting]) => {
  if (!resident && !starting) {
    residentEngine.value = undefined;
    residentModelId.value = '';
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

function replayConversationAudio({ event, action }: { event: Event, action: 'start' | 'end' }): void {
  if (!(event.target instanceof HTMLAudioElement)) {
    return;
  }
  switch (action) {
  case 'start':
    if (speechRunning.value) {
      event.target.pause();
      return;
    }
    replayStarted({ element: event.target });
    break;
  case 'end': replayEnded({ element: event.target });
    break;
  default: {
    const exhaustive: never = action;
    throw new Error(String(exhaustive));
  }
  }
}

function pauseReplays(): void {
  manualReplay.value?.pause();
  manualReplay.value = undefined;
  input.value?.pauseAudio();
  history.value?.pauseAudio();
  fileView.value?.pauseAudio();
}

function removeAttachment({ url }: { url: string }): void {
  if (draft.value.audio?.url === url) {
    pauseReplays();
  }
  composer.remove({ url });
}

function attach({ files }: { files: File[] }): void {
  if (diagnostics.value) {
    selectAudioFile({ files });
    return;
  }
  if (speechMode.value) {
    return;
  }
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
    if (diagnostics.value ? !navigationBusy.value : !speechMode.value) {
      dragDepth.value++;
    }
  }
}

function dragOver({ event }: { event: DragEvent }): void {
  if (event.dataTransfer?.types.includes('Files')) {
    event.preventDefault();
    event.dataTransfer.dropEffect = diagnostics.value ? navigationBusy.value ? 'none' : 'copy' : speechMode.value ? 'none' : 'copy';
  }
}

function dragLeave(): void {
  dragDepth.value = Math.max(0, dragDepth.value - 1);
}

async function start(): Promise<void> {
  if (!canStart.value) {
    return;
  }
  pauseReplays();
  applyAudioRetention();
  settingsOpen.value = false;
  const selected = modelId.value;
  selectModel({ value: selected });
  residentModelId.value = selected;
  if (speechMode.value) {
    residentEngine.value = 'speech';
    startingModel.value = true;
    modelFailure.value = undefined;
    modelLoadMilliseconds.value = undefined;
    const current = new AbortController();
    modelOpening = current;
    try {
      const file = await openStoredSpeechModel({ modelId: selected, signal: current.signal });
      current.signal.throwIfAborted();
      const loadStarted = performance.now();
      await speech.controller.load({ file });
      current.signal.throwIfAborted();
      if (speech.state.value.runtime.model) {
        modelLoadMilliseconds.value = performance.now() - loadStarted;
      }
      speech.controller.mutePlayback({ value: muted.value ? 'off' : 'on' });
    } catch (error) {
      if (!current.signal.aborted && !disposed) {
        modelFailure.value = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (modelOpening === current) {
        startingModel.value = false;
        modelOpening = undefined;
        if (!active.value) {
          residentEngine.value = undefined;
          residentModelId.value = '';
        }
      }
    }
    return;
  }
  residentEngine.value = 'llama';
  const folder = selectedFolder.value;
  await controller.open({ modelId: selected, instructions: instructions.value, folder: tools.value && folder ? { volumeId: folder.id, access: writable.value ? 'read-write' : 'read-only' } : undefined });
  controller.mute({ value: muted.value ? 'off' : 'on' });
  if (!active.value) {
    residentModelId.value = '';
    residentEngine.value = undefined;
  }
}

async function deliver({ message }: { message: LivePendingMessage }): Promise<'accepted' | 'rejected'> {
  pauseReplays();
  applyAudioRetention();
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
  applyAudioRetention();
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
  changingConversation.value = true;
  held.value = true;
  try {
    if (state.value.entries.length || speech.state.value.sessions.length || speech.state.value.fileRun || sourceFile.value || pending.value.length || composer.hasDraft.value || busy.value) {
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
    if (speechMode.value) {
      await speech.controller.reset();
      await controller.reset();
      composer.clear();
      await clearAudioFile();
      historyScroll.toLatest();
      return;
    }
    await controller.interrupt();
    if (disposed) {
      return;
    }
    await controller.reset();
    await speech.controller.reset();
    composer.clear();
    await clearAudioFile();
    historyScroll.toLatest();
  } finally {
    changingConversation.value = false;
    held.value = false;
  }
}

async function releaseModel(): Promise<void> {
  if ((!active.value && !startingModel.value) || changingConversation.value) {
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
    modelOpening?.abort();
    if (speechMode.value) {
      await speech.controller.release();
    } else {
      await controller.close();
    }
    for (const message of pending.value) {
      composer.cancel({ id: message.id });
    }
    residentModelId.value = '';
    residentEngine.value = undefined;
    settingsOpen.value = false;
  } finally {
    changingConversation.value = false;
    held.value = false;
  }
}

async function cancelModelLoading(): Promise<void> {
  if (!startingModel.value || changingConversation.value) {
    return;
  }
  const current = modelOpening;
  current?.abort();
  changingConversation.value = true;
  try {
    await speech.controller.release();
  } finally {
    if (modelOpening === current) {
      modelOpening = undefined;
      startingModel.value = false;
      residentEngine.value = undefined;
      residentModelId.value = '';
    }
    changingConversation.value = false;
  }
}

function playbackChanged(): void {
  if (!muted.value) {
    pauseReplays();
  }
  controller.mute({ value: muted.value ? 'off' : 'on' });
  speech.controller.mutePlayback({ value: muted.value ? 'off' : 'on' });
}

function togglePlayback(): void {
  muted.value = !muted.value;
  playbackChanged();
}

function retentionChanged(): void {
  pauseReplays();
  applyAudioRetention();
}

function applyAudioRetention(): void {
  controller.retainAudio({ value: keepAudio.value ? 'on' : 'off' });
  speech.controller.retainAudio({ value: keepAudio.value ? 'on' : 'off' });
}

async function startSpeech(): Promise<void> {
  if (!active.value || !speechMode.value || speechRunning.value || changingConversation.value || !Number.isFinite(maxSeconds.value) || maxSeconds.value <= 0 || maxSeconds.value > 3600) {
    return;
  }
  pauseReplays();
  applyAudioRetention();
  speech.controller.muteMicrophone({ value: microphone.value ? 'on' : 'off' });
  speech.controller.mutePlayback({ value: muted.value ? 'off' : 'on' });
  await speech.controller.start({ maxSeconds: maxSeconds.value, language: conversationLanguage.value, persona: instructions.value || undefined, name: undefined });
}

function editPending({ id, event }: { id: string, event: Event }): void {
  if (event.target instanceof HTMLTextAreaElement) {
    composer.edit({ id, text: event.target.value });
  }
}

function selectAudioFile({ files }: { files: File[] }): void {
  if (navigationBusy.value) {
    return;
  }
  const file = files[0];
  if (files.length !== 1 || !file || file.size === 0 || file.size > liveAudioFileLimit || !(file.type.startsWith('audio/') || /\.(wav|mp3|flac|ogg|m4a|aac|webm)$/i.test(file.name))) {
    invalidSourceFile.value = true;
    return;
  }
  pauseReplays();
  sourceFile.value = file;
  invalidSourceFile.value = false;
  fileOperationFailure.value = undefined;
}

async function clearAudioFile(): Promise<void> {
  if (filePending.value) {
    return;
  }
  pauseReplays();
  sourceFile.value = undefined;
  lastRunFile.value = undefined;
  invalidSourceFile.value = false;
  fileOperationFailure.value = undefined;
  await speech.controller.clearFileRun();
}

async function generateFile(): Promise<void> {
  const file = sourceFile.value;
  if (!file || !canGenerateFile.value) {
    return;
  }
  pauseReplays();
  filePending.value = true;
  lastRunFile.value = file;
  fileOperationFailure.value = undefined;
  try {
    await speech.controller.runFile({ file, maxSeconds: maxSeconds.value, language: conversationLanguage.value, persona: instructions.value || undefined, name: undefined, tailSeconds, seed: fileSeed.value, inputPacing: fileInputPacing.value });
  } catch (error) {
    fileOperationFailure.value = error instanceof Error ? error.message : String(error);
  } finally {
    filePending.value = false;
  }
}

async function loadSelectedModel(): Promise<void> {
  if (!canLoadSelectedModel.value) {
    return;
  }
  changingConversation.value = true;
  try {
    pauseReplays();
    if (active.value) {
      if (speechMode.value) {
        await speech.controller.release();
      } else {
        await controller.close();
      }
      if (active.value) {
        return;
      }
      residentEngine.value = undefined;
      residentModelId.value = '';
    }
  } finally {
    changingConversation.value = false;
  }
  if (!disposed) {
    await start();
  }
}

watch(diagnostics, async () => {
  pauseReplays();
  if (filePending.value || speechRunning.value) {
    await speech.controller.stop({ mode: 'cancel' });
  }
  if (state.value.phase !== 'idle' && state.value.phase !== 'ready') {
    await controller.interrupt();
  }
});

onMounted(() => {
  unregisterNavigation = registerLiveConversationNavigation({
    navigation: {
      panel,
      modelName: headerModel,
      fileName: computed(() => sourceFile.value?.name),
      busy: navigationBusy,
      canReset,
      newConversation,
      openConversation: () => emit('openConversation'),
      openDiagnostics: () => emit('openDiagnostics'),
      openSettings: () => {
        settingsOpen.value = true;
      },
    },
  });
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
  inspect?.abort();
  modelOpening?.abort();
  unsubscribeModels?.();
  unregisterNavigation?.();
  pauseReplays();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <!-- Only the message viewport scrolls. Header and composer are siblings, not
       sticky children of a document scroller. Existing Naidan sidebar is untouched. -->
  <div :inert="settingsOpen ? true : undefined" @dragenter="dragEnter({ event: $event })" @dragover="dragOver({ event: $event })" @dragleave="dragLeave" @drop="drop({ event: $event })" tw-class="absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden bg-[#fcfcfd] text-gray-900 dark:bg-gray-900 dark:text-gray-100" data-testid="live-conversation-page">
    <header tw-class="z-20 shrink-0 border-b border-gray-200/70 bg-white/80 px-4 py-1.5 backdrop-blur-md dark:border-gray-800 dark:bg-gray-900/80 sm:px-6" data-testid="live-header">
      <div tw-class="mx-auto flex w-full max-w-4xl items-center gap-2 sm:gap-3">
        <AudioLinesIcon aria-hidden="true" tw-class="hidden h-4 w-4 shrink-0 text-gray-400 sm:block" />
        <div tw-class="min-w-0 flex-1">
          <h1 tw-class="text-sm font-medium leading-5 text-gray-800 dark:text-gray-100">{{ diagnostics ? lazyStrings.liveConversation__diagnostics() : lazyStrings.liveConversation__live_conversation() }}</h1>
          <button type="button" @click="settingsOpen = true" aria-haspopup="dialog" :title="active ? residentModelId : modelId" tw-class="block max-w-full truncate rounded text-left text-[11px] leading-5 text-gray-500 hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:text-gray-400 dark:hover:text-blue-400" data-testid="live-header-model">{{ headerModel || lazyStrings.liveConversation__choose_model() }}</button>
        </div>
        <button type="button" :disabled="!canReset" @click="newConversation" :title="lazyStrings.liveConversation__new_conversation()" :aria-label="lazyStrings.liveConversation__new_conversation()" tw-class="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-gray-500 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800" data-testid="live-new-conversation"><MessageSquarePlusIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
        <button type="button" @click="settingsOpen = true" aria-haspopup="dialog" :aria-expanded="settingsOpen" :aria-label="lazyStrings.liveConversation__conversation_settings()" :title="lazyStrings.liveConversation__conversation_settings()" tw-class="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-gray-500 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:text-gray-400 dark:hover:bg-gray-800" data-testid="live-open-settings"><SlidersHorizontalIcon aria-hidden="true" tw-class="h-5 w-5" /></button>
      </div>
    </header>
    <main ref="scroll" @scroll="historyScroll.rememberScroll" tabindex="0" :aria-label="lazyStrings.liveConversation__conversation()" tw-class="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain outline-none [overflow-anchor:none]" data-testid="live-message-scroll">
      <div ref="historyContent" tw-class="mx-auto w-full max-w-4xl space-y-5 px-4 py-5 sm:px-6" data-testid="live-history-content">
        <LiveConversationSettingsSurface :open="settingsOpen" :onboarding="!active && !diagnostics" @close="settingsOpen = false">
          <div tw-class="space-y-5">
            <div tw-class="space-y-2"><label :for="`${id}-model`" tw-class="block text-sm font-medium">{{ lazyStrings.liveConversation__model() }}</label><ModelSelector surface="settings" :input-id="`${id}-model`" :model-value="modelId || undefined" :models="models.map(model => model.modelId)" :loading="false" :disabled="changingConversation || startingModel" :placeholder="lazyStrings.liveConversation__choose_model()" @update:model-value="selectModel({ value: $event })" @refresh="refreshInventory" data-testid="live-model" /></div>
            <p v-if="active" tw-class="break-all text-[11px] text-gray-500 dark:text-gray-400" data-testid="live-loaded-model">{{ lazyStrings.liveConversation__loaded_model({ name: residentModelId }) }}</p>
            <p v-if="active && modelId !== residentModelId" tw-class="text-xs leading-5 text-amber-700 dark:text-amber-300" data-testid="live-next-model">{{ lazyStrings.liveConversation__load_selected_model_to_switch() }}</p>
            <p v-if="preferenceFailure" role="alert" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.liveConversation__model_preference_failed() }}</p>
            <p v-if="inventoryFailure" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.liveConversation__model_inventory_failed() }}</p>
            <p v-if="modelFailure" role="alert" tw-class="break-words text-xs text-red-600 dark:text-red-400" data-testid="live-model-failure">{{ modelFailure }}</p>
            <p v-if="speechMode" tw-class="text-xs leading-6 text-gray-500 dark:text-gray-400" data-testid="live-speech-help">{{ lazyStrings.liveConversation__continuous_conversation_help() }}</p>
            <p v-if="(speechMode || selectedEngine === 'speech') && speechUnavailable" role="status" tw-class="text-xs leading-6 text-amber-700 dark:text-amber-300" data-testid="live-speech-unavailable">{{ speechUnavailable }}</p>
            <LlamaCppBrowserModelSuggestions :suggestions="liveModelCatalog" :models="models" :disabled="false" :default-model="undefined" :default-action-disabled="changingConversation" selection-action="select" memory-filter="hide" @select="catalogSelect({ model: $event })" @changed="refreshInventory" />
            <SettingsDisclosure :title="lazyStrings.liveConversation__manage_models_and_runtime()" test-id="live-model-manager">
              <template #icon><FolderOpenIcon tw-class="h-4 w-4" /></template>
              <div tw-class="space-y-4"><p tw-class="text-xs leading-6 text-gray-500 dark:text-gray-400">{{ selectedEngine === 'speech' ? lazyStrings.liveConversation__speech_model_setup() : lazyStrings.liveConversation__model_setup() }}</p><LlamaCppBrowserManager presentation="embedded" suggestions="none" :runtime-settings="selectedEngine === 'llama' ? 'show' : 'hide'" :suspended="active || startingModel" @models-changed="updateModels({ entries: $event })" @model-selected="selectModel({ value: $event })" @runtime-ready="runtimeReady = $event" /></div>
            </SettingsDisclosure>
            <button v-if="!active && !startingModel" type="button" :disabled="!canStart || changingConversation" @click="start" tw-class="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40" data-testid="live-start">{{ speechMode ? lazyStrings.liveConversation__load_model() : lazyStrings.liveConversation__start_session() }}</button>
            <button v-if="active && modelId !== residentModelId" type="button" :disabled="!canLoadSelectedModel" @click="loadSelectedModel" tw-class="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40" data-testid="live-load-model">{{ lazyStrings.liveConversation__load_model() }}</button>
            <div v-if="startingModel" tw-class="space-y-3" data-testid="live-model-loading"><LiveModelLoadProgress :progress="speechState.runtime.loadProgress" /><button type="button" :disabled="changingConversation" @click="cancelModelLoading" tw-class="rounded-lg px-3 py-2 text-xs text-gray-600 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-800" data-testid="live-cancel-model-loading">{{ lazyStrings.liveConversation__cancel_model_loading() }}</button></div>
            <SettingsDisclosure :title="lazyStrings.liveConversation__channels_and_playback()" test-id="live-channel-settings">
              <template #icon><SlidersHorizontalIcon tw-class="h-4 w-4" /></template>
              <label v-if="speechMode" tw-class="mb-4 block text-xs">{{ lazyStrings.liveConversation__maximum_session_seconds() }}<input v-model.number="maxSeconds" type="number" min="1" max="3600" :disabled="speechRunning || filePending" tw-class="mt-2 block w-32 rounded-lg border border-gray-200 bg-transparent p-2 text-sm disabled:opacity-40 dark:border-gray-700" data-testid="live-speech-max-seconds" /></label>
              <div tw-class="space-y-5"><fieldset tw-class="space-y-2"><legend tw-class="mb-2 text-xs font-semibold">{{ lazyStrings.liveConversation__input_channels() }}</legend><div tw-class="flex flex-wrap gap-4 text-xs"><label tw-class="flex min-h-9 items-center gap-2"><SettingsChoiceControl presentation="checkbox"><input v-model="microphone" type="checkbox" /></SettingsChoiceControl>{{ lazyStrings.liveConversation__microphone() }}</label><label tw-class="flex min-h-9 items-center gap-2"><SettingsChoiceControl presentation="checkbox"><input v-model="effectiveTextInput" type="checkbox" data-testid="live-input-text-enabled" :disabled="speechMode" /></SettingsChoiceControl>{{ lazyStrings.liveConversation__text_input() }}</label><label tw-class="flex min-h-9 items-center gap-2"><SettingsChoiceControl presentation="checkbox"><input v-model="effectiveImageInput" type="checkbox" data-testid="live-input-images-enabled" :disabled="!vision" /></SettingsChoiceControl>{{ lazyStrings.liveConversation__images() }}</label></div></fieldset>
                <fieldset tw-class="space-y-2"><legend tw-class="mb-2 flex items-center gap-2 text-xs font-semibold">{{ lazyStrings.liveConversation__output_channels() }}<InfoIcon tabindex="0" role="img" :aria-label="lazyStrings.liveConversation__channels_help()" :title="lazyStrings.liveConversation__channels_help()" tw-class="h-3.5 w-3.5 text-gray-400" /></legend><div tw-class="flex flex-wrap gap-4 text-xs"><label tw-class="flex min-h-9 items-center gap-2"><SettingsChoiceControl presentation="checkbox"><input v-model="effectiveVoiceOutput" type="checkbox" :disabled="speechMode" data-testid="live-output-voice" /></SettingsChoiceControl>{{ lazyStrings.liveConversation__voice() }}</label><label tw-class="flex min-h-9 items-center gap-2"><SettingsChoiceControl presentation="checkbox"><input v-model="effectiveTextOutput" type="checkbox" :disabled="speechMode" data-testid="live-output-text" /></SettingsChoiceControl>{{ lazyStrings.liveConversation__answer_text() }}</label></div></fieldset>
                <div tw-class="space-y-3 text-xs">
                  <label tw-class="flex min-h-9 items-center gap-2"><SettingsChoiceControl presentation="checkbox"><input v-model="effectiveTranscription" type="checkbox" :disabled="speechMode" data-testid="live-transcription" /></SettingsChoiceControl><span>{{ lazyStrings.liveConversation__transcribe_my_audio() }}</span><InfoIcon tabindex="0" role="img" :aria-label="lazyStrings.liveConversation__transcription_cost()" :title="lazyStrings.liveConversation__transcription_cost()" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400" /></label>
                  <label tw-class="flex min-h-9 items-center gap-2"><SettingsChoiceControl presentation="checkbox"><input v-model="keepAudio" type="checkbox" :disabled="speechMode && speechRunning && !filePending && !keepAudio" @change="retentionChanged" data-testid="live-keep-audio" /></SettingsChoiceControl><span>{{ lazyStrings.liveConversation__keep_audio_in_memory() }}</span><InfoIcon tabindex="0" role="img" :aria-label="lazyStrings.liveConversation__keep_audio_help()" :title="lazyStrings.liveConversation__keep_audio_help()" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400" /></label>
                  <label tw-class="flex min-h-9 items-center gap-2"><SettingsChoiceControl presentation="checkbox"><input v-model="muted" type="checkbox" @change="playbackChanged" /></SettingsChoiceControl>{{ lazyStrings.liveConversation__mute_playback() }}</label>
                  <label tw-class="flex min-h-9 items-center gap-2"><SettingsChoiceControl presentation="checkbox"><input v-model="hideText" type="checkbox" /></SettingsChoiceControl>{{ lazyStrings.liveConversation__hide_answer_text() }}</label>
                </div></div>
            </SettingsDisclosure>
            <SettingsDisclosure :title="lazyStrings.liveConversation__session_setup()" test-id="live-session-settings">
              <fieldset :disabled="speechMode ? speechRunning || startingModel || filePending : active" tw-class="space-y-3 disabled:opacity-60"><p v-if="active && !speechMode" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__release_to_change_session_setup() }}</p>
                <div v-if="speechMode" tw-class="space-y-2"><label :for="`${id}-language`" tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__conversation_language() }}</label><span tw-class="block w-full sm:max-w-xs"><SettingsFormSelect :id="`${id}-language`" v-model="conversationLanguage" :options="conversationLanguageOptions" :label="lazyStrings.liveConversation__conversation_language()" :disabled="speechRunning || startingModel || filePending" :aria-describedby="`${id}-language-help`" data-testid="live-speech-language" /></span><p :id="`${id}-language-help`" data-testid="live-speech-language-help" tw-class="text-xs leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__conversation_language_help() }}</p></div>
                <label tw-class="block text-xs">{{ lazyStrings.liveConversation__instructions() }}<textarea v-model="instructions" maxlength="16384" rows="2" tw-class="mt-2 w-full rounded-lg border border-gray-200 bg-transparent p-3 text-sm dark:border-gray-700" data-testid="live-instructions" /></label>
                <details><summary tw-class="cursor-pointer text-xs font-medium">{{ lazyStrings.liveConversation__shell_in_browser() }}</summary><label tw-class="my-3 flex min-h-9 items-center gap-2 text-xs"><SettingsChoiceControl presentation="checkbox"><input v-model="effectiveTools" type="checkbox" :disabled="speechMode" data-testid="live-wesh-enabled" /></SettingsChoiceControl>{{ lazyStrings.liveConversation__allow_shell_tools() }}</label><p tw-class="text-xs leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__wesh_help() }}</p><label tw-class="mt-3 block text-xs">{{ lazyStrings.liveConversation__folder() }}<select v-model="volumeId" :disabled="speechMode || !tools" tw-class="mt-2 w-full rounded-lg border border-gray-200 bg-white p-2 text-xs dark:border-gray-700 dark:bg-gray-800" data-testid="live-volume"><option value="">{{ lazyStrings.liveConversation__no_folder() }}</option><option v-for="volume in volumes" :key="idToRaw({ id: volume.id })" :value="idToRaw({ id: volume.id })">{{ volume.name }}</option></select></label><button type="button" @click="refreshFolders" tw-class="my-3 text-xs text-blue-600 underline dark:text-blue-400">{{ lazyStrings.liveConversation__refresh_folders() }}</button><p v-if="folderFailure" role="alert" tw-class="break-words text-xs text-red-500">{{ folderFailure }}</p><label tw-class="flex min-h-9 items-center gap-2 text-xs"><SettingsChoiceControl presentation="checkbox"><input v-model="writable" type="checkbox" :disabled="speechMode || !tools" /></SettingsChoiceControl>{{ lazyStrings.liveConversation__allow_writes() }}</label></details>
              </fieldset>
            </SettingsDisclosure>
            <button type="button" :disabled="(!active && !startingModel) || changingConversation" @click="releaseModel" tw-class="rounded-lg border border-gray-200 px-3 py-2 text-xs hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800" data-testid="live-release">{{ lazyStrings.liveConversation__release_model() }}</button>
            <p tw-class="text-[11px] leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__ephemeral_session() }}</p>
          </div>
        </LiveConversationSettingsSurface>
        <LiveConversationDiagnostics v-if="diagnostics" ref="fileView" :file="sourceFile" :run="fileRun" :text="fileText" :busy="filePending" :blocked="navigationBusy && !filePending" :can-generate="canGenerateFile" :unavailable="fileUnavailable" :selection-failure="fileSelectionFailure" :tail-seconds="tailSeconds" :seed="fileSeed" :input-pacing="fileInputPacing" :queued-samples="speechState.runtime.queuedSamples" :model-load-milliseconds="modelLoadMilliseconds" @seed="fileSeed = $event" @input-pacing="fileInputPacing = $event" @select="selectAudioFile({ files: $event })" @generate="generateFile" @cancel="speech.controller.stop({ mode: 'cancel' })" @clear="clearAudioFile" @settings="settingsOpen = true" @replay-start="replayStarted({ element: $event })" @replay-end="replayEnded({ element: $event })" >
          <template #model><div tw-class="space-y-3 rounded-xl border border-gray-200/70 bg-white/70 p-4 dark:border-gray-800 dark:bg-gray-900/40"><label :for="`${id}-diagnostic-model`" tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__model() }}</label><ModelSelector surface="settings" :input-id="`${id}-diagnostic-model`" :model-value="modelId || undefined" :models="models.map(model => model.modelId)" :loading="selectedEngine === 'checking'" :disabled="navigationBusy" :placeholder="lazyStrings.liveConversation__choose_model()" @update:model-value="selectModel({ value: $event })" @refresh="refreshInventory" data-testid="live-diagnostics-model" /><div tw-class="flex flex-wrap items-center gap-3"><button type="button" :disabled="!canLoadSelectedModel" @click="loadSelectedModel" tw-class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300 dark:hover:bg-gray-800" data-testid="live-diagnostics-load-model">{{ lazyStrings.liveConversation__load_model() }}</button><span v-if="active" data-testid="live-diagnostics-resident-model" tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__loaded_model({ name: residentModelId }) }}</span><button v-if="startingModel" type="button" @click="cancelModelLoading" data-testid="live-diagnostics-cancel-model" tw-class="rounded text-xs text-blue-600 underline dark:text-blue-400">{{ lazyStrings.liveConversation__cancel_model_loading() }}</button></div><LiveModelLoadProgress v-if="startingModel" :progress="speechState.runtime.loadProgress" /><p v-if="modelFailure" role="alert" tw-class="break-words text-xs text-red-600 dark:text-red-400">{{ modelFailure }}</p></div></template>
          <template #settings><div tw-class="space-y-2"><label :for="`${id}-diagnostic-language`" tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__conversation_language() }}</label><span tw-class="block w-full sm:max-w-xs"><SettingsFormSelect :id="`${id}-diagnostic-language`" v-model="conversationLanguage" :options="conversationLanguageOptions" :label="lazyStrings.liveConversation__conversation_language()" :disabled="navigationBusy" :aria-describedby="`${id}-diagnostic-language-help`" data-testid="live-diagnostics-language" /></span><p :id="`${id}-diagnostic-language-help`" data-testid="live-diagnostics-language-help" tw-class="text-xs leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__conversation_language_help() }}</p></div><label tw-class="block space-y-2 text-xs font-medium text-gray-600 dark:text-gray-300"><span>{{ lazyStrings.liveConversation__instructions() }}</span><textarea v-model="instructions" :disabled="navigationBusy" rows="2" maxlength="16384" tw-class="block w-full rounded-lg border border-gray-200 bg-transparent p-3 text-sm disabled:opacity-40 dark:border-gray-700" data-testid="live-diagnostics-instructions" /></label></template>
        </LiveConversationDiagnostics>
        <div v-if="!diagnostics && speechState.failure" role="alert" tw-class="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-900/10 dark:text-red-400" data-testid="live-speech-failure"><p>{{ lazyStrings.liveConversation__continuous_conversation() }} · {{ lazyStrings.liveConversation__failed() }}</p><code tw-class="mt-2 block whitespace-pre-wrap break-words">{{ speechState.failure.message }}<template v-if="speechState.failure.nativeStatus !== undefined">{{ '\n' }}{{ speechState.failure.nativeStatus }}</template><template v-if="speechState.failure.nativeInput !== undefined">{{ '\n' }}{{ speechState.failure.nativeInput }}</template></code></div>
        <p v-if="!diagnostics && speechAudioWarning" role="status" tw-class="text-xs leading-6 text-amber-700 dark:text-amber-300" data-testid="live-speech-audio-warning">{{ speechAudioWarning }}</p>
        <p v-if="!diagnostics && speechWarning" role="alert" tw-class="text-xs leading-6 text-amber-700 dark:text-amber-300" data-testid="live-speech-warning">{{ speechWarning }}</p>
        <section v-if="!diagnostics && (speechMode || speechState.sessions.length)" :aria-label="lazyStrings.liveConversation__conversation()" tw-class="space-y-6" data-testid="live-speech-history">
          <p v-if="!speechState.sessions.length && active" tw-class="py-8 text-center text-sm leading-7 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__ready_for_continuous_conversation() }}</p>
          <article v-for="session in speechState.sessions" :key="session.id" tw-class="space-y-4 rounded-xl border border-gray-200/70 bg-white/70 p-4 dark:border-gray-800/80 dark:bg-gray-900/40" data-testid="live-speech-session">
            <div tw-class="flex flex-wrap items-center gap-x-3 gap-y-1"><h2 tw-class="flex min-w-0 items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-100"><AudioLinesIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500" /><span tw-class="min-w-0 break-all">{{ session.modelName }}</span></h2><span tw-class="text-[11px] text-gray-400 dark:text-gray-500">{{ lazyStrings.liveConversation__continuous_audio_session() }}</span></div>
            <p v-if="!hideText" tw-class="whitespace-pre-wrap break-words text-sm leading-7" data-testid="live-speech-text">{{ session.text }}</p>
            <details v-if="session.inputAudio || session.outputAudio" tw-class="rounded-xl border border-gray-200/70 p-3 text-xs dark:border-gray-800" data-testid="live-speech-retained-audio">
              <summary tw-class="cursor-pointer font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__retained_conversation_audio() }}</summary>
              <div tw-class="mt-4 space-y-4">
                <p tw-class="text-[11px] leading-5 text-gray-500 dark:text-gray-400" data-testid="live-speech-retention-help">{{ lazyStrings.liveConversation__retained_conversation_audio_help() }}</p>
                <div v-if="session.inputAudio" tw-class="space-y-2"><h3 tw-class="font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__input_audio() }}</h3><audio :src="session.inputAudio.url" controls preload="none" :inert="speechRunning" :aria-disabled="speechRunning" @play="replayConversationAudio({ event: $event, action: 'start' })" @pause="replayConversationAudio({ event: $event, action: 'end' })" @ended="replayConversationAudio({ event: $event, action: 'end' })" :aria-label="lazyStrings.liveConversation__input_audio()" :tw-class="speechRunning ? 'h-10 w-full opacity-50' : 'h-10 w-full'" data-testid="live-speech-input-replay" /><a :href="session.inputAudio.url" :download="`naidan-live-${session.id}-input.wav`" tw-class="inline-flex min-h-8 items-center gap-1.5 rounded text-blue-600 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400" data-testid="live-speech-download-input"><DownloadIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.liveConversation__save_input_audio_wav() }}</a></div>
                <div v-if="session.outputAudio" tw-class="space-y-2"><h3 tw-class="font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__voice_response() }}</h3><audio :src="session.outputAudio.url" controls preload="none" :inert="speechRunning" :aria-disabled="speechRunning" @play="replayConversationAudio({ event: $event, action: 'start' })" @pause="replayConversationAudio({ event: $event, action: 'end' })" @ended="replayConversationAudio({ event: $event, action: 'end' })" :aria-label="lazyStrings.liveConversation__voice_response()" :tw-class="speechRunning ? 'h-10 w-full opacity-50' : 'h-10 w-full'" data-testid="live-speech-output-replay" /><a :href="session.outputAudio.url" :download="`naidan-live-${session.id}-response.wav`" tw-class="inline-flex min-h-8 items-center gap-1.5 rounded text-blue-600 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400" data-testid="live-speech-download-output"><DownloadIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.liveConversation__save_response_wav() }}</a></div>
                <p v-if="session.inputAudio?.status === 'partial' || session.outputAudio?.status === 'partial'" tw-class="text-[11px] leading-5 text-amber-700 dark:text-amber-300" data-testid="live-speech-partial-audio">{{ lazyStrings.liveConversation__partial_conversation_audio() }}</p>
              </div>
            </details>
            <p v-if="session.completion === 'max_seconds'" tw-class="text-xs leading-6 text-amber-700 dark:text-amber-300">{{ lazyStrings.liveConversation__conversation_time_limit_reached() }}</p><p v-else-if="session.completion" tw-class="text-[11px] text-gray-400 dark:text-gray-500">{{ lazyStrings.liveConversation__session_ended() }}</p>
          </article>
        </section>
        <div v-if="!diagnostics && state.failure" role="alert" tw-class="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-900/10 dark:text-red-400"><p>{{ lazyStrings.liveConversation__failed() }}</p><code tw-class="mt-2 block break-words">{{ state.failure }}</code></div>
        <p v-if="!diagnostics && audioWarning" role="status" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ audioWarning }}</p>
        <p v-if="!diagnostics && !speechMode && !state.entries.length" tw-class="py-8 text-center text-sm leading-7 text-gray-500 dark:text-gray-400" data-testid="live-empty">{{ state.phase === 'loading' ? lazyStrings.liveConversation__loading() : active ? lazyStrings.liveConversation__ready_to_talk() : lazyStrings.liveConversation__download_then_start() }}</p>
        <LiveConversationHistory v-if="!diagnostics && !speechMode" ref="history" @layout="historyScroll.follow" @replay-start="replayStarted({ element: $event })" @replay-end="replayEnded({ element: $event })" :entries="state.entries" :hide-text="hideText" />
        <section v-if="!diagnostics && state.pendingTools.length" tw-class="mt-5 space-y-3 rounded-xl border border-amber-300 p-4 dark:border-amber-700" data-testid="live-tool-approval"><h2 tw-class="text-sm font-semibold">{{ lazyStrings.liveConversation__approval_required() }}</h2><pre v-for="call in state.pendingTools" :key="call.id" tw-class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-3 text-xs dark:bg-gray-800">{{ readLiveShellCall({ call }).shell_script }}</pre><div tw-class="flex flex-wrap gap-2"><button type="button" @click="controller.approve({ decision: 'run' })" tw-class="rounded-lg bg-blue-600 px-3 py-2 text-xs text-white" data-testid="live-tool-run">{{ lazyStrings.liveConversation__approve_commands() }}</button><button type="button" @click="controller.approve({ decision: 'deny' })" tw-class="rounded-lg border border-gray-300 px-3 py-2 text-xs dark:border-gray-600" data-testid="live-tool-deny">{{ lazyStrings.liveConversation__deny_commands() }}</button></div></section>
        <section v-if="!diagnostics && pending.length" tw-class="space-y-3 rounded-xl border border-gray-200/70 bg-gray-50/80 p-3 dark:border-gray-700 dark:bg-gray-800/30" data-testid="live-pending">
          <h2 tw-class="text-xs font-semibold">{{ lazyStrings.liveConversation__pending_messages() }}</h2>
          <article v-for="message in pending" :key="message.id" tw-class="space-y-2 rounded-lg bg-white p-3 dark:bg-gray-800" data-testid="live-pending-message"><div tw-class="flex flex-wrap gap-2 text-[11px] text-gray-500 dark:text-gray-400"><span v-if="message.settings.output !== 'text'">{{ lazyStrings.liveConversation__voice() }}</span><span v-if="message.settings.output !== 'audio'">{{ lazyStrings.liveConversation__answer_text() }}</span></div><label tw-class="block text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__edit_pending_message() }}<textarea :value="message.draft.text" maxlength="32768" rows="2" @input="editPending({ id: message.id, event: $event })" tw-class="mt-1 w-full resize-y border-0 bg-transparent text-sm text-gray-900 outline-none dark:text-gray-100" /></label><p v-for="item in message.draft.images" :key="item.url" tw-class="truncate text-xs text-gray-500">{{ item.file.name }}</p><p v-if="message.draft.audio" tw-class="truncate text-xs text-gray-500">{{ message.draft.audio.file.name }}</p><div tw-class="flex items-center justify-end gap-3"><button v-if="message.status === 'paused'" type="button" @click="composer.retry({ id: message.id })" tw-class="text-xs text-blue-600 dark:text-blue-400">{{ lazyStrings.liveConversation__retry_pending() }}</button><button type="button" @click="composer.cancel({ id: message.id })" :title="lazyStrings.liveConversation__cancel_pending()" tw-class="flex items-center gap-1.5 text-xs text-gray-500 hover:text-red-500"><Trash2Icon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.liveConversation__cancel_pending() }}</button></div></article>
        </section>
      </div>
    </main>
    <footer v-if="!diagnostics" tw-class="relative z-10 shrink-0 bg-[#fcfcfd] px-4 pb-3 pt-2 dark:bg-gray-900 sm:px-6" data-testid="live-composer-footer">
      <button v-if="active && !historyScroll.following.value" type="button" @click="historyScroll.toLatest" :aria-label="lazyStrings.liveConversation__latest_messages()" :title="lazyStrings.liveConversation__latest_messages()" tw-class="absolute -top-11 left-1/2 grid h-9 w-9 -translate-x-1/2 place-items-center rounded-full border border-gray-200 bg-white text-gray-500 shadow-sm hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300" data-testid="live-scroll-latest"><ArrowDownIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
      <div tw-class="mx-auto max-w-4xl space-y-2">
        <div tw-class="flex min-h-8 items-center gap-2"><span role="status" tw-class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400" data-testid="live-status"><Loader2Icon v-if="!speechMode && active && state.phase !== 'ready' && state.phase !== 'recording' && state.phase !== 'approval'" aria-hidden="true" tw-class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{{ status }}</span>
          <button v-if="!speechMode && busy && !['loading', 'closing', 'stopping'].includes(state.phase)" type="button" @click="interrupt" :title="lazyStrings.liveConversation__interruption_help()" tw-class="ml-auto flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800" data-testid="live-interrupt"><SquareIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.liveConversation__stop_response() }}</button></div>
        <div v-if="speechMode" tw-class="space-y-3 rounded-2xl border border-gray-100 bg-white p-3 shadow-lg transition-colors dark:border-gray-700 dark:bg-gray-800 sm:p-4" data-testid="live-speech-controls">
          <div tw-class="flex flex-wrap items-center gap-2">
            <button v-if="!speechRunning" type="button" :disabled="!active || changingConversation || speech.controller.capability.kind !== 'available' || !['ready', 'completed'].includes(speechState.runtime.phase) || !Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > 3600" @click="startSpeech" tw-class="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40 sm:w-auto" data-testid="live-speech-start"><MicIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.liveConversation__start_continuous_conversation() }}</button>
            <button v-else type="button" :disabled="speechState.runtime.phase === 'stopping'" @click="speech.controller.stop({ mode: 'cancel' })" tw-class="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40 sm:w-auto" data-testid="live-speech-stop"><SquareIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.liveConversation__stop_continuous_conversation() }}</button>
            <button type="button" :aria-pressed="!microphone" @click="microphone = !microphone" :tw-class="['flex min-h-11 items-center gap-2 rounded-lg border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', !microphone ? 'border-blue-200 bg-blue-50 text-blue-600 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-400' : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800']" data-testid="live-speech-mute-microphone"><MicOffIcon v-if="!microphone" aria-hidden="true" tw-class="h-4 w-4" /><MicIcon v-else aria-hidden="true" tw-class="h-4 w-4" />{{ microphone ? lazyStrings.liveConversation__mute_microphone() : lazyStrings.liveConversation__unmute_microphone() }}</button>
            <button type="button" :aria-pressed="muted" @click="togglePlayback" :tw-class="['flex min-h-11 items-center gap-2 rounded-lg border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', muted ? 'border-blue-200 bg-blue-50 text-blue-600 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-400' : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800']" data-testid="live-speech-mute-playback"><VolumeXIcon v-if="muted" aria-hidden="true" tw-class="h-4 w-4" /><Volume2Icon v-else aria-hidden="true" tw-class="h-4 w-4" />{{ muted ? lazyStrings.liveConversation__unmute_playback() : lazyStrings.liveConversation__mute_playback() }}</button>
          </div>
          <div v-if="speechState.capture === 'open' && speechState.runtime.phase === 'running'" tw-class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400" data-testid="live-speech-audio-status"><span role="status" tw-class="flex items-center gap-1.5"><MicIcon v-if="microphone" aria-hidden="true" tw-class="h-3.5 w-3.5 text-blue-500" /><MicOffIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ microphone ? lazyStrings.liveConversation__listening() : lazyStrings.liveConversation__microphone_muted() }}</span><span role="status" tw-class="flex items-center gap-1.5"><VolumeXIcon v-if="muted" aria-hidden="true" tw-class="h-3.5 w-3.5" /><Volume2Icon v-else aria-hidden="true" tw-class="h-3.5 w-3.5 text-blue-500" />{{ muted ? lazyStrings.liveConversation__playback_muted() : speechState.playing ? lazyStrings.liveConversation__playing() : lazyStrings.liveConversation__waiting_for_audio() }}</span></div>
          <p data-testid="live-speech-guidance" tw-class="text-[11px] leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__microphone_and_response_audio_run_together() }}</p>
          <p v-if="speechUnavailable" role="status" tw-class="text-xs leading-5 text-amber-700 dark:text-amber-300">{{ speechUnavailable }}</p>
          <p v-if="speechState.runtime.queuedSamples > 24000" role="status" tw-class="text-xs leading-5 text-amber-700 dark:text-amber-300" data-testid="live-speech-delay">{{ lazyStrings.liveConversation__microphone_audio_delay({ seconds: (speechState.runtime.queuedSamples / 24000).toFixed(1) }) }}</p>
        </div>
        <p v-if="draftMessage" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ draftMessage }}</p>
        <p v-if="!speechMode && !draftSupported" role="alert" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.liveConversation__draft_channel_disabled() }}</p>
        <p v-if="!speechMode && !outputSelected" role="status" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.liveConversation__choose_output_channel() }}</p>
        <p v-if="state.phase === 'recording'" role="status" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.liveConversation__listening() }}</p>
        <LiveConversationInput v-if="!speechMode" ref="input" @replay-start="replayStarted({ element: $event })" @replay-end="replayEnded({ element: $event })" :draft="draft" :text-enabled="effectiveTextInput" :images-allowed="imageInput && vision" :can-submit="canSubmit" :can-talk="canTalk && draftSupported" :recording="state.phase === 'recording'" :busy="busy" @text="draft = { ...draft, text: $event }" @attach="attach({ files: $event })" @remove="removeAttachment({ url: $event })" @send="send" @talk="talk" @finish="controller.finishRecording()" />
        <p v-if="!speechMode && busy && state.phase !== 'recording'" tw-class="text-center text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__prepare_next_message() }}</p>
      </div>
    </footer>
    <div v-if="dragDepth > 0 && (diagnostics ? !navigationBusy : !speechMode)" tw-class="pointer-events-none absolute inset-4 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-blue-400 bg-white/90 text-sm font-semibold text-blue-600 dark:bg-gray-900/90 dark:text-blue-400" data-testid="live-drop-overlay">{{ diagnostics ? lazyStrings.liveConversation__drop_or_choose_audio() : lazyStrings.liveConversation__drop_attachments() }}</div>
  </div>
</template>
