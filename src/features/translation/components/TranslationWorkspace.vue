<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, shallowRef, useId, watch } from 'vue';
import { ChevronRightIcon, LanguagesIcon, PictureInPicture2Icon, PlusIcon, SlidersHorizontalIcon, Trash2Icon } from 'lucide-vue-next';
import logoUrl from '@/assets/logo.svg?inline';
import { currentLocale, lazyStrings } from '@/strings';
import { useSettings } from '@/composables/useSettings';
import { useDocumentFloatingWindow } from '@/composables/useDocumentFloatingWindow';
import { splitModelIdDisplay } from '@/01-models/llama-cpp-browser-model-id';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import SettingsSelectScope from '@/components/SettingsSelectScope.vue';
import LlamaCppBrowserModelActionButton from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelActionButton.vue';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import TranslationModelSelector from './TranslationModelSelector.vue';
import { defaultTranslationModel } from '@/features/translation/model-catalog';
import { acquireRepositoryModel } from '@/features/llama-cpp-browser/model-launch/acquire-repository-model';
import type { RepositoryModelSelection } from '@/features/llama-cpp-browser/model-launch/bundled-repository-target';
import { useModelDownloadDestination } from '@/features/llama-cpp-browser/composables/useModelDownloadDestination';
import { getDownloadQueue } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { findLocalSuggestedModel } from '@/features/llama-cpp-browser/hugging-face/suggestion-plan';
import TranslationEditors from './TranslationEditors.vue';
import { automaticTranslationSettings } from '@/features/translation/automatic-settings';
import { useTranslationModelPreparation } from '@/features/translation/composables/useTranslationModelPreparation';
import { useAutomaticTranslation } from '@/features/translation/composables/useAutomaticTranslation';
import { useTranslationLanguages } from '@/features/translation/composables/useTranslationLanguages';
import type { EngineState, LocalModel } from '@/features/llama-cpp-browser/types';
import { useTranslationPreferences } from '@/features/translation/composables/useTranslationPreferences';
import { useTranslationSession } from '@/features/translation/composables/useTranslationSession';
import { inspectStoredTranslationModel } from '@/features/translation/model-detection';
import { translationProfile } from '@/features/translation/profiles';
import { registerTranslationNavigation } from '@/features/translation/navigation';
import type { TranslationDetection, TranslationGlossaryEntry, TranslationIssue } from '@/features/translation/types';
import { awaitInspection } from '@/logic/model-file-inspection/abort';

