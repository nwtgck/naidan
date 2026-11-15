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
import { useSpeechRecognition } from '@/features/live-conversation/composables/useSpeechRecognition';
import { useSpeechResponseRecording } from '@/features/live-conversation/composables/useSpeechResponseRecording';
import { inspectStoredSpeechModel, openStoredSpeechModel } from '@/features/speech-cpp-browser/models';
import { inspectStoredSpeechRecognitionModel, openStoredSpeechRecognitionModel } from '@/features/speech-cpp-browser/recognition/models';
import { speechRecognitionModelCatalog } from '@/features/speech-cpp-browser/recognition/model-catalog';
import { useLiveModelPreference } from '@/features/live-conversation/composables/useLiveModelPreference';
import { useLiveComposer, type LiveDraft, type LivePendingMessage } from '@/features/live-conversation/composables/useLiveComposer';
import type { LiveTurnSettings } from '@/features/live-conversation/logic/controller';
import { readLiveShellCall } from '@/features/live-conversation/logic/wesh-policy';
import { liveModelCatalog } from '@/features/live-conversation/model-catalog';
import { defaultLiveSpeechLanguage, liveSpeechLanguageOptions } from '@/features/live-conversation/logic/speech-language';
import type { SpeechInputPacing } from '@/features/live-conversation/logic/speech-file-run';
import { speechFailure, type SpeechLoadProgress, type SpeechModelInfo } from '@/features/speech-cpp-browser/types';
import type { SpeechRecognitionCandidateInfo } from '@/features/speech-cpp-browser/recognition/types';
import type { SpeechInvestigationBinding } from '@/features/speech-cpp-browser/worker/investigation-context';
import { registerLiveConversationNavigation, type LiveConversationPanel, type LiveInvestigationTask } from '@/features/live-conversation/navigation';
import LiveConversationInput from './LiveConversationInput.vue';
import LiveConversationHistory from './LiveConversationHistory.vue';
import LiveConversationDiagnostics from './LiveConversationDiagnostics.vue';
import LiveModelLoadProgress from './LiveModelLoadProgress.vue';
import LiveSpeechResponseInvestigation from './LiveSpeechResponseInvestigation.vue';
import LiveSpeechRecognitionInvestigation from './LiveSpeechRecognitionInvestigation.vue';
import LiveSpeechRecordingInput from './LiveSpeechRecordingInput.vue';
import LiveSpeechInvestigationExport from './LiveSpeechInvestigationExport.vue';
import LiveSpeechInputLevel from './LiveSpeechInputLevel.vue';
import type { SpeechRecordingClip } from '@/features/live-conversation/logic/speech-recognition-recording';
import { createInvestigationRecord } from '@/features/live-conversation/logic/investigation-record';
import { downloadSpeechInvestigation } from '@/features/speech-cpp-browser/investigation/archive';
import { type SpeechInvestigationExportOptions } from '@/features/speech-cpp-browser/investigation/types';
import { liveAudioFileLimit } from '@/features/live-conversation/logic/audio-file';
import { snapshotInputLevel, type SpeechInputLevelSettings } from '@/features/live-conversation/logic/audio-level';
import { nanoid } from 'nanoid';
import { createSpeechInvestigationCollection } from '@/features/speech-cpp-browser/investigation/collection';
import type { SpeechInvestigationCollectionSnapshot, SpeechInvestigationSnapshot } from '@/features/speech-cpp-browser/investigation/types';
import { createSpeechResponseResultViews, type SpeechResponseResultView } from '@/features/live-conversation/logic/response-result-views';
import { createInvestigationPlan } from '@/features/live-conversation/logic/investigation-plan';

const id = useId();
const props = defineProps<{ panel?: LiveConversationPanel, task?: LiveInvestigationTask }>();
const emit = defineEmits<{ openConversation: [], openDiagnostics: [], investigationTask: [value: LiveInvestigationTask] }>();
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
const fileTask = ref<LiveInvestigationTask>();
const invalidSourceFile = ref(false);
const fileOperationFailure = ref<string>();
const changingSource = ref(false);
const tailSeconds = 5;
const fileSeed = ref(0);
const fileInputPacing = ref<SpeechInputPacing>('fast');
const fileInputLevels = shallowRef<SpeechInputLevelSettings[]>([{ kind: 'gain', gain: 1 }]);
const responseResults = shallowRef<SpeechResponseResultView[]>([]);
const responseComparisonSnapshot = shallowRef<SpeechInvestigationCollectionSnapshot>();
const responseComparisonSource = shallowRef<File>();
const responseTrialId = ref<string>();
const responseTrialRunId = ref<string>();
const responseResultViews = createSpeechResponseResultViews();
const investigationExportSource = ref<'single' | 'comparison'>('single');
const residentLoadSnapshot = shallowRef<SpeechInvestigationSnapshot>();
const residentLoadIdentity = shallowRef<{ modelId: string, file: File }>();
const investigationTask = computed(() => props.task ?? 'response');
const transcriptionInvestigation = computed(() => {
  const task = investigationTask.value;
  switch (task) {
  case 'response': return false;
  case 'transcription': return true;
  default: {
    const exhaustive: never = task;
    throw new Error(String(exhaustive));
  }
  }
});
const recognitionLanguage = ref('');
const recognitionLanguageValue = computed(() => {
  const selection = recognitionState.value.runtime.model?.languageSelection;
  switch (selection) {
  case 'supported': return recognitionLanguage.value || undefined;
  case 'unsupported': case undefined: return undefined;
  default: {
    const exhaustive: never = selection;
    throw new Error(String(exhaustive));
  }
  }
});
const recognitionInputSource = ref<'file' | 'microphone'>('file');
const responseInputSource = ref<'file' | 'microphone'>('file');
const responseRecordingSnapshot = shallowRef<Pick<SpeechRecordingClip, 'id' | 'file' | 'seconds' | 'status'>>();
const recordingSnapshot = shallowRef<Pick<SpeechRecordingClip, 'id' | 'file' | 'seconds' | 'status'>>();
const lastRecognitionFile = shallowRef<File>();
const modelLoadMilliseconds = ref<number>();
const modelLoadGeneration = ref(0);
const modelInspectionPending = ref(false);
const investigationCaptureId = ref<string>();
const investigationCapture = createInvestigationRecord({
  changed({ id }) {
    investigationCaptureId.value = id;
    if (singleExportCollection?.operationId !== id) {
      singleExportCollection?.collection.clear();
      singleExportCollection = undefined;
    }
  },
});
const investigationSaving = ref(false);
const investigationExportFailure = ref<string>();
const diagnosticModelIds = shallowRef<string[]>([]);
const diagnosticModelsScanning = ref(false);
const { state, controller } = useLiveConversation();
const speech = useLiveSpeechConversation();
const speechState = speech.state;
const recognition = useSpeechRecognition();
const recognitionState = recognition.state;
const recordingState = recognition.recordingState;
const responseRecording = useSpeechResponseRecording();
const responseRecordingState = responseRecording.recordingState;
const selectedEngine = ref<'llama' | 'speech' | 'recognition' | 'checking'>('checking');
const residentEngine = ref<'llama' | 'speech' | 'recognition'>();
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
const residentModelFile = shallowRef<File>();
const selectedModelInfo = shallowRef<SpeechModelInfo | SpeechRecognitionCandidateInfo>();
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
let candidateScan: AbortController | undefined;
let investigationExportLifetime: AbortController | undefined;
let modelLoadInvestigation: { lifetime: AbortController, binding: SpeechInvestigationBinding } | undefined;
let responseInvestigation: SpeechInvestigationBinding | undefined;
let recognitionInvestigation: SpeechInvestigationBinding | undefined;
let recordedRecognitionRunId: string | undefined;
let singleInvestigationKind: 'load' | 'trial' = 'trial';
let singleExportCollection: { operationId: string, collection: ReturnType<typeof createSpeechInvestigationCollection> } | undefined;
let responseCollection: ReturnType<typeof createSpeechInvestigationCollection> | undefined;
let responseComparisonLifetime: AbortController | undefined;
let responseComparisonTask: Promise<void> | undefined;
let recognitionRecordingAttempt: { binding: SpeechInvestigationBinding, previousRunId: string | undefined, acceptedRunId: string | undefined } | undefined;
let unsubscribeModels: (() => void) | undefined;
let unregisterNavigation: (() => void) | undefined;
const speechMode = computed(() => residentEngine.value && (active.value || startingModel.value) ? residentEngine.value === 'speech' : selectedEngine.value === 'speech');
const recognitionMode = computed(() => residentEngine.value && (active.value || startingModel.value) ? residentEngine.value === 'recognition' : selectedEngine.value === 'recognition');
const llamaMode = computed(() => !speechMode.value && !recognitionMode.value);
const active = computed(() => state.value.phase !== 'idle' || speech.state.value.runtime.model !== undefined || recognitionState.value.runtime.model !== undefined);
const idleForTurn = computed(() => state.value.phase === 'ready' && !state.value.playing && !changingConversation.value && !talkPending.value && !manualReplay.value && !recordingActive.value && !recognitionRunning.value && !filePending.value);
const vision = computed(() => llamaMode.value && state.value.info?.vision !== 'unavailable');
const selectedFolder = computed(() => volumes.value.find(volume => idToRaw({ id: volume.id }) === volumeId.value));
const selectedAvailable = computed(() => models.value.some(model => model.modelId === modelId.value));
const outputSelected = computed(() => voiceOutput.value || textOutput.value);
const output = computed<LiveTurnSettings['output']>(() => voiceOutput.value ? textOutput.value ? 'mixed' : 'audio' : 'text');
const speechRunning = computed(() => speech.state.value.capture !== 'closed' || ['starting', 'running', 'stopping'].includes(speech.state.value.runtime.phase));
const recognitionRunning = computed(() => ['recognizing', 'cancelling'].includes(recognitionState.value.runtime.phase) || recognitionState.value.run?.status === 'preparing' || recognitionState.value.run?.status === 'recognizing');
const recognitionRecordingActive = computed(() => ['opening', 'recording', 'stopping'].includes(recordingState.value.phase));
const responseRecordingActive = computed(() => ['opening', 'recording', 'stopping'].includes(responseRecordingState.value.phase));
const recordingActive = computed(() => recognitionRecordingActive.value || responseRecordingActive.value);
const recordingOwner = computed<LiveInvestigationTask | undefined>(() => recognitionRecordingActive.value ? 'transcription' : responseRecordingActive.value ? 'response' : undefined);
const activeRecordingState = computed(() => responseRecordingActive.value ? responseRecordingState.value : recordingState.value);
const currentRecordingSnapshot = computed(() => recordingActive.value ? undefined : [recordingSnapshot.value, responseRecordingSnapshot.value].find(clip => clip?.file === sourceFile.value));
const currentInputSource = computed(() => transcriptionInvestigation.value ? recognitionInputSource.value : responseInputSource.value);
const recordingVisible = computed(() => diagnostics.value && investigationTask.value === recordingOwner.value && currentInputSource.value === 'microphone');
const activeFileTask = computed(() => fileTask.value ?? (recognitionRunning.value ? 'transcription' as const : undefined));
const busy = computed(() => changingSource.value || filePending.value || recordingActive.value || recognitionRunning.value || (speechMode.value ? speechRunning.value : recognitionMode.value ? false : active.value && (state.value.phase !== 'ready' || state.value.playing)));
const selectedRuntimeReady = computed(() => {
  switch (selectedEngine.value) {
  case 'checking': return false;
  case 'speech': return speech.controller.capability.kind === 'available';
  case 'recognition': return recognition.controller.capability.kind === 'available';
  case 'llama': return runtimeReady.value && (!tools.value || !!selectedFolder.value);
  default: {
    const exhaustive: never = selectedEngine.value;
    throw new Error(String(exhaustive));
  }
  }
});
const canStart = computed(() => !active.value && !startingModel.value && !changingConversation.value && !busy.value && selectedAvailable.value && selectedRuntimeReady.value && (!diagnostics.value || diagnosticSelectionSupported.value));
const canQueue = computed(() => llamaMode.value && active.value && state.value.phase !== 'closing' && !changingConversation.value && !recordingActive.value && !recognitionRunning.value && !filePending.value);
const canTalk = computed(() => llamaMode.value && active.value && !changingConversation.value && !talkPending.value && !recordingActive.value && !recognitionRunning.value && !filePending.value && !['loading', 'closing', 'stopping', 'preparing-input', 'recording'].includes(state.value.phase) && microphone.value && outputSelected.value);
const canReset = computed(() => !changingSource.value && !startingModel.value && !changingConversation.value && !['loading', 'closing', 'stopping'].includes(state.value.phase) && !['loading_model', 'starting', 'stopping'].includes(speech.state.value.runtime.phase) && !['loading_model', 'cancelling'].includes(recognitionState.value.runtime.phase));
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
// Preparing an input/settings does not own the model-load operation.
const sourceBlocked = computed(() => changingSource.value || changingConversation.value || filePending.value || recordingActive.value || recognitionRunning.value || speechRunning.value || talkPending.value || (llamaMode.value && !['idle', 'loading', 'ready'].includes(state.value.phase)));
const diagnosticSelectionSupported = computed(() => diagnosticModelIds.value.includes(modelId.value));
const canLoadSelectedModel = computed(() => !navigationBusy.value && selectedAvailable.value && selectedRuntimeReady.value && (!diagnostics.value || diagnosticSelectionSupported.value) && (!active.value || residentModelId.value !== modelId.value));
const fileRun = computed(() => sourceFile.value !== undefined && lastRunFile.value === sourceFile.value ? speechState.value.fileRun : undefined);
const fileText = computed(() => fileRun.value?.text ?? '');
const visibleResponseResults = computed(() => responseComparisonSource.value === sourceFile.value ? responseResults.value : []);
const visibleResponseComparison = computed(() => responseComparisonSource.value === sourceFile.value ? responseComparisonSnapshot.value : undefined);
const responseRun = computed(() => responseComparisonSnapshot.value ? (fileRun.value?.id === responseTrialRunId.value ? fileRun.value : undefined) : fileRun.value);
const comparisonExport = computed(() => {
  switch (investigationExportSource.value) {
  case 'comparison': return true;
  case 'single': return false;
  default: {
    const exhaustive: never = investigationExportSource.value;
    throw new Error(String(exhaustive));
  }
  }
});
const exportCaptureId = computed(() => comparisonExport.value ? responseComparisonSnapshot.value?.id : investigationCaptureId.value);
const recognitionRun = computed(() => sourceFile.value !== undefined && lastRecognitionFile.value === sourceFile.value ? recognitionState.value.run : undefined);
const modelLoadProgress = computed<SpeechLoadProgress | undefined>(() => modelInspectionPending.value ? { stage: 'checking_model' } : recognitionMode.value ? recognitionState.value.runtime.loadProgress : speechState.value.runtime.loadProgress);
const modelLoadReady = computed(() => recognitionMode.value ? recognitionState.value.runtime.phase === 'ready' : speechState.value.runtime.phase === 'ready');
const modelSuggestions = computed(() => diagnostics.value && transcriptionInvestigation.value ? speechRecognitionModelCatalog : liveModelCatalog);
const fileSelectionFailure = computed(() => invalidSourceFile.value ? lazyStrings.liveConversation__audio_file_limits() : fileOperationFailure.value ?? (transcriptionInvestigation.value ? recognitionState.value.failure?.message : responseCollection ? undefined : speechState.value.failure?.message));
const validDuration = computed(() => Number.isFinite(maxSeconds.value) && maxSeconds.value > 0 && maxSeconds.value <= 3600);
const validFileSeed = computed(() => Number.isSafeInteger(fileSeed.value) && fileSeed.value >= 0);
const investigationSourceReady = computed(() => currentInputSource.value === 'file' || currentRecordingSnapshot.value !== undefined);
const canGenerateFile = computed(() => fileInputLevels.value.length > 0 && investigationSourceReady.value && speechMode.value && active.value && speech.controller.capability.kind === 'available' && !navigationBusy.value && ['ready', 'completed'].includes(speechState.value.runtime.phase) && validDuration.value && validFileSeed.value);
const canTranscribeFile = computed(() => investigationSourceReady.value && recognitionMode.value && active.value && recognition.controller.capability.kind === 'available' && !navigationBusy.value && recognitionState.value.runtime.phase === 'ready');
const effectiveTextInput = computed({
  get: () => llamaMode.value && textInput.value,
  set: value => {
    textInput.value = value;
  },
});
const effectiveImageInput = computed({
  get: () => llamaMode.value && imageInput.value,
  set: value => {
    imageInput.value = value;
  },
});
const effectiveTranscription = computed({
  get: () => llamaMode.value && transcription.value,
  set: value => {
    transcription.value = value;
  },
});
const effectiveTools = computed({
  get: () => llamaMode.value && tools.value,
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
const recognitionUnavailable = computed(() => {
  const capability = recognition.controller.capability;
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
const transcriptionUnavailable = computed(() => recognitionUnavailable.value ?? (!recognitionMode.value || !active.value ? lazyStrings.liveConversation__transcription_model_required() : undefined));
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
  if (recognitionMode.value) {
    const phase = recognitionState.value.runtime.phase;
    switch (phase) {
    case 'unloaded': case 'disposed': return lazyStrings.liveConversation__idle();
    case 'loading_model': return lazyStrings.liveConversation__loading();
    case 'ready': return lazyStrings.liveConversation__ready();
    case 'recognizing': return lazyStrings.liveConversation__transcribing_audio_file();
    case 'cancelling': return lazyStrings.liveConversation__stopping();
    case 'failed': return lazyStrings.liveConversation__failed();
    default: {
      const exhaustive: never = phase;
      throw new Error(String(exhaustive));
    }
    }
  }
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

function fileRunAudioDescription({ role }: { role: 'input' | 'output' }): string {
  switch (role) {
  case 'input': return 'Client-accepted PCM; queued samples may not have been consumed at cancellation';
  case 'output': return 'Native response PCM before playback';
  default: {
    const exhaustive: never = role;
    throw new Error(String(exhaustive));
  }
  }
}

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
  selectedModelInfo.value = undefined;
  if (!value) {
    selectedEngine.value = 'llama';
    return;
  }
  try {
    const result = await inspectStoredSpeechModel({ modelId: value, signal: current.signal });
    if (!disposed && inspect === current) {
      modelFailure.value = undefined;
      switch (result.kind) {
      case 'speech': selectedModelInfo.value = result.info;
        selectedEngine.value = 'speech';
        break;
      case 'other': {
        const candidate = await inspectStoredSpeechRecognitionModel({ modelId: value, signal: current.signal });
        if (disposed || inspect !== current || current.signal.aborted) {
          return;
        }
        switch (candidate.kind) {
        case 'recognition': selectedModelInfo.value = candidate.info;
          selectedEngine.value = 'recognition';
          break;
        case 'other': selectedEngine.value = 'llama';
          break;
        default: {
          const exhaustive: never = candidate;
          throw new Error(String(exhaustive));
        }
        }
        break;
      }
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

async function inspectInvestigationCandidate({ modelId, signal, task }: { modelId: string, signal: AbortSignal, task: LiveInvestigationTask }) {
  switch (task) {
  case 'response': return inspectStoredSpeechModel({ modelId, signal });
  case 'transcription': return inspectStoredSpeechRecognitionModel({ modelId, signal });
  default: {
    const exhaustive: never = task;
    throw new Error(String(exhaustive));
  }
  }
}

watch([models, diagnostics, investigationTask], async ([entries, visible, task]) => {
  candidateScan?.abort();
  if (!visible) {
    return;
  }
  const current = new AbortController();
  candidateScan = current;
  diagnosticModelsScanning.value = true;
  diagnosticModelIds.value = [];
  const accepted: string[] = [];
  try {
    for (const entry of entries) {
      try {
        const candidate = await inspectInvestigationCandidate({ modelId: entry.modelId, signal: current.signal, task });
        if (current.signal.aborted || disposed) {
          return;
        }
        switch (candidate.kind) {
        case 'speech': case 'recognition': accepted.push(entry.modelId);
          break;
        case 'other': break;
        default: {
          const exhaustive: never = candidate;
          throw new Error(String(exhaustive));
        }
        }
      } catch {
        if (current.signal.aborted || disposed) {
          return;
        }
      }
    }
    if (candidateScan === current) {
      diagnosticModelIds.value = accepted;
    }
  } finally {
    if (candidateScan === current) {
      diagnosticModelsScanning.value = false;
    }
  }
}, { immediate: true });

watch(microphone, value => {
  speech.controller.muteMicrophone({ value: value ? 'on' : 'off' });
});
watch(() => recognitionState.value.runtime.model, model => {
  if (model?.languageSelection !== 'supported' || !model.languages.includes(recognitionLanguage.value)) {
    recognitionLanguage.value = '';
  }
});
watch(() => recordingState.value.clip, clip => {
  if (clip) {
    const { id, file, seconds, status, url: _url, sampleRate: _sampleRate, ...unhandled } = clip;
    unhandled satisfies Record<PropertyKey, never>;
    if (sourceFile.value !== file) {
      invalidateSourceResearch({ preserve: recognitionRecordingAttempt?.binding ?? activeLoadInvestigation() });
      void speech.controller.clearFileRun();
    }
    recordingSnapshot.value = { id, file, seconds, status };
    sourceFile.value = file;
    invalidSourceFile.value = false;
    fileOperationFailure.value = undefined;
  }
}, { flush: 'sync' });
watch(() => responseRecordingState.value.clip, clip => {
  if (clip) {
    const { id, file, seconds, status, url: _url, sampleRate: _sampleRate, ...unhandled } = clip;
    unhandled satisfies Record<PropertyKey, never>;
    if (sourceFile.value !== file) {
      invalidateSourceResearch({ preserve: activeLoadInvestigation() });
      void speech.controller.clearFileRun();
    }
    responseRecordingSnapshot.value = { id, file, seconds, status };
    sourceFile.value = file;
    invalidSourceFile.value = false;
    fileOperationFailure.value = undefined;
  }
}, { flush: 'sync' });
watch(() => recordingState.value.failure, failure => {
  if (failure && recognitionRecordingAttempt?.acceptedRunId === undefined && recognitionRecordingAttempt) {
    investigationCapture.runFailed({ context: recognitionRecordingAttempt.binding.context, failure });
  }
}, { flush: 'sync' });
watch(() => recognitionState.value.run?.id, runId => {
  if (recognitionRecordingAttempt && runId !== undefined && runId !== recognitionRecordingAttempt.previousRunId) {
    recognitionRecordingAttempt.acceptedRunId = runId;
  }
  if (sourceFile.value?.name === recognitionState.value.run?.inputName) {
    lastRecognitionFile.value = sourceFile.value;
  }
}, { flush: 'sync' });
watch([() => speechState.value.fileRun?.id, () => speechState.value.fileRun?.status, () => speechState.value.fileRun?.stage], ([id], previous) => {
  const run = speechState.value.fileRun;
  const file = lastRunFile.value;
  if (!run || !file) {
    return;
  }
  if (responseComparisonLifetime && responseTrialId.value && id !== previous[0]) {
    responseTrialRunId.value = id;
  }
  if (responseInvestigation) {
    for (const role of ['input', 'output'] as const) {
      const blob = speech.controller.getFileRunAudio({ id: run.id, role });
      if (blob) {
        investigationCapture.audio({ context: responseInvestigation.context, role, audio: { status: 'retained', blob, format: 'wav', description: fileRunAudioDescription({ role }) } });
      }
    }
  }
  investigationCapture.response({ run, modelId: residentModelId.value, model: speechState.value.runtime.model, file, instructions: instructions.value || undefined, beginRun: id !== previous[0] });
}, { flush: 'sync' });
watch([() => recognitionState.value.run?.id, () => recognitionState.value.run?.status, () => recordingSnapshot.value?.file, startingModel], ([id]) => {
  if (startingModel.value && recognitionMode.value) {
    return;
  }
  const run = recognitionState.value.run;
  const file = sourceFile.value?.name === run?.inputName ? sourceFile.value : lastRecognitionFile.value;
  if (!run) {
    return;
  }
  const beginRun = id !== recordedRecognitionRunId;
  if (beginRun) {
    investigationExportSource.value = 'single';
    singleInvestigationKind = 'trial';
  }
  investigationCapture.recognition({ run, modelId: residentModelId.value, model: recognitionState.value.runtime.model, file, language: recognitionLanguageValue.value, recording: recordingSnapshot.value?.file === file, beginRun });
  recordedRecognitionRunId = id;
}, { flush: 'sync' });

watch(modelLoadProgress, progress => {
  if (modelLoadInvestigation && modelOpening === modelLoadInvestigation.lifetime) {
    investigationCapture.loadProgress({ context: modelLoadInvestigation.binding.context, progress });
  }
}, { flush: 'sync' });

watch([active, startingModel], ([resident, starting]) => {
  if (!resident && !starting) {
    residentEngine.value = undefined;
    residentModelId.value = '';
    residentModelFile.value = undefined;
    residentLoadSnapshot.value = undefined;
    residentLoadIdentity.value = undefined;
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
  if (recordingActive.value) {
    element.pause();
    return;
  }
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
    if (speechRunning.value || recordingActive.value) {
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
  if (!llamaMode.value) {
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
    if (diagnostics.value ? !sourceBlocked.value : llamaMode.value) {
      dragDepth.value++;
    }
  }
}

function dragOver({ event }: { event: DragEvent }): void {
  if (event.dataTransfer?.types.includes('Files')) {
    event.preventDefault();
    event.dataTransfer.dropEffect = diagnostics.value ? sourceBlocked.value ? 'none' : 'copy' : llamaMode.value ? 'copy' : 'none';
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
  clearResponseComparison();
  void speech.controller.clearFileRun();
  lastRecognitionFile.value = undefined;
  void recognition.controller.clearRun();
  applyAudioRetention();
  settingsOpen.value = false;
  const selected = modelId.value;
  residentLoadSnapshot.value = undefined;
  residentLoadIdentity.value = undefined;
  selectModel({ value: selected });
  residentModelId.value = selected;
  if (speechMode.value || recognitionMode.value) {
    const recognizing = recognitionMode.value;
    const target = recognizing ? recognition.controller : speech.controller;
    residentEngine.value = recognizing ? 'recognition' : 'speech';
    startingModel.value = true;
    modelFailure.value = undefined;
    modelLoadMilliseconds.value = undefined;
    modelLoadGeneration.value++;
    modelInspectionPending.value = true;
    const current = new AbortController();
    modelOpening = current;
    const loadStarted = performance.now();
    const candidate = selectedModelInfo.value;
    const investigation = diagnostics.value && candidate ? investigationCapture.beginLoad({ task: recognizing ? 'recognition' : 'dialogue', modelId: selected, model: candidate, file: undefined }) : undefined;
    if (investigation) {
      investigationExportSource.value = 'single';
      singleInvestigationKind = 'load';
      modelLoadInvestigation = { lifetime: current, binding: investigation };
      investigationCapture.loadProgress({ context: investigation.context, progress: { stage: 'checking_model' } });
    }
    try {
      current.signal.throwIfAborted();
      const file = recognizing ? await openStoredSpeechRecognitionModel({ modelId: selected, signal: current.signal }) : await openStoredSpeechModel({ modelId: selected, signal: current.signal });
      current.signal.throwIfAborted();
      modelInspectionPending.value = false;
      await target.load({ file, ...(investigation ? { investigation } : {}) });
      current.signal.throwIfAborted();
      const loaded = target.getState().runtime.model;
      const failure = target.getState().failure;
      if (loaded) {
        residentModelFile.value = file;
        modelLoadMilliseconds.value = performance.now() - loadStarted;
        if (investigation) {
          investigationCapture.loaded({ context: investigation.context, model: loaded, file });
          const snapshot = investigationCapture.snapshot();
          if (snapshot?.id === investigation.context.operationId && snapshot.status !== 'in_progress') {
            residentLoadSnapshot.value = snapshot;
            residentLoadIdentity.value = { modelId: selected, file };
          }
        }
      } else if (investigation && failure) {
        investigationCapture.loadFailed({ context: investigation.context, failure });
      }
      modelFailure.value = target.getState().failure?.message;
      if (!recognizing) {
        speech.controller.mutePlayback({ value: muted.value ? 'off' : 'on' });
      }
    } catch (error) {
      if (investigation && !current.signal.aborted) {
        investigationCapture.loadFailed({ context: investigation.context, failure: speechFailure({ error }) });
      }
      if (!current.signal.aborted && !disposed) {
        modelFailure.value = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (modelLoadInvestigation?.lifetime === current) {
        modelLoadInvestigation = undefined;
      }
      if (modelOpening === current) {
        modelInspectionPending.value = false;
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
    if (state.value.entries.length || speech.state.value.sessions.length || speech.state.value.fileRun || recognitionState.value.run || sourceFile.value || pending.value.length || composer.hasDraft.value || busy.value) {
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
    await cancelResponseComparison({ reason: 'User started a new conversation' });
    await recognition.controller.cancel();
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
    await cancelResponseComparison({ reason: 'User released model' });
    const loading = modelLoadInvestigation;
    modelOpening?.abort();
    await releaseResident();
    if (loading) {
      investigationCapture.loadCancelled({ context: loading.binding.context, reason: 'User released model while loading' });
    }
    if (active.value) {
      return;
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

async function releaseResident(): Promise<void> {
  const engine = residentEngine.value;
  switch (engine) {
  case 'speech': await speech.controller.release();
    break;
  case 'recognition': await recognition.controller.release();
    if (recognitionRecordingAttempt) {
      investigationCapture.runCancelled({ context: recognitionRecordingAttempt.binding.context, reason: 'User released model before recognition' });
    }
    break;
  case 'llama': await controller.close();
    break;
  case undefined: break;
  default: {
    const exhaustive: never = engine;
    throw new Error(String(exhaustive));
  }
  }
  if (!active.value) {
    residentModelFile.value = undefined;
    residentLoadSnapshot.value = undefined;
    residentLoadIdentity.value = undefined;
  }
}

async function cancelModelLoading(): Promise<void> {
  if (!startingModel.value || changingConversation.value) {
    return;
  }
  const current = modelOpening;
  const loading = modelLoadInvestigation;
  const investigation = loading && loading.lifetime === current ? loading.binding : undefined;
  current?.abort();
  changingConversation.value = true;
  try {
    await releaseResident();
    if (investigation) {
      investigationCapture.loadCancelled({ context: investigation.context, reason: 'User cancelled model loading' });
    }
  } finally {
    if (modelOpening === current) {
      modelInspectionPending.value = false;
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
  if (!active.value || !speechMode.value || speechRunning.value || recordingActive.value || recognitionRunning.value || filePending.value || changingConversation.value || !Number.isFinite(maxSeconds.value) || maxSeconds.value <= 0 || maxSeconds.value > 3600) {
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

function activeLoadInvestigation(): SpeechInvestigationBinding | undefined {
  const load = modelLoadInvestigation;
  return load && load.lifetime === modelOpening && !load.lifetime.signal.aborted ? load.binding : undefined;
}

function invalidateSourceResearch({ preserve }: { preserve: SpeechInvestigationBinding | undefined }): void {
  clearResponseComparison();
  if (preserve && investigationCapture.snapshot()?.id === preserve.context.operationId) {
    return;
  }
  singleExportCollection?.collection.clear();
  singleExportCollection = undefined;
  investigationCapture.clear();
  investigationExportSource.value = 'single';
}

async function selectAudioFile({ files }: { files: File[] }): Promise<void> {
  if (sourceBlocked.value) {
    return;
  }
  const file = files[0];
  if (files.length !== 1 || !file || file.size === 0 || file.size > liveAudioFileLimit || !(file.type.startsWith('audio/') || /\.(wav|mp3|flac|ogg|m4a|aac|webm)$/i.test(file.name))) {
    invalidSourceFile.value = true;
    return;
  }
  pauseReplays();
  if (sourceFile.value === file) {
    return;
  }
  changingSource.value = true;
  invalidateSourceResearch({ preserve: activeLoadInvestigation() });
  sourceFile.value = file;
  lastRunFile.value = undefined;
  lastRecognitionFile.value = undefined;
  recordingSnapshot.value = undefined;
  responseRecordingSnapshot.value = undefined;
  invalidSourceFile.value = false;
  fileOperationFailure.value = undefined;
  try {
    await speech.controller.clearFileRun();
    await recognition.controller.clearRun();
    await responseRecording.recording.discard();
  } catch (error) {
    fileOperationFailure.value = error instanceof Error ? error.message : String(error);
  } finally {
    changingSource.value = false;
  }
}

async function clearAudioFile(): Promise<void> {
  if (filePending.value || recognitionRunning.value || recordingActive.value) {
    return;
  }
  pauseReplays();
  invalidateSourceResearch({ preserve: activeLoadInvestigation() });
  sourceFile.value = undefined;
  lastRunFile.value = undefined;
  lastRecognitionFile.value = undefined;
  recordingSnapshot.value = undefined;
  responseRecordingSnapshot.value = undefined;
  invalidSourceFile.value = false;
  fileOperationFailure.value = undefined;
  await speech.controller.clearFileRun();
  await recognition.recording.discard();
  await responseRecording.recording.discard();
  await recognition.controller.clearRun();
}

async function startRecognitionRecording(): Promise<void> {
  if (sourceBlocked.value) {
    return;
  }
  pauseReplays();
  recordingSnapshot.value = undefined;
  fileOperationFailure.value = undefined;
  const model = startingModel.value ? undefined : recognitionState.value.runtime.model;
  if (model) {
    investigationExportSource.value = 'single';
    singleInvestigationKind = 'trial';
  }
  recognitionInvestigation = model ? investigationCapture.prepareRun({ task: 'recognition', modelId: residentModelId.value, modelFile: residentModelFile.value, model, file: undefined, recording: true, language: recognitionLanguageValue.value, seed: undefined, maxSeconds: undefined, inputPacing: undefined, instructions: undefined }) : undefined;
  const attempt = recognitionInvestigation ? { binding: recognitionInvestigation, previousRunId: recognitionState.value.run?.id, acceptedRunId: undefined } : undefined;
  recognitionRecordingAttempt = attempt;
  await recognition.recording.start({ language: recognitionLanguageValue.value, ...(recognitionInvestigation ? { investigation: recognitionInvestigation } : {}) });
  if (attempt && recognitionRecordingAttempt === attempt && recordingState.value.phase === 'idle') {
    investigationCapture.runCancelled({ context: attempt.binding.context, reason: 'Microphone opening was cancelled before recognition' });
  }
}

async function stopRecognitionRecording(): Promise<void> {
  const attempt = recognitionRecordingAttempt;
  await recognition.recording.stop();
  if (attempt && recognitionRecordingAttempt === attempt && attempt.acceptedRunId === undefined) {
    investigationCapture.runCancelled({ context: attempt.binding.context, reason: 'Recording stopped without a recognition run' });
  }
}

async function discardRecognitionRecording(): Promise<void> {
  const file = currentRecordingSnapshot.value?.file ?? recordingSnapshot.value?.file;
  await recognition.recording.discard();
  if (recognitionRecordingAttempt) {
    investigationCapture.runCancelled({ context: recognitionRecordingAttempt.binding.context, reason: 'User discarded recording before recognition' });
  }
  recordingSnapshot.value = undefined;
  if (file !== undefined && sourceFile.value === file) {
    await clearAudioFile();
  }
}

async function startResponseRecording(): Promise<void> {
  if (sourceBlocked.value) {
    return;
  }
  pauseReplays();
  responseRecordingSnapshot.value = undefined;
  fileOperationFailure.value = undefined;
  await responseRecording.recording.start();
}

async function stopActiveRecording(): Promise<void> {
  switch (recordingOwner.value) {
  case 'response': await responseRecording.recording.stop();
    break;
  case 'transcription': await stopRecognitionRecording();
    break;
  case undefined: break;
  default: {
    const exhaustive: never = recordingOwner.value;
    throw new Error(String(exhaustive));
  }
  }
}

async function discardResponseRecording(): Promise<void> {
  const file = currentRecordingSnapshot.value?.file ?? responseRecordingSnapshot.value?.file;
  await responseRecording.recording.discard();
  responseRecordingSnapshot.value = undefined;
  if (file !== undefined && sourceFile.value === file) {
    await clearAudioFile();
  }
}

async function discardActiveRecording(): Promise<void> {
  switch (recordingOwner.value) {
  case 'response': await discardResponseRecording();
    break;
  case 'transcription': await discardRecognitionRecording();
    break;
  case undefined: break;
  default: {
    const exhaustive: never = recordingOwner.value;
    throw new Error(String(exhaustive));
  }
  }
}

function matchingResidentLoad({ snapshot }: { snapshot: SpeechInvestigationSnapshot }): SpeechInvestigationSnapshot | undefined {
  const load = residentLoadSnapshot.value;
  const identity = residentLoadIdentity.value;
  if (!load || !identity || identity.file !== residentModelFile.value || identity.modelId !== residentModelId.value || load.operation.task !== snapshot.operation.task || load.operation.model.name !== snapshot.operation.model.name || load.operation.model.bytes !== snapshot.operation.model.bytes) {
    return undefined;
  }
  const id = snapshot.operation.model.id;
  switch (id.status) {
  case 'observed': return id.value === identity.modelId ? load : undefined;
  case 'unset': case 'unknown': case 'unavailable': case 'not_applicable': return undefined;
  default: {
    const exhaustive: never = id;
    throw new Error(String(exhaustive));
  }
  }
}

function captureExportCollection(): SpeechInvestigationCollectionSnapshot | undefined {
  if (comparisonExport.value) {
    refreshResponseComparison();
    return responseComparisonSnapshot.value;
  }
  const snapshot = investigationCapture.snapshot();
  if (!snapshot) {
    return undefined;
  }
  if (singleExportCollection?.operationId !== snapshot.id) {
    singleExportCollection?.collection.clear();
    const load = singleInvestigationKind === 'load';
    const plan = createInvestigationPlan({
      operation: snapshot.operation,
      tailSeconds: { status: 'not_applicable', reason: load ? 'Model loading has no input tail' : 'Recognition does not submit a dialogue tail' },
      trials: load ? [] : [{ id: snapshot.id, inputLevel: { status: 'not_applicable', reason: 'This standalone operation has no input-volume comparison' } }],
    });
    const collection = createSpeechInvestigationCollection({ plan, sourceAudio: snapshot.audio.source });
    singleExportCollection = { operationId: snapshot.id, collection };
    if (!load) {
      const loaded = matchingResidentLoad({ snapshot });
      if (loaded) {
        collection.setLoad({ snapshot: loaded });
      }
      collection.startTrial({ trialId: snapshot.id });
    }
  }
  const collection = singleExportCollection.collection;
  switch (singleInvestigationKind) {
  case 'load': collection.setLoad({ snapshot });
    return collection.snapshot({ active: undefined });
  case 'trial':
    switch (snapshot.status) {
    case 'in_progress': return collection.snapshot({ active: { trialId: snapshot.id, snapshot } });
    case 'completed': case 'partial': case 'cancelled': case 'failed':
      collection.completeTrial({ trialId: snapshot.id, snapshot, retention: 'available' });
      return collection.snapshot({ active: undefined });
    default: {
      const exhaustive: never = snapshot.status;
      throw new Error(String(exhaustive));
    }
    }
  default: {
    const exhaustive: never = singleInvestigationKind;
    throw new Error(String(exhaustive));
  }
  }
}

async function downloadInvestigation({ includeInputAudio, includeInputText }: { includeInputAudio: SpeechInvestigationExportOptions['includeInputAudio'], includeInputText: SpeechInvestigationExportOptions['includeInputText'] }): Promise<void> {
  if (lastRunFile.value && speechState.value.fileRun) {
    investigationCapture.response({ run: speechState.value.fileRun, modelId: residentModelId.value, model: speechState.value.runtime.model, file: lastRunFile.value, instructions: undefined, beginRun: false });
  }
  if (lastRecognitionFile.value && recognitionState.value.run) {
    investigationCapture.recognition({ run: recognitionState.value.run, modelId: residentModelId.value, model: recognitionState.value.runtime.model, file: lastRecognitionFile.value, language: undefined, recording: recordingSnapshot.value?.file === lastRecognitionFile.value, beginRun: false });
  }
  const collection = captureExportCollection();
  if (!collection || investigationSaving.value) {
    return;
  }
  const lifetime = new AbortController();
  investigationExportLifetime = lifetime;
  investigationSaving.value = true;
  investigationExportFailure.value = undefined;
  try {
    await downloadSpeechInvestigation({ collection, includeInputAudio, includeInputText, signal: lifetime.signal });
  } catch (error) {
    if (!lifetime.signal.aborted && !disposed) {
      investigationExportFailure.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (investigationExportLifetime === lifetime) {
      investigationExportLifetime = undefined;
      investigationSaving.value = false;
    }
  }
}

async function clearInvestigation(): Promise<void> {
  const comparison = comparisonExport.value;
  await cancelResponseComparison({ reason: 'User cleared investigation record' });
  clearResponseComparison();
  if (comparison) {
    await speech.controller.clearFileRun();
  }
  residentLoadSnapshot.value = undefined;
  residentLoadIdentity.value = undefined;
  singleExportCollection?.collection.clear();
  singleExportCollection = undefined;
  investigationExportLifetime?.abort();
  investigationCapture.clear();
  investigationExportFailure.value = undefined;
}

function cancelInvestigationExport(): void {
  investigationExportLifetime?.abort();
}

function refreshResponseComparison(): void {
  const snapshot = investigationCapture.snapshot();
  const active = responseTrialId.value && responseInvestigation && snapshot?.id === responseInvestigation.context.operationId ? { trialId: responseTrialId.value, snapshot } : undefined;
  responseComparisonSnapshot.value = responseCollection?.snapshot({ active });
}

function clearResponseComparison(): void {
  responseResultViews.clear();
  responseResults.value = [];
  responseCollection?.clear();
  responseCollection = undefined;
  responseComparisonSnapshot.value = undefined;
  responseComparisonSource.value = undefined;
  responseTrialId.value = undefined;
  responseTrialRunId.value = undefined;
  if (comparisonExport.value) {
    investigationCapture.clear();
    investigationExportSource.value = 'single';
  }
}

async function cancelResponseComparison({ reason }: { reason: string }): Promise<void> {
  if (!responseComparisonLifetime) {
    return;
  }
  responseComparisonLifetime.abort();
  responseCollection?.stop({ status: 'cancelled', reason });
  refreshResponseComparison();
  await speech.controller.stop({ mode: 'cancel' });
  await responseComparisonTask;
}

async function generateResponseComparison({ file }: { file: File }): Promise<void> {
  const model = speechState.value.runtime.model;
  if (!model) {
    return;
  }
  const context = {
    file,
    model,
    modelId: residentModelId.value,
    modelFile: residentModelFile.value,
    language: conversationLanguage.value,
    seed: fileSeed.value,
    maxSeconds: maxSeconds.value,
    inputPacing: fileInputPacing.value,
    instructions: instructions.value || undefined,
    recording: currentRecordingSnapshot.value?.file === file,
    modelLoadMilliseconds: modelLoadMilliseconds.value,
    load: residentLoadSnapshot.value,
    trials: fileInputLevels.value.map(requested => ({ id: nanoid(), requested: snapshotInputLevel({ requested }) })),
  };
  clearResponseComparison();
  const lifetime = new AbortController();
  responseComparisonLifetime = lifetime;
  responseComparisonSource.value = file;
  function prepare(): SpeechInvestigationBinding {
    return investigationCapture.prepareRun({ task: 'dialogue', modelId: context.modelId, modelFile: context.modelFile, model: context.model, file: context.file, recording: context.recording, language: context.language, seed: context.seed, maxSeconds: context.maxSeconds, inputPacing: context.inputPacing, instructions: context.instructions });
  }
  let collection: ReturnType<typeof createSpeechInvestigationCollection> | undefined;
  singleInvestigationKind = 'trial';
  try {
    responseInvestigation = prepare();
    const initial = investigationCapture.snapshot();
    if (!initial) {
      throw new Error('No comparison operation snapshot');
    }
    const plan = createInvestigationPlan({ operation: initial.operation, tailSeconds: { status: 'observed', value: tailSeconds, source: 'UI comparison acceptance' }, trials: context.trials.map(trial => ({ id: trial.id, inputLevel: { status: 'observed', value: trial.requested, source: 'UI comparison acceptance' } })) });
    collection = createSpeechInvestigationCollection({ plan, sourceAudio: { status: 'retained', blob: file, format: file.type === 'audio/wav' || file.name.toLowerCase().endsWith('.wav') ? 'wav' : 'bin', description: 'One original source File shared by all comparison conditions' } });
    responseCollection = collection;
    investigationExportSource.value = 'comparison';
    if (context.load) {
      collection.setLoad({ snapshot: context.load });
    }
    refreshResponseComparison();
    for (const [index, trial] of context.trials.entries()) {
      if (lifetime.signal.aborted || disposed || responseCollection !== collection || !collection.startTrial({ trialId: trial.id })) {
        break;
      }
      responseTrialId.value = trial.id;
      responseTrialRunId.value = undefined;
      if (index > 0) {
        responseInvestigation = prepare();
      }
      refreshResponseComparison();
      lastRunFile.value = context.file;
      await speech.controller.runFile({ file: context.file, maxSeconds: context.maxSeconds, language: context.language, persona: context.instructions, name: undefined, tailSeconds, seed: context.seed, inputPacing: context.inputPacing, inputLevel: trial.requested, maximumRetainedAudioBytes: collection.remainingAudioBytes(), investigation: responseInvestigation });
      if (disposed || responseCollection !== collection) {
        break;
      }
      const run = speechState.value.fileRun;
      const snapshot = investigationCapture.snapshot();
      if (!run || !snapshot || snapshot.id !== responseInvestigation.context.operationId || snapshot.status === 'in_progress') {
        throw new Error('Comparison trial did not produce a terminal snapshot');
      }
      const accepted = collection.completeTrial({ trialId: trial.id, snapshot, retention: run.audioRetention.status });
      if (!accepted) {
        break;
      }
      const view = accepted.trial.snapshot ? responseResultViews.retain({ trialId: trial.id, run, audio: accepted.trial.snapshot.audio, modelLoadMilliseconds: context.modelLoadMilliseconds }) : { trialId: trial.id, run: { ...run, input: undefined, output: undefined }, modelLoadMilliseconds: context.modelLoadMilliseconds };
      responseResults.value = [...responseResults.value, view];
      responseTrialId.value = undefined;
      responseTrialRunId.value = undefined;
      refreshResponseComparison();
      if (lifetime.signal.aborted) {
        break;
      }
      switch (accepted.kind) {
      case 'limit':
        switch (run.audioRetention.status) {
        case 'available': fileOperationFailure.value = accepted.trial.capture.reason;
          break;
        case 'limit': break;
        default: {
          const exhaustive: never = run.audioRetention.status;
          throw new Error(String(exhaustive));
        }
        }
        break;
      case 'accepted':
        switch (run.status) {
        case 'complete': continue;
        case 'partial': collection.stop({ status: 'partial', reason: 'Current condition ended before completion' });
          break;
        case 'failed': collection.stop({ status: 'failed', reason: run.failure?.message ?? 'Current condition failed' });
          break;
        case 'decoding': case 'running': throw new Error('Comparison condition is still running');
        default: {
          const exhaustive: never = run.status;
          throw new Error(String(exhaustive));
        }
        }
        break;
      default: {
        const exhaustive: never = accepted.kind;
        throw new Error(String(exhaustive));
      }
      }
      break;
    }
  } catch (error) {
    collection?.stop({ status: 'failed', reason: error instanceof Error ? error.message : String(error) });
    if (responseInvestigation) {
      investigationCapture.runFailed({ context: responseInvestigation.context, failure: speechFailure({ error }) });
    }
    throw error;
  } finally {
    if (responseComparisonLifetime === lifetime) {
      responseComparisonLifetime = undefined;
      responseTrialId.value = undefined;
      responseTrialRunId.value = undefined;
      if (!disposed && responseCollection === collection) {
        refreshResponseComparison();
      }
    }
  }
}

async function generateFile(): Promise<void> {
  const file = sourceFile.value;
  if (!file || (currentInputSource.value === 'microphone' && !currentRecordingSnapshot.value) || !(transcriptionInvestigation.value ? canTranscribeFile.value : canGenerateFile.value)) {
    return;
  }
  pauseReplays();
  fileTask.value = investigationTask.value;
  filePending.value = true;
  fileOperationFailure.value = undefined;
  try {
    const task = investigationTask.value;
    switch (task) {
    case 'response': {
      const task = generateResponseComparison({ file });
      responseComparisonTask = task;
      try {
        await task;
      } finally {
        if (responseComparisonTask === task) {
          responseComparisonTask = undefined;
        }
      }
      break;
    }
    case 'transcription': {
      investigationExportSource.value = 'single';
      singleInvestigationKind = 'trial';
      const model = recognitionState.value.runtime.model;
      if (!model) {
        return;
      }
      recognitionInvestigation = investigationCapture.prepareRun({ task: 'recognition', modelId: residentModelId.value, modelFile: residentModelFile.value, model, file, recording: currentRecordingSnapshot.value?.file === file, language: recognitionLanguageValue.value, seed: undefined, maxSeconds: undefined, inputPacing: undefined, instructions: undefined });
      lastRecognitionFile.value = file;
      await recognition.controller.runFile({ file, language: recognitionLanguageValue.value, investigation: recognitionInvestigation });
      break;
    }
    default: {
      const exhaustive: never = task;
      throw new Error(String(exhaustive));
    }
    }
  } catch (error) {
    fileOperationFailure.value = error instanceof Error ? error.message : String(error);
  } finally {
    filePending.value = false;
    fileTask.value = undefined;
  }
}

function setInvestigationTask({ task }: { task: LiveInvestigationTask }): void {
  pauseReplays();
  emit('investigationTask', task);
}

async function cancelFile(): Promise<void> {
  if (recordingActive.value) {
    await discardActiveRecording();
    return;
  }
  const task = activeFileTask.value ?? investigationTask.value;
  switch (task) {
  case 'response':
    if (responseComparisonLifetime) {
      await cancelResponseComparison({ reason: 'User cancelled comparison' });
    } else {
      await speech.controller.stop({ mode: 'cancel' });
    }
    break;
  case 'transcription': await recognition.controller.cancel();
    break;
  default: {
    const exhaustive: never = task;
    throw new Error(String(exhaustive));
  }
  }
}

async function loadSelectedModel(): Promise<void> {
  if (!canLoadSelectedModel.value) {
    return;
  }
  clearResponseComparison();
  void speech.controller.clearFileRun();
  changingConversation.value = true;
  try {
    pauseReplays();
    if (active.value) {
      await releaseResident();
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

watch(investigationTask, pauseReplays);

watch(diagnostics, async () => {
  pauseReplays();
  if (!filePending.value && speechRunning.value) {
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
  investigationExportLifetime?.abort();
  investigationCapture.clear();
  singleExportCollection?.collection.clear();
  responseComparisonLifetime?.abort();
  clearResponseComparison();
  scan?.abort();
  inspect?.abort();
  modelOpening?.abort();
  candidateScan?.abort();
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
            <LlamaCppBrowserModelSuggestions :suggestions="modelSuggestions" :models="models" :disabled="false" :default-model="undefined" :default-action-disabled="changingConversation" selection-action="select" memory-filter="hide" @select="catalogSelect({ model: $event })" @changed="refreshInventory" />
            <SettingsDisclosure :title="lazyStrings.liveConversation__manage_models_and_runtime()" test-id="live-model-manager">
              <template #icon><FolderOpenIcon tw-class="h-4 w-4" /></template>
              <div tw-class="space-y-4"><p tw-class="text-xs leading-6 text-gray-500 dark:text-gray-400">{{ selectedEngine === 'speech' ? lazyStrings.liveConversation__speech_model_setup() : lazyStrings.liveConversation__model_setup() }}</p><LlamaCppBrowserManager presentation="embedded" suggestions="none" :runtime-settings="selectedEngine === 'llama' ? 'show' : 'hide'" :suspended="active || startingModel" @models-changed="updateModels({ entries: $event })" @model-selected="selectModel({ value: $event })" @runtime-ready="runtimeReady = $event" /></div>
            </SettingsDisclosure>
            <button v-if="!active && !startingModel" type="button" :disabled="!canStart || changingConversation" @click="start" tw-class="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40" data-testid="live-start">{{ !llamaMode ? lazyStrings.liveConversation__load_model() : lazyStrings.liveConversation__start_session() }}</button>
            <button v-if="active && modelId !== residentModelId" type="button" :disabled="!canLoadSelectedModel" @click="loadSelectedModel" tw-class="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40" data-testid="live-load-model">{{ lazyStrings.liveConversation__load_model() }}</button>
            <div v-if="startingModel" tw-class="space-y-3" data-testid="live-model-loading"><LiveModelLoadProgress :progress="modelLoadProgress" :ready="modelLoadReady" :generation="modelLoadGeneration" /><button type="button" :disabled="changingConversation" @click="cancelModelLoading" tw-class="rounded-lg px-3 py-2 text-xs text-gray-600 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-800" data-testid="live-cancel-model-loading">{{ lazyStrings.liveConversation__cancel_model_loading() }}</button></div>
            <SettingsDisclosure v-if="!recognitionMode" :title="lazyStrings.liveConversation__channels_and_playback()" test-id="live-channel-settings">
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
            <SettingsDisclosure v-if="!recognitionMode" :title="lazyStrings.liveConversation__session_setup()" test-id="live-session-settings">
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
        <p v-if="recordingActive && !recordingVisible" role="status" tw-class="flex flex-wrap items-center gap-3 text-xs leading-6 text-blue-600 dark:text-blue-400" data-testid="live-recording-background-status"><MicIcon aria-hidden="true" tw-class="h-4 w-4" /><span>{{ activeRecordingState.phase === 'opening' ? lazyStrings.liveConversation__preparing_audio() : activeRecordingState.phase === 'stopping' ? lazyStrings.liveConversation__stopping() : lazyStrings.liveConversation__microphone_recording_in_progress() }} · {{ activeRecordingState.elapsedSeconds.toFixed(1) }} s</span><button type="button" :disabled="activeRecordingState.phase === 'stopping'" @click="stopActiveRecording" tw-class="rounded px-2 py-1 underline disabled:opacity-40" data-testid="live-recording-background-stop">{{ lazyStrings.liveConversation__stop_microphone_recording() }}</button><button type="button" @click="discardActiveRecording" tw-class="rounded px-2 py-1 underline" data-testid="live-recording-background-discard">{{ lazyStrings.liveConversation__discard_microphone_recording() }}</button></p>
        <p v-if="(filePending || recognitionRunning) && (!diagnostics || activeFileTask !== investigationTask)" role="status" tw-class="flex flex-wrap items-center gap-3 text-xs leading-6 text-gray-500 dark:text-gray-400" data-testid="live-investigation-background-status"><span>{{ activeFileTask === 'transcription' ? lazyStrings.liveConversation__transcribing_audio_file() : lazyStrings.liveConversation__generating_response() }}</span><button type="button" @click="activeFileTask && setInvestigationTask({ task: activeFileTask })" tw-class="rounded text-blue-600 underline dark:text-blue-400" data-testid="live-investigation-open-running">{{ activeFileTask === 'transcription' ? lazyStrings.liveConversation__audio_to_transcription() : lazyStrings.liveConversation__audio_to_response() }}</button><button type="button" @click="cancelFile" tw-class="rounded text-gray-600 underline dark:text-gray-300" data-testid="live-investigation-cancel-running">{{ lazyStrings.SHARED__cancel() }}</button></p>
        <LiveConversationDiagnostics v-if="diagnostics" ref="fileView" :file="sourceFile" :task="investigationTask" :busy="filePending || recognitionRunning || recordingActive" :blocked="sourceBlocked && !(filePending || recognitionRunning || recordingActive)" :file-input="currentInputSource === 'file' ? 'shown' : 'hidden'" :playback-blocked="recordingActive" @task="setInvestigationTask({ task: $event })" @select="selectAudioFile({ files: $event })" @clear="clearAudioFile" @replay-start="replayStarted({ element: $event })" @replay-end="replayEnded({ element: $event })">
          <template #input-controls><LiveSpeechRecordingInput purpose="transcription" v-if="investigationTask === 'transcription'" :source="recognitionInputSource" :state="recordingState" :clip="currentRecordingSnapshot" :blocked="sourceBlocked && !recognitionRecordingActive" @source="recognitionInputSource = $event" @start="startRecognitionRecording" @stop="stopRecognitionRecording" @discard="discardRecognitionRecording" @replay-start="replayStarted({ element: $event })" @replay-end="replayEnded({ element: $event })" /><LiveSpeechRecordingInput v-else purpose="response" :source="responseInputSource" :state="responseRecordingState" :clip="currentRecordingSnapshot" :blocked="sourceBlocked && !responseRecordingActive" @source="responseInputSource = $event" @start="startResponseRecording" @stop="responseRecording.recording.stop()" @discard="discardResponseRecording" @replay-start="replayStarted({ element: $event })" @replay-end="replayEnded({ element: $event })" /></template>
          <template #model><div tw-class="space-y-3 rounded-xl border border-gray-200/70 bg-white/70 p-4 dark:border-gray-800 dark:bg-gray-900/40"><label :for="`${id}-diagnostic-model`" tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__model() }}</label><ModelSelector surface="settings" :input-id="`${id}-diagnostic-model`" :model-value="modelId || undefined" :models="diagnosticModelIds" :loading="diagnosticModelsScanning || selectedEngine === 'checking'" :disabled="navigationBusy" :placeholder="lazyStrings.liveConversation__choose_model()" @update:model-value="selectModel({ value: $event })" @refresh="refreshInventory" data-testid="live-diagnostics-model" /><div tw-class="flex flex-wrap items-center gap-3"><button type="button" :disabled="!canLoadSelectedModel" @click="loadSelectedModel" tw-class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300 dark:hover:bg-gray-800" data-testid="live-diagnostics-load-model">{{ lazyStrings.liveConversation__load_model() }}</button><span v-if="active" data-testid="live-diagnostics-resident-model" tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__loaded_model({ name: residentModelId }) }}</span><button v-if="startingModel" type="button" @click="cancelModelLoading" data-testid="live-diagnostics-cancel-model" tw-class="rounded text-xs text-blue-600 underline dark:text-blue-400">{{ lazyStrings.liveConversation__cancel_model_loading() }}</button></div><LiveModelLoadProgress v-if="startingModel" :progress="modelLoadProgress" :ready="modelLoadReady" :generation="modelLoadGeneration" /><p v-if="modelId && !diagnosticModelsScanning && !diagnosticSelectionSupported" role="status" tw-class="text-xs leading-6 text-amber-700 dark:text-amber-300" data-testid="live-investigation-model-mismatch">{{ investigationTask === 'transcription' ? lazyStrings.liveConversation__transcription_model_required() : lazyStrings.liveConversation__audio_file_generation_unavailable() }}</p><p v-if="modelFailure" role="alert" tw-class="break-words text-xs text-red-600 dark:text-red-400">{{ modelFailure }}</p></div></template>
          <LiveSpeechResponseInvestigation v-if="investigationTask === 'response'" :file="sourceFile" :run="responseRun" :text="fileText" :results="visibleResponseResults" :comparison="visibleResponseComparison" :busy="filePending && fileTask === 'response'" :blocked="sourceBlocked && !(filePending && fileTask === 'response')" :can-generate="canGenerateFile" :unavailable="fileUnavailable" :selection-failure="fileSelectionFailure" :tail-seconds="tailSeconds" :seed="fileSeed" :input-pacing="fileInputPacing" :input-levels="fileInputLevels" :queued-samples="speechState.runtime.queuedSamples" :model-load-milliseconds="modelLoadMilliseconds" @seed="fileSeed = $event" @input-pacing="fileInputPacing = $event" @input-levels="fileInputLevels = $event" @generate="generateFile" @cancel="cancelFile" @settings="settingsOpen = true" @replay-start="replayStarted({ element: $event })" @replay-end="replayEnded({ element: $event })">
            <template #settings><div tw-class="space-y-2"><label :for="`${id}-diagnostic-language`" tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__conversation_language() }}</label><span tw-class="block w-full sm:max-w-xs"><SettingsFormSelect :id="`${id}-diagnostic-language`" v-model="conversationLanguage" :options="conversationLanguageOptions" :label="lazyStrings.liveConversation__conversation_language()" :disabled="sourceBlocked" :aria-describedby="`${id}-diagnostic-language-help`" data-testid="live-diagnostics-language" /></span><p :id="`${id}-diagnostic-language-help`" data-testid="live-diagnostics-language-help" tw-class="text-xs leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__conversation_language_help() }}</p></div><label tw-class="block space-y-2 text-xs font-medium text-gray-600 dark:text-gray-300"><span>{{ lazyStrings.liveConversation__instructions() }}</span><textarea v-model="instructions" :disabled="sourceBlocked" rows="2" maxlength="16384" tw-class="block w-full rounded-lg border border-gray-200 bg-transparent p-3 text-sm disabled:opacity-40 dark:border-gray-700" data-testid="live-diagnostics-instructions" /></label></template>
          </LiveSpeechResponseInvestigation>
          <LiveSpeechRecognitionInvestigation v-else :file="sourceFile" :run="recognitionRun" :model="recognitionState.runtime.model" :language="recognitionLanguage" :progress="recognitionState.runtime.progress" :busy="(filePending && activeFileTask === 'transcription') || recognitionRunning" :blocked="sourceBlocked && !((filePending && activeFileTask === 'transcription') || recognitionRunning)" :can-transcribe="canTranscribeFile" :unavailable="transcriptionUnavailable" :failure="fileSelectionFailure" @language="recognitionLanguage = $event" @generate="generateFile" @cancel="cancelFile" @settings="settingsOpen = true" />
          <LiveSpeechInvestigationExport :capture-id="exportCaptureId" :saving="investigationSaving" :failure="investigationExportFailure" @download="downloadInvestigation" @clear="clearInvestigation" @cancel="cancelInvestigationExport" />
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
                <div v-if="session.inputAudio" tw-class="space-y-2"><h3 tw-class="font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__input_audio() }}</h3><audio :src="session.inputAudio.url" controls preload="none" :inert="speechRunning || recordingActive ? true : undefined" :aria-disabled="speechRunning || recordingActive" @play="replayConversationAudio({ event: $event, action: 'start' })" @pause="replayConversationAudio({ event: $event, action: 'end' })" @ended="replayConversationAudio({ event: $event, action: 'end' })" :aria-label="lazyStrings.liveConversation__input_audio()" :tw-class="speechRunning || recordingActive ? 'h-10 w-full opacity-50' : 'h-10 w-full'" data-testid="live-speech-input-replay" /><a :href="session.inputAudio.url" :download="`naidan-live-${session.id}-input.wav`" tw-class="inline-flex min-h-8 items-center gap-1.5 rounded text-blue-600 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400" data-testid="live-speech-download-input"><DownloadIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.liveConversation__save_input_audio_wav() }}</a></div>
                <div v-if="session.outputAudio" tw-class="space-y-2"><h3 tw-class="font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__voice_response() }}</h3><audio :src="session.outputAudio.url" controls preload="none" :inert="speechRunning || recordingActive ? true : undefined" :aria-disabled="speechRunning || recordingActive" @play="replayConversationAudio({ event: $event, action: 'start' })" @pause="replayConversationAudio({ event: $event, action: 'end' })" @ended="replayConversationAudio({ event: $event, action: 'end' })" :aria-label="lazyStrings.liveConversation__voice_response()" :tw-class="speechRunning || recordingActive ? 'h-10 w-full opacity-50' : 'h-10 w-full'" data-testid="live-speech-output-replay" /><a :href="session.outputAudio.url" :download="`naidan-live-${session.id}-response.wav`" tw-class="inline-flex min-h-8 items-center gap-1.5 rounded text-blue-600 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400" data-testid="live-speech-download-output"><DownloadIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.liveConversation__save_response_wav() }}</a></div>
                <p v-if="session.inputAudio?.status === 'partial' || session.outputAudio?.status === 'partial'" tw-class="text-[11px] leading-5 text-amber-700 dark:text-amber-300" data-testid="live-speech-partial-audio">{{ lazyStrings.liveConversation__partial_conversation_audio() }}</p>
              </div>
            </details>
            <p v-if="session.completion === 'max_seconds'" tw-class="text-xs leading-6 text-amber-700 dark:text-amber-300">{{ lazyStrings.liveConversation__conversation_time_limit_reached() }}</p><p v-else-if="session.completion" tw-class="text-[11px] text-gray-400 dark:text-gray-500">{{ lazyStrings.liveConversation__session_ended() }}</p>
          </article>
        </section>
        <div v-if="!diagnostics && state.failure" role="alert" tw-class="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-900/10 dark:text-red-400"><p>{{ lazyStrings.liveConversation__failed() }}</p><code tw-class="mt-2 block break-words">{{ state.failure }}</code></div>
        <p v-if="!diagnostics && audioWarning" role="status" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ audioWarning }}</p>
        <section v-if="!diagnostics && recognitionMode" tw-class="space-y-3 rounded-2xl border border-gray-200/70 bg-white/70 p-5 dark:border-gray-800 dark:bg-gray-900/40" data-testid="live-recognition-guidance"><p tw-class="text-sm leading-7 text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__transcription_model_is_not_for_conversation() }}</p><button type="button" @click="setInvestigationTask({ task: 'transcription' })" tw-class="rounded-lg px-3 py-2 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-40 dark:text-blue-400 dark:hover:bg-blue-900/20" data-testid="live-open-transcription">{{ lazyStrings.liveConversation__open_transcription_tools() }}</button></section>
        <p v-if="!diagnostics && llamaMode && !state.entries.length" tw-class="py-8 text-center text-sm leading-7 text-gray-500 dark:text-gray-400" data-testid="live-empty">{{ state.phase === 'loading' ? lazyStrings.liveConversation__loading() : active ? lazyStrings.liveConversation__ready_to_talk() : lazyStrings.liveConversation__download_then_start() }}</p>
        <LiveConversationHistory v-if="!diagnostics && llamaMode" ref="history" @layout="historyScroll.follow" @replay-start="replayStarted({ element: $event })" @replay-end="replayEnded({ element: $event })" :entries="state.entries" :hide-text="hideText" />
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
        <div tw-class="flex min-h-8 items-center gap-2"><span role="status" tw-class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400" data-testid="live-status"><Loader2Icon v-if="llamaMode && active && state.phase !== 'ready' && state.phase !== 'recording' && state.phase !== 'approval'" aria-hidden="true" tw-class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{{ status }}</span>
          <button v-if="llamaMode && busy && !['loading', 'closing', 'stopping'].includes(state.phase)" type="button" @click="interrupt" :title="lazyStrings.liveConversation__interruption_help()" tw-class="ml-auto flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800" data-testid="live-interrupt"><SquareIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.liveConversation__stop_response() }}</button></div>
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
          <LiveSpeechInputLevel :level="speechState.inputLevel" :muted="!microphone" :blocked="changingConversation || startingModel || changingSource || recordingActive || recognitionRunning || filePending" @gain="speech.controller.setInputGain({ gain: $event })" @observe="speech.controller.observeInputLevel({ value: $event })" />
        </div>
        <p v-if="draftMessage" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ draftMessage }}</p>
        <p v-if="llamaMode && !draftSupported" role="alert" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.liveConversation__draft_channel_disabled() }}</p>
        <p v-if="llamaMode && !outputSelected" role="status" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.liveConversation__choose_output_channel() }}</p>
        <p v-if="state.phase === 'recording'" role="status" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.liveConversation__listening() }}</p>
        <LiveConversationInput v-if="llamaMode" ref="input" @replay-start="replayStarted({ element: $event })" @replay-end="replayEnded({ element: $event })" :draft="draft" :text-enabled="effectiveTextInput" :images-allowed="imageInput && vision" :can-submit="canSubmit" :can-talk="canTalk && draftSupported" :recording="state.phase === 'recording'" :busy="busy" @text="draft = { ...draft, text: $event }" @attach="attach({ files: $event })" @remove="removeAttachment({ url: $event })" @send="send" @talk="talk" @finish="controller.finishRecording()" />
        <p v-if="llamaMode && busy && state.phase !== 'recording'" tw-class="text-center text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__prepare_next_message() }}</p>
      </div>
    </footer>
    <div v-if="dragDepth > 0 && (diagnostics ? !sourceBlocked : llamaMode)" tw-class="pointer-events-none absolute inset-4 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-blue-400 bg-white/90 text-sm font-semibold text-blue-600 dark:bg-gray-900/90 dark:text-blue-400" data-testid="live-drop-overlay">{{ diagnostics ? lazyStrings.liveConversation__drop_or_choose_audio() : lazyStrings.liveConversation__drop_attachments() }}</div>
  </div>
</template>