const id = useId();
const store = useSettings();
const { preferences, saving, failed: saveFailed, save, waitForSave } = useTranslationPreferences({ store });
const { phase, output, previousOutput, displayRevision, progress, issue, failure, busy, translate, stop, invalidate, reset } = useTranslationSession({ service: llamaCppBrowserService, inspectModel: inspectStoredTranslationModel });
const text = ref('');
const context = ref('');
const glossary = ref<TranslationGlossaryEntry[]>([]);
const form = ref<'default' | 'polite' | 'plain'>('default');
const detailsOpen = ref(false);
const detailsTrigger = ref<HTMLElement>();
const mainEditors = ref<InstanceType<typeof TranslationEditors>>();
const floatingOpenFailed = ref(false);
const floatingWindow = useDocumentFloatingWindow({
  enabled: store.initialized,
  title: () => lazyStrings.translation__translation() ?? document.title,
  width: 450,
  height: 410,
  includeAppStyles: true,
});
const floatingDocument = floatingWindow.document;
const floatingButtonLabel = computed(() => floatingWindow.supported ? lazyStrings.AudioTranscriptionWorkspace__open_floating_window() : lazyStrings.AudioTranscriptionWorkspace__floating_window_unavailable());
const storageEpoch = ref(0);
const copied = ref<'idle' | 'copied' | 'failed'>('idle');
const modelSelector = ref<InstanceType<typeof TranslationModelSelector>>();
const modelPickerOpen = ref(false);
const inventory = shallowRef<readonly LocalModel[]>();
const chosenRepositoryModel = shallowRef<RepositoryModelSelection>();
const acquiring = shallowRef<{ controller: AbortController, selection: RepositoryModelSelection, translateAfterDownload: boolean }>();
const activeDownloadId = ref<number>();
const downloadFailed = ref(false);
const runWhenReady = ref<string>();
const composingInput = shallowRef<HTMLTextAreaElement>();
const composing = computed(() => composingInput.value !== undefined);
const state = shallowRef<EngineState>(llamaCppBrowserService.getState());
const selectedDetection = shallowRef<TranslationDetection>();
const inspecting = ref(false);
const checkingSelection = ref(false);
const modelFailure = ref<'unreadable' | 'unsupported'>();
const selectionFailure = ref<'unreadable' | 'unsupported'>();
let inspection: AbortController | undefined;
let selection: AbortController | undefined;
let disposed = false;
let storageCurrent = store.initialized.value ? store.captureExperimentalStorage() : undefined;
const blocked = computed(() => saving.value || checkingSelection.value || changingLanguages.value || !store.initialized.value);
const downloadDestination = useModelDownloadDestination({ blocked: () => blocked.value || busy.value || acquiring.value !== undefined, changed: () => {} });
const downloadQueue = getDownloadQueue();
const downloadProgress = computed(() => downloadQueue.jobs.value.find(job => job.id === activeDownloadId.value)?.progress);
const modelId = computed(() => {
  const saved = preferences.value?.modelId;
  const models = inventory.value ?? [];
  if (saved) {
    return saved;
  }
  const quantization = defaultTranslationModel;
  const opfs = findLocalSuggestedModel({ quantization, models, destination: { kind: 'opfs' } });
  if (opfs !== undefined) {
    return opfs.modelId;
  }
  const linked = new Set(models.flatMap(({ source }) => source === undefined ? [] : [source.directoryId]));
  for (const directoryId of linked) {
    const model = findLocalSuggestedModel({ quantization, models, destination: { kind: 'host', directoryId } });
    if (model !== undefined) {
      return model.modelId;
    }
  }
  return undefined;
});
const pendingModel = computed<RepositoryModelSelection | undefined>(() => {
  if (!store.initialized.value) {
    return undefined;
  }
  if (chosenRepositoryModel.value !== undefined) {
    return { ...chosenRepositoryModel.value, destination: downloadDestination.destination.value, authorizeDestination: downloadDestination.authorize };
  }
  if (modelId.value) {
    return undefined;
  }
  const { hfRepository: repository, preferredQuantization: variant } = defaultTranslationModel;
  return {
    modelId: `hf.co/${repository}:${variant}`,
    source: { kind: 'bundled', repository, variant, companionPath: undefined },
    destination: downloadDestination.destination.value,
    authorizeDestination: downloadDestination.authorize,
  };
});
const floatingModel = computed(() => pendingModel.value?.modelId ?? modelId.value);
const floatingModelName = computed(() => floatingModel.value === undefined ? undefined : splitModelIdDisplay({ modelId: floatingModel.value }).name);
const automaticSettings = computed(() => automaticTranslationSettings({ value: preferences.value?.autoTranslate }));
const autoTranslate = computed(() => automaticSettings.value.enabled);
const debounceMs = computed(() => automaticSettings.value.debounceMs);
const profile = computed(() => {
  const detection = selectedDetection.value;
  if (pendingModel.value !== undefined) {
    return translationProfile({ id: 'plamo3-translate' });
  }
  if (detection === undefined) {
    return undefined;
  }
  switch (detection.status) {
  case 'supported': return translationProfile({ id: detection.profileId });
  case 'unsupported': return undefined;
  default: {
    const exhaustive: never = detection;
    throw new Error(String(exhaustive));
  }
  }
});
const preparation = useTranslationModelPreparation({
  service: llamaCppBrowserService,
  modelId: computed(() => store.initialized.value && selectedDetection.value?.status === 'supported' && pendingModel.value === undefined ? modelId.value : undefined),
  engine: state,
  generating: computed(() => busy.value || acquiring.value !== undefined),
  storageEpoch,
});
const languages = useTranslationLanguages({ defaultTarget: computed(() => profile.value?.defaultTargetLanguage ?? 'ja') });
const { sourceLang, targetLang, invalid: invalidLanguages, changing: changingLanguages, failed: languageFailure } = languages;
const canUseInput = computed(() => !blocked.value && !busy.value && acquiring.value === undefined && !modelPickerOpen.value && !invalidLanguages.value && state.value.status !== 'unavailable' && !!text.value.trim());
const canTranslate = computed(() => canUseInput.value && pendingModel.value === undefined && preparation.ready.value && !inspecting.value && state.value.status !== 'working' && !!profile.value && !!modelId.value);
const canDownload = computed(() => canUseInput.value && pendingModel.value !== undefined && inventory.value !== undefined && !downloadDestination.unavailable.value && !downloadDestination.view.busy.value);
const canSwap = computed(() => !blocked.value && sourceLang.value !== undefined && profile.value?.sourceLanguages.includes(targetLang.value) === true && profile.value.targetLanguages.includes(sourceLang.value));
const languageSearch = computed(() => ({ label: lazyStrings.translation__search_languages(), noResults: lazyStrings.translation__no_matching_languages() }));
const options = computed(() => {
  const names = new Intl.DisplayNames([currentLocale.value], { type: 'language' });
  const english = new Intl.DisplayNames(['en'], { type: 'language' });
  const option = ({ code }: { code: string }) => ({
    value: code,
    label: code === 'ja(easy)' ? lazyStrings.translation__easy_japanese() : names.of(code) ?? code,
    searchTerms: [code, code === 'ja(easy)' ? 'Japanese (easy)' : english.of(code) ?? code],
  });
  const sources = (profile.value?.sourceLanguages ?? []).map(code => option({ code }));
  const targets = (profile.value?.targetLanguages ?? []).map(code => option({ code }));
  // Unsupported URL values remain visible, but cannot be run or silently replaced.
  if (sourceLang.value && !sources.some(item => item.value === sourceLang.value)) {
    sources.push({ value: sourceLang.value, label: sourceLang.value, searchTerms: [sourceLang.value] });
  }
  if (!targets.some(item => item.value === targetLang.value)) {
    targets.push({ value: targetLang.value, label: targetLang.value, searchTerms: [targetLang.value] });
  }
  return { sources: [{ value: '', label: lazyStrings.translation__detect_language(), disabled: profile.value?.sourceDetection === 'unavailable', searchTerms: ['auto'] }, ...sources], targets };
});
const formOptions = computed(() => [
  { value: 'default' as const, label: lazyStrings.translation__default_style() },
  { value: 'polite' as const, label: lazyStrings.translation__polite_style() },
  { value: 'plain' as const, label: lazyStrings.translation__plain_style() },
]);
const statusLabel = computed(() => {
  switch (phase.value) {
  case 'idle': return undefined;
  case 'checking': return lazyStrings.translation__checking_model();
  case 'preparing': return lazyStrings.translation__preparing_model();
  case 'prefill': return lazyStrings.translation__processing_source();
  case 'generating': return lazyStrings.translation__translating();
  case 'stopping': return lazyStrings.translation__stopping();
  case 'complete': return undefined;
  case 'stopped': return lazyStrings.translation__translation_stopped();
  case 'truncated': return lazyStrings.translation__translation_truncated();
  case 'error': return lazyStrings.translation__translation_failed();
  default: {
    const exhaustive: never = phase.value;
    throw new Error(String(exhaustive));
  }
  }
});
const issueLabel = computed(() => {
  const value: TranslationIssue | undefined = issue.value;
  switch (value) {
  case undefined: return undefined;
  case 'empty-source': return lazyStrings.translation__enter_source_text();
  case 'unsupported-source': case 'unsupported-target': return lazyStrings.translation__choose_supported_languages();
  case 'reserved-token': return lazyStrings.translation__reserved_tokens_not_allowed();
  case 'incomplete-glossary': return lazyStrings.translation__complete_glossary_entries();
  case 'unsupported-model': return lazyStrings.translation__unsupported_model();
  case 'unexpected-output': return lazyStrings.translation__unexpected_model_output();
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
});
const outputState = computed(() => {
  switch (phase.value) {
  case 'complete': case 'truncated': case 'stopped': return 'settled';
  case 'error': return 'failed';
  case 'generating': return 'streaming';
  case 'idle': case 'checking': case 'preparing': case 'prefill': case 'stopping': return 'pending';
  default: {
    const exhaustive: never = phase.value;
    throw new Error(String(exhaustive));
  }
  }
});
const loadingModel = computed(() => preparation.status.value === 'preparing' || (phase.value === 'preparing' && progress.value?.phase === 'loading'));
const modelProgress = computed(() => {
  const status = preparation.status.value;
  switch (status) {
  case 'preparing': return preparation.progress.value;
  case 'idle': case 'waiting': case 'ready': case 'error': return progress.value;
  default: {
    const exhaustive: never = status;
    throw new Error(String(exhaustive));
  }
  }
});

async function inspectSelected({ preserve = false }: { preserve?: boolean } = {}): Promise<void> {
  inspection?.abort();
  if (!preserve) {
    selectedDetection.value = undefined;
    modelFailure.value = undefined;
  }
  inspecting.value = false;
  const selected = modelId.value;
  if (disposed || !selected || !store.initialized.value) {
    return;
  }
  const controller = new AbortController();
  inspection = controller;
  inspecting.value = true;
  try {
    const found = await inspectStoredTranslationModel({ modelId: selected, signal: controller.signal });
    if (disposed || controller.signal.aborted || inspection !== controller) {
      return;
    }
    selectedDetection.value = found;
    switch (found.status) {
    case 'supported': modelFailure.value = undefined;
      break;
    case 'unsupported': modelFailure.value = 'unsupported';
      break;
    default: {
      const exhaustive: never = found;
      throw new Error(String(exhaustive));
    }
    }
  } catch {
    if (!disposed && !controller.signal.aborted && inspection === controller) {
      selectedDetection.value = undefined;
      modelFailure.value = 'unreadable';
    }
  } finally {
    if (inspection === controller) {
      inspecting.value = false;
    }
  }
}

async function selectModel({ modelId: selected, downloadSignal }: { modelId: string | undefined, downloadSignal?: AbortSignal }): Promise<boolean> {
  downloadSignal?.throwIfAborted();
  if (selected === undefined || saving.value || checkingSelection.value || !store.initialized.value || busy.value || disposed || (downloadSignal === undefined && changingLanguages.value)) {
    return false;
  }
  const controller = new AbortController();
  selection?.abort();
  selection = controller;
  checkingSelection.value = true;
  selectionFailure.value = undefined;
  const isCurrent = store.captureExperimentalStorage();
  try {
    const found = await inspectStoredTranslationModel({ modelId: selected, signal: controller.signal });
    if (disposed || controller.signal.aborted || !isCurrent()) {
      return false;
    }
    switch (found.status) {
    case 'supported': break;
    case 'unsupported': selectionFailure.value = 'unsupported';
      return false;
    default: {
      const exhaustive: never = found;
      throw new Error(String(exhaustive));
    }
    }
    if (await save({ patch: { modelId: selected }, signal: controller.signal }) && !disposed && !controller.signal.aborted && isCurrent()) {
      chosenRepositoryModel.value = undefined;
      downloadFailed.value = false;
      runWhenReady.value = undefined;
      invalidate();
      return true;
    }
  } catch {
    if (!disposed && !controller.signal.aborted && isCurrent()) {
      selectionFailure.value = 'unreadable';
    }
  } finally {
    if (selection === controller) {
      checkingSelection.value = false;
    }
  }
  return false;
}

function selectPendingModel({ selection: pending }: { selection: RepositoryModelSelection }): void {
  chosenRepositoryModel.value = pending;
  downloadFailed.value = false;
  runWhenReady.value = undefined;
}

function modelPickerChanged({ open }: { open: boolean }): void {
  modelPickerOpen.value = open;
  if (!open && acquiring.value === undefined) {
    selection?.abort();
    selectionFailure.value = undefined;
  }
}

async function chooseLanguage({ side, value }: { side: 'source' | 'target', value: string }): Promise<void> {
  if (blocked.value) {
    return;
  }
  switch (side) {
  case 'source': await languages.choose({ source: value || undefined, target: targetLang.value });
    break;
  case 'target': await languages.choose({ source: sourceLang.value, target: value });
    break;
  default: {
    const exhaustive: never = side;
    throw new Error(String(exhaustive));
  }
  }
}

async function changeAutomatic({ enabled }: { enabled: boolean }): Promise<void> {
  await save({ patch: { autoTranslate: { ...preferences.value?.autoTranslate, enabled } } });
}

async function changeDelay({ value }: { value: number }): Promise<void> {
  if (!blocked.value) {
    await save({ patch: { autoTranslate: { ...preferences.value?.autoTranslate, debounceMs: value } } });
  }
}

function endComposition({ input }: { input: HTMLTextAreaElement }): void {
  if (composingInput.value === input) {
    text.value = input.value;
    composingInput.value = undefined;
  }
}

watch(floatingDocument, (current, previous, onCleanup) => {
  if (current === undefined && composingInput.value?.ownerDocument === previous) {
    composingInput.value = undefined;
  }
  if (current !== undefined) {
    const pointerdown: NonNullable<Document['onpointerdown']> = event => {
      if (event.button === 0) {
        modelSelector.value?.closeFromOutside();
      }
    };
    current.addEventListener('pointerdown', pointerdown, true);
    onCleanup(() => current.removeEventListener('pointerdown', pointerdown, true));
  }
});

function shortcut({ event }: { event: KeyboardEvent }): void {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && !composing.value) {
    event.preventDefault();
    void submit();
  }
}

async function swapLanguages(): Promise<void> {
  const source = sourceLang.value;
  if (!canSwap.value || source === undefined) {
    return;
  }
  const acceptedText = text.value;
  const translated = (() => {
    switch (phase.value) {
    case 'complete': return output.value;
    case 'idle': case 'checking': case 'preparing': case 'prefill': case 'generating':
    case 'stopping': case 'stopped': case 'truncated': case 'error': return undefined;
    default: {
      const exhaustive: never = phase.value;
      throw new Error(String(exhaustive));
    }
    }
  })();
  if (await languages.choose({ source: targetLang.value, target: source })) {
    // Route guards can be asynchronous. Do not overwrite text entered while
    // the language change was pending with the previous translation.
    if (translated && text.value === acceptedText) {
      text.value = translated;
    }
    invalidate();
  }
}

async function run(): Promise<void> {
  if (!canTranslate.value || busy.value || !modelId.value) {
    return;
  }
  copied.value = 'idle';
  await translate({ draft: { modelId: modelId.value, text: text.value, sourceLang: sourceLang.value, targetLang: targetLang.value, form: form.value, context: context.value, glossary: glossary.value } });
}

function clearText(): void {
  if (blocked.value) {
    return;
  }
  text.value = '';
  composingInput.value = undefined;
  runWhenReady.value = undefined;
  if (acquiring.value !== undefined) {
    acquiring.value.translateAfterDownload = false;
  }
  reset();
}

function toggleDetails({ event }: { event: Event }): void {
  if (event.target instanceof HTMLDetailsElement) {
    detailsOpen.value = event.target.open;
  }
}

let copyRevision = 0;

async function copyOutput({ view, focus }: { view: Window | null, focus: () => void }): Promise<void> {
  const value = output.value;
  if (!value || busy.value) {
    return;
  }
  const request = ++copyRevision;
  const current = () => !disposed && request === copyRevision && output.value === value && (view === window || floatingDocument.value?.defaultView === view);
  try {
    const clipboard = view?.navigator.clipboard;
    if (clipboard === undefined) {
      throw new Error('Clipboard unavailable');
    }
    await clipboard.writeText(value);
    if (current()) {
      copied.value = 'copied';
    }
  } catch {
    if (current()) {
      copied.value = 'failed';
      focus();
    }
  }
}

async function openFloatingWindow(): Promise<void> {
  floatingOpenFailed.value = false;
  try {
    await floatingWindow.show();
  } catch {
    floatingOpenFailed.value = !disposed;
  }
}

watch([modelId, store.initialized], () => {
  if (store.initialized.value) {
    invalidate();
  } else {
    reset();
  }
  void inspectSelected();
}, { immediate: true });
watch([store.settings, store.initialized], () => {
  if (!store.initialized.value) {
    return;
  }
  if (storageCurrent === undefined) {
    storageCurrent = store.captureExperimentalStorage();
  } else if (!storageCurrent()) {
    storageCurrent = store.captureExperimentalStorage();
    selectedDetection.value = undefined;
    storageEpoch.value++;
    selection?.abort();
    acquiring.value?.controller.abort();
    chosenRepositoryModel.value = undefined;
    inventory.value = undefined;
    runWhenReady.value = undefined;
    downloadFailed.value = false;
    reset();
    text.value = '';
    context.value = '';
    glossary.value = [];
    form.value = 'default';
    selectionFailure.value = undefined;
    saveFailed.value = false;
    void inspectSelected();
  }
});
const requestKey = computed(() => JSON.stringify({ preparation: preparation.identity.value, modelId: modelId.value, text: text.value, sourceLang: sourceLang.value, targetLang: targetLang.value, invalidLanguages: invalidLanguages.value, form: form.value, context: context.value, glossary: glossary.value }));
const automatic = useAutomaticTranslation({
  key: requestKey,
  enabled: autoTranslate,
  ready: canTranslate,
  busy,
  composing,
  debounceMs,
  run,
  invalidate: () => {
    if (text.value.trim()) {
      invalidate();
    } else {
      reset();
    }
  },
  stop,
});

async function submit(): Promise<void> {
  const pending = pendingModel.value;
  if (pending === undefined) {
    await automatic.runManually();
    return;
  }
  if (!canDownload.value || composing.value) {
    return;
  }
  const operation = new AbortController();
  const request = { controller: operation, selection: pending, translateAfterDownload: true };
  acquiring.value = request;
  downloadFailed.value = false;
  try {
    const model = await acquireRepositoryModel({
      selection: pending,
      usage: 'translation',
      models: inventory.value ?? [],
      capturedRoot: downloadDestination.captureRoot({ destination: pending.destination }),
      signal: operation.signal,
      onDownload: ({ id: jobId }) => {
        activeDownloadId.value = jobId;
      },
    });
    await awaitInspection({ task: waitForSave(), signal: operation.signal });
    const selected = await selectModel({ modelId: model.modelId, downloadSignal: operation.signal });
    if (!operation.signal.aborted) {
      downloadFailed.value = !selected;
      if (selected && request.translateAfterDownload) {
        runWhenReady.value = model.modelId;
      }
    }
  } catch {
    if (!operation.signal.aborted) {
      downloadFailed.value = true;
    }
  } finally {
    acquiring.value = undefined;
    activeDownloadId.value = undefined;
  }
}

watch([runWhenReady, modelId, canTranslate, composing], ([requested, current, ready, isComposing]) => {
  if (requested !== undefined && requested === current && ready && !isComposing) {
    runWhenReady.value = undefined;
    void automatic.runManually();
  }
});

function stopTranslation(): void {
  if (acquiring.value) {
    // Keep this choice pending if the shared download completes after Stop.
    // Its completion alone must not restart automatic translation.
    chosenRepositoryModel.value = acquiring.value.selection;
    acquiring.value.controller.abort();
    selection?.abort();
  }
  runWhenReady.value = undefined;
  automatic.stopManually();
}

const showRun = computed(() => pendingModel.value !== undefined || !autoTranslate.value || automatic.manuallyStopped.value || ['error', 'stopped', 'truncated'].includes(phase.value));
const canStop = computed(() => busy.value || acquiring.value !== undefined || (loadingModel.value && (autoTranslate.value || runWhenReady.value !== undefined) && !!text.value.trim() && !automatic.manuallyStopped.value));
const displayedStatus = computed(() => automatic.manuallyStopped.value && !busy.value ? lazyStrings.translation__translation_stopped() : statusLabel.value);
const downloadError = computed(() => {
  switch (selectionFailure.value) {
  case 'unsupported': return lazyStrings.translation__unsupported_model();
  case 'unreadable': return lazyStrings.translation__model_unreadable();
  case undefined: return lazyStrings.LlamaCppBrowserHuggingFaceManager__download_failed_retry_or_resume();
  default: throw new Error(String(selectionFailure.value satisfies never));
  }
});
const editorProps = computed<InstanceType<typeof TranslationEditors>['$props']>(() => ({
  text: text.value,
  sourceLang: sourceLang.value,
  targetLang: targetLang.value,
  options: options.value,
  languageSearch: languageSearch.value,
  profileAvailable: profile.value !== undefined,
  canSwap: canSwap.value,
  blocked: blocked.value,
  autoTranslate: autoTranslate.value,
  debounceMs: debounceMs.value,
  showRun: showRun.value,
  canRun: (canTranslate.value || canDownload.value) && !composing.value,
  busy: busy.value,
  loadingModel: loadingModel.value,
  acquiring: acquiring.value !== undefined,
  downloadProgress: downloadProgress.value,
  modelProgress: modelProgress.value,
  progress: progress.value,
  prefill: phase.value === 'prefill',
  canStop: canStop.value,
  stopping: phase.value === 'stopping',
  output: output.value,
  previousOutput: previousOutput.value,
  revision: displayRevision.value,
  outputState: outputState.value,
  copied: copied.value,
  displayedStatus: displayedStatus.value,
  issueLabel: issueLabel.value,
  failure: failure.value,
  preparationFailure: preparation.failure.value,
}));
const editorEvents = {
  text: ({ value }: { value: string }) => {
    text.value = value;
  },
  compositionStart: ({ input }: { input: HTMLTextAreaElement }) => {
    composingInput.value = input;
  },
  compositionEnd: endComposition,
  chooseLanguage,
  swapLanguages,
  clear: clearText,
  copy: copyOutput,
  changeAutomatic,
  changeDelay,
  retry: preparation.retry,
  stop: stopTranslation,
};
watch(output, () => {
  copyRevision++;
  copied.value = 'idle';
});
const unregister = registerTranslationNavigation({
  navigation: {
    openWorkspace: () => modelSelector.value?.closePicker(),
  },
});
let unsubscribe: (() => void) | undefined;
onMounted(() => {
  unsubscribe = llamaCppBrowserService.subscribe({
    listener: ({ state: next }) => {
      state.value = next;
    },
  });
});
onScopeDispose(() => {
  disposed = true;
  inspection?.abort();
  selection?.abort();
  acquiring.value?.controller.abort();
  unregister();
  unsubscribe?.();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div data-testid="translation-page" tw-class="absolute inset-0 overflow-y-auto overscroll-y-contain bg-[#fcfcfd] dark:bg-gray-900">
    <main tw-class="mx-auto w-full max-w-6xl space-y-5 px-4 py-5 text-gray-900 sm:px-8 sm:py-6 dark:text-gray-100">
      <header tw-class="flex items-center gap-3">
        <LanguagesIcon aria-hidden="true" tw-class="h-5 w-5 text-blue-500 dark:text-blue-400" />
        <h1 tw-class="flex-1 text-xl font-semibold tracking-tight">{{ lazyStrings.translation__translation() }}</h1>
        <button type="button" :disabled="!store.initialized.value || !floatingWindow.supported || floatingWindow.opening.value" :title="floatingButtonLabel" :aria-label="floatingButtonLabel" data-testid="translation-open-floating" @click="openFloatingWindow" tw-class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800"><PictureInPicture2Icon aria-hidden="true" tw-class="h-4 w-4" /></button>
      </header>
      <p v-if="floatingOpenFailed" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.AudioTranscriptionWorkspace__could_not_open_floating_window() }}</p>
      <TranslationModelSelector
        ref="modelSelector"
        :model-id="modelId"
        :disabled="!store.initialized.value || busy || acquiring !== undefined"
        :selection-blocked="blocked"
        :pending-model="pendingModel"
        :pending-destination="pendingModel ? downloadDestination.label({ destination: pendingModel.destination }) : undefined"
        :inventory-epoch="storageEpoch"
        :track-inventory="store.initialized.value && (!preferences?.modelId || pendingModel !== undefined)"
        :acquiring="acquiring !== undefined"
        :confirm-selection="selectModel"
        @open-change="modelPickerChanged({ open: $event })"
        @inventory="inventory = $event"
        @pending-selection="selectPendingModel({ selection: $event })"
        @inventory-changed="!busy && inspectSelected({ preserve: true })"
      >
        <template v-if="saveFailed || checkingSelection || selectionFailure" #status>
          <p v-if="saveFailed" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.translation__preferences_not_saved() }}</p>
          <p v-if="checkingSelection" role="status" tw-class="text-xs text-gray-500">{{ lazyStrings.translation__checking_model() }}</p>
          <p v-if="selectionFailure" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ selectionFailure === 'unsupported' ? lazyStrings.translation__unsupported_model() : lazyStrings.translation__model_unreadable() }}</p>
        </template>
      </TranslationModelSelector>
      <SettingsSelectScope :active="!modelPickerOpen" :return-focus="mainEditors?.sourceInput">
        <form novalidate tw-class="space-y-4" @submit.prevent="submit" @keydown="shortcut({ event: $event })">
          <div v-if="saveFailed || languageFailure || modelFailure || invalidLanguages || downloadFailed" role="alert" tw-class="space-y-1 text-sm text-red-600 dark:text-red-400">
            <p v-if="saveFailed || languageFailure">{{ lazyStrings.translation__preferences_not_saved() }}</p>
            <p v-if="downloadFailed">{{ downloadError }}</p>
            <p v-if="invalidLanguages">{{ lazyStrings.translation__choose_supported_languages() }}</p>
            <p v-if="modelFailure">{{ modelFailure === 'unsupported' ? lazyStrings.translation__unsupported_model() : lazyStrings.translation__model_unreadable() }} <button type="button" :disabled="blocked || inspecting" @click="inspectSelected()" tw-class="underline disabled:opacity-45">{{ lazyStrings.translation__check_again() }}</button></p>
          </div>

          <TranslationEditors
            ref="mainEditors"
            v-bind="editorProps"
            v-on="editorEvents"
          />
          <p v-if="state.status === 'unavailable'" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.translation__runtime_unavailable() }}</p>
          <p v-else-if="!busy && !loadingModel && state.status === 'working'" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.translation__runtime_busy() }}</p>
          <details :open="detailsOpen" @toggle="toggleDetails({ event: $event })" data-testid="translation-details" tw-class="group/translation-settings overflow-hidden rounded-xl border border-gray-200/70 dark:border-gray-800">
            <summary ref="detailsTrigger" tw-class="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40 dark:text-gray-200 dark:hover:bg-gray-800/40 [&::-webkit-details-marker]:hidden"><SlidersHorizontalIcon aria-hidden="true" tw-class="h-4 w-4 text-blue-500 dark:text-blue-400" /><span tw-class="flex-1">{{ lazyStrings.translation__translation_options() }}</span><ChevronRightIcon aria-hidden="true" tw-class="h-4 w-4 transition-transform group-open/translation-settings:rotate-90 motion-reduce:transition-none" /></summary>
            <SettingsSelectScope :active="detailsOpen" :return-focus="detailsTrigger">
              <fieldset :disabled="blocked" tw-class="min-w-0 space-y-5 border-t border-gray-100 p-4 disabled:opacity-60 dark:border-gray-800">
                <div tw-class="max-w-sm space-y-2"><span tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.translation__japanese_style() }}</span><SettingsFormSelect v-model="form" :options="formOptions" :label="lazyStrings.translation__japanese_style()" :disabled="blocked || profile?.formTargetLanguages.includes(targetLang) !== true" data-testid="translation-style" /></div>
                <div tw-class="space-y-2"><label :for="`${id}-context`" tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.translation__reference_context() }}</label><textarea :id="`${id}-context`" v-model="context" dir="auto" :disabled="profile?.context !== 'available'" rows="3" data-testid="translation-context" tw-class="block w-full rounded-xl border border-gray-200/80 bg-gray-50/60 p-3 text-sm leading-relaxed outline-none focus:border-blue-400 disabled:opacity-45 dark:border-gray-700/70 dark:bg-gray-800/40" /></div>
                <div tw-class="space-y-3">
                  <h2 tw-class="text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.translation__glossary() }}</h2>
                  <div v-for="(term, index) in glossary" :key="index" tw-class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2">
                    <div tw-class="min-w-0 space-y-1"><label :for="`${id}-term-source-${index}`" tw-class="block text-xs text-gray-500">{{ lazyStrings.translation__source_term() }}</label><input :id="`${id}-term-source-${index}`" v-model="term.source" dir="auto" :disabled="profile?.glossary !== 'available'" data-testid="translation-term-source" tw-class="w-full rounded-lg border border-gray-200/80 bg-gray-50/60 p-2 text-sm outline-none focus:border-blue-400 disabled:opacity-45 dark:border-gray-700/70 dark:bg-gray-800/40" /></div>
                    <div tw-class="min-w-0 space-y-1"><label :for="`${id}-term-target-${index}`" tw-class="block text-xs text-gray-500">{{ lazyStrings.translation__translated_term() }}</label><input :id="`${id}-term-target-${index}`" v-model="term.target" dir="auto" :disabled="profile?.glossary !== 'available'" data-testid="translation-term-target" tw-class="w-full rounded-lg border border-gray-200/80 bg-gray-50/60 p-2 text-sm outline-none focus:border-blue-400 disabled:opacity-45 dark:border-gray-700/70 dark:bg-gray-800/40" /></div>
                    <button type="button" @click="glossary.splice(index, 1)" :aria-label="lazyStrings.translation__remove_term()" tw-class="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"><Trash2Icon aria-hidden="true" tw-class="h-4 w-4" /></button>
                  </div>
                  <LlamaCppBrowserModelActionButton :disabled="blocked || profile?.glossary !== 'available'" data-testid="translation-add-term" @click="glossary.push({ source: '', target: '' })"><PlusIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.translation__add_term() }}</LlamaCppBrowserModelActionButton>
                </div>
              </fieldset>
            </SettingsSelectScope>
          </details>
          <p tw-class="text-xs leading-relaxed text-gray-400 dark:text-gray-500">{{ lazyStrings.translation__privacy_notice() }}</p>
        </form>
      </SettingsSelectScope>
    </main>
    <Teleport v-if="floatingDocument" :to="floatingDocument.body">
      <main data-testid="translation-floating" tw-class="h-dvh overflow-y-auto bg-gray-50 px-4 py-3 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
        <header tw-class="mb-3 flex min-w-0 shrink-0 items-center justify-between gap-3">
          <div tw-class="flex shrink-0 items-center gap-2">
            <span tw-class="flex items-center gap-1.5 text-sm font-semibold"><img :src="logoUrl" alt="" width="18" height="18" />Naidan</span>
            <h1 tw-class="border-l border-gray-200 pl-2 text-xs font-medium text-gray-600 dark:border-gray-700 dark:text-gray-300">{{ lazyStrings.translation__translation() }}</h1>
          </div>
          <span v-if="floatingModelName" :title="floatingModel" tw-class="truncate text-xs text-gray-500 dark:text-gray-400">{{ floatingModelName }}</span>
        </header>
        <form tw-class="space-y-2.5" @submit.prevent="submit" @keydown="shortcut({ event: $event })">
          <p v-if="saveFailed || languageFailure" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.translation__preferences_not_saved() }}</p>
          <p v-if="downloadFailed" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ downloadError }}</p>
          <p v-if="modelFailure" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ modelFailure === 'unsupported' ? lazyStrings.translation__unsupported_model() : lazyStrings.translation__model_unreadable() }} <button type="button" :disabled="blocked || inspecting" @click="inspectSelected()" tw-class="underline disabled:opacity-45">{{ lazyStrings.translation__check_again() }}</button></p>
          <p v-if="invalidLanguages" role="status" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.translation__choose_supported_languages() }}</p>
          <p v-if="state.status === 'unavailable'" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.translation__runtime_unavailable() }}</p>
          <TranslationEditors :popup-target="floatingDocument.body" v-bind="editorProps" v-on="editorEvents" />
        </form>
      </main>
    </Teleport>
  </div>
</template>
