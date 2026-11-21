<script setup lang="ts">
import SettingsSelectScope from '@/components/SettingsSelectScope.vue';
import SettingsChoiceControl from '@/components/SettingsChoiceControl.vue';
import { computed, defineAsyncComponent, inject, nextTick, onMounted, onUnmounted, ref, shallowRef, useId, watch } from 'vue';
import { routeLocationKey } from 'vue-router';
import { AudioLinesIcon, ChevronRightIcon, FolderOpenIcon, Loader2Icon, PaperclipIcon, RefreshCcwIcon, SlidersHorizontalIcon } from 'lucide-vue-next';
import { currentLocale, lazyStrings } from '@/strings';
import { audioLanguageOptions, defaultAudioLanguage } from './languages';
import { audioFieldLabel, audioFieldValidationMessage, audioValidationFields } from './validation';
import LlamaCppBrowserRuntimeSettings from '@/features/llama-cpp-browser/components/LlamaCppBrowserRuntimeSettings.vue';
import { listModelInventory } from '@/features/llama-cpp-browser/composables/model-inventory';
import { llamaCppBrowserModelFiles } from '@/features/llama-cpp-browser/model-files';
import { findModelDownloadJob, getDownloadQueue, jobIsBusy } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { requestAppSettings } from '@/composables/useAppEntry';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import { errorCode, type EngineState, type ErrorCode, type LocalModel } from '@/features/llama-cpp-browser/types';
import { audioGenerationInputSchema, audioGenerationResultSchema, audioGenerationPreviewSchema, defaultAudioParameters } from './types';
import { createAudioPreviewRequests } from './preview-requests';
import { validateAudioWav } from './wav';
import { inspectStoredAudioModel } from './model-detection';
import { useAudioModels } from './composables/useAudioModels';
import { captureAudioSettings, useAudioHistory } from './composables/useAudioHistory';
import AudioHistoryResult from './components/AudioHistoryResult.vue';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import ModelSelector from '@/components/ModelSelector.vue';
import type { ModelSelectorItem } from '@/components/model-selector-item';
import { audioModelCatalog, defaultAudioModel } from './model-catalog';
import { acquireRepositoryModel, repositorySearchDownloadKey, matchesRepositoryDownload } from '@/features/llama-cpp-browser/model-launch/acquire-repository-model';
import { preferredProjector } from '@/features/llama-cpp-browser/hugging-face/presentation';
import { repositoryModelDownloadIdentity, type RepositoryModelSelection } from '@/features/llama-cpp-browser/model-launch/bundled-repository-target';
import { useModelDownloadDestination } from '@/features/llama-cpp-browser/composables/useModelDownloadDestination';
import LlamaCppBrowserDownloadProgress from '@/features/llama-cpp-browser/components/LlamaCppBrowserDownloadProgress.vue';
import AudioReferenceInput from './components/AudioReferenceInput.vue';
import { revealAudioGenerationSection } from './navigation';

const ModelSelectorFileImport = defineAsyncComponent(() => import('@/components/ModelSelectorFileImport.vue'));
const RepositoryModelPicker = defineAsyncComponent(() => import('@/features/llama-cpp-browser/components/LlamaCppBrowserRepositoryPicker.vue'));

const id = useId();
const route = inject(routeLocationKey, undefined);
const page = ref<HTMLElement>();
const addedModels = shallowRef<readonly LocalModel[]>([]);
const downloadQueue = getDownloadQueue();
const modelPanels = computed(() => [
  { id: 'audio-candidates', label: lazyStrings.audioGeneration__models_for_audio_generation(), placement: 'before-models' },
  { id: 'huggingface', label: 'Hugging Face' },
  { id: 'files', label: lazyStrings.ModelSelector__add_files() },
] as const);
const inventoryRefreshing = ref(false);
const inventoryKnown = ref(false);
const inventoryFailed = ref(false);
let inventoryRequest: Promise<void> | undefined;
let inventoryController: AbortController | undefined;
let inventoryRefreshRequested = false;
let unsubscribeModels: (() => void) | undefined;
const recovery = shallowRef<AbortController>();
const { models, modelId, scope: modelScope, scanState, visibleModels, detectedCount, detections,
  updateModels, selectModel, scopeChanged } = useAudioModels({ inspect: inspectStoredAudioModel });
const { entries: history, totalBytes, append: appendHistory, remove: removeHistory, clear: clearHistory } = useAudioHistory();
const text = ref('');
const referenceInput = ref<InstanceType<typeof AudioReferenceInput>>();
const referenceBusy = ref(false);
const utilityPanel = ref<'reference' | 'settings'>();
const referenceErrorCodes = new Set<ErrorCode>(['audio-reference-required', 'audio-reference-invalid']);
const referencePanel = ref<HTMLElement>();
const settingsPanel = ref<HTMLElement>();
const settingsTrigger = ref<HTMLElement>();
const referenceOpen = computed(() => utilityPanel.value === 'reference' || referenceBusy.value);
const settingsOpen = computed(() => utilityPanel.value === 'settings');
const referenceCount = computed(() => referenceInput.value?.selectedCount ?? 0);

const preparingReference = ref(false);
const acquiringModel = ref(false);
const activeDownloadId = ref<number>();
const downloadFailed = ref(false);
const chosenRepositoryModel = shallowRef<RepositoryModelSelection>();
const parameters = ref<ReturnType<typeof defaultAudioParameters>>({ ...defaultAudioParameters(), language: defaultAudioLanguage({ locale: currentLocale.value }) });
const form = ref<HTMLFormElement>();
const debug = ref(false);
const advancedSettingsOpen = ref(false);
const advancedSettingsTrigger = ref<HTMLElement>();

function togglePanel({ panel }: { panel: 'reference' | 'settings' }): void {
  utilityPanel.value = utilityPanel.value === panel ? undefined : panel;
}

function toggleAdvancedSettings({ event }: { event: Event }): void {
  if (event.target instanceof HTMLDetailsElement) {
    advancedSettingsOpen.value = event.target.open;
  }
}

const runtimeReady = ref(false);
const state = shallowRef<EngineState>(llamaCppBrowserService.getState());
const controller = shallowRef<AbortController>();
const completionController = shallowRef<AbortController>();
const previews = shallowRef<ReturnType<typeof createAudioPreviewRequests>>();
const previewPending = ref(false);
const finishing = ref(false);
const stopping = ref(false);
const canFinish = computed(() => busy.value && !acquiringModel.value && !preparingReference.value && !stopping.value && !finishing.value && state.value.status === 'working' && state.value.progress.phase === 'generating' && state.value.progress.completed > 0);
const stopped = ref(false);
const invalidFields = ref<string[]>([]);
const invalid = computed(() => invalidFields.value.length > 0);
const failure = ref<ErrorCode>();
const busy = computed(() => controller.value !== undefined);
const blocked = computed(() => recovery.value !== undefined || busy.value || state.value.status === 'working');
const runtimeControlsDisabled = computed(() => blocked.value || downloadQueue.jobs.value.some(job => jobIsBusy({ job })));
const downloadDestination = useModelDownloadDestination({ blocked: () => blocked.value, changed: () => {} });
const pendingModel = computed<RepositoryModelSelection | undefined>(() => {
  const { destination, authorize } = downloadDestination;
  const chosen = chosenRepositoryModel.value;
  if (chosen !== undefined) {
    return { ...chosen, destination: destination.value, authorizeDestination: authorize };
  }
  if (modelId.value) {
    return undefined;
  }
  const hint = defaultAudioModel.quantizationHints[0];
  const companion = preferredProjector({ files: hint.companionFiles ?? [] });
  if (companion === undefined) {
    return undefined;
  }
  const { hfRepository: repository, preferredQuantization: variant } = hint;
  return {
    modelId: `hf.co/${repository}:${variant}`,
    source: { kind: 'bundled', repository, variant, companionPath: companion.path },
    destination: destination.value,
    authorizeDestination: authorize,
  };
});
const selectedModelId = computed(() => pendingModel.value?.modelId ?? (modelId.value || undefined));
const downloadProgress = computed(() => downloadQueue.jobs.value.find(job => job.id === activeDownloadId.value)?.progress);
const selectionDownloadIsActive = computed(() => {
  const pending = pendingModel.value;
  if (pending === undefined) {
    return false;
  }
  const { key, selection } = repositoryModelDownloadIdentity({ source: pending.source });
  const jobs = downloadQueue.jobs.value;
  const queued = findModelDownloadJob({ jobs, key, selection, destination: pending.destination });
  const defaultKey = repositorySearchDownloadKey({ selection: pending, usage: 'audio-generation' });
  const defaultJob = defaultKey === undefined ? undefined
    : findModelDownloadJob({ jobs, key: defaultKey, selection: undefined, destination: pending.destination });
  return acquiringModel.value || jobIsBusy({ job: queued })
    || jobIsBusy({ job: defaultJob }) && matchesRepositoryDownload({ selection: pending, files: defaultJob?.selection });
});
const canGenerate = computed(() => {
  if (blocked.value || referenceBusy.value || !runtimeReady.value) {
    return false;
  }
  if (pendingModel.value !== undefined) {
    // Give local detection the first choice. A failed inventory must not turn
    // a possibly installed model into an unexpected Hugging Face request.
    return inventoryKnown.value && !inventoryFailed.value && !inventoryRefreshing.value
      && scanState.value === 'idle' && !downloadDestination.unavailable.value && !downloadDestination.view.busy.value;
  }
  return models.value.some(entry => entry.modelId === modelId.value);
});
let disposed = false;
let generation = 0;
let modelChoiceRevision = 0;
let unsubscribe: (() => void) | undefined;

function revealSection(): void {
  if (page.value === undefined || route === undefined) {
    return;
  }
  const { hash } = route;
  if (hash === '#audio-generation-models') {
    utilityPanel.value = 'settings';
    void nextTick(() => {
      if (page.value !== undefined && route.hash === hash) {
        revealAudioGenerationSection({ hash, root: page.value });
      }
    });
    return;
  }
  revealAudioGenerationSection({ hash, root: page.value });
}

watch(() => route?.hash, revealSection, { flush: 'post' });

const modelOptions = computed<ModelSelectorItem[]>(() => visibleModels.value.map(({ modelId }) => ({
  id: modelId,
  label: modelId,
  description: undefined,
  availability: 'local',
})));
const selectedDetection = computed(() => detections.value.get(modelId.value));
const referenceRequired = computed(() => {
  const selected = pendingModel.value === undefined ? selectedDetection.value : undefined;
  switch (selected?.status) {
  case 'detected': {
    const { reference } = selected;
    switch (reference) {
    case 'required': return true;
    case 'optional': return false;
    default: throw new Error(String(reference satisfies never));
    }
  }
  case 'unverified': case undefined: return false;
  default: throw new Error(String(selected satisfies never));
  }
});


function refreshInventory(): Promise<void> {
  if (disposed) {
    return Promise.resolve();
  }
  inventoryRefreshRequested = true;
  if (inventoryRequest !== undefined) {
    return inventoryRequest;
  }
  const controller = new AbortController();
  inventoryController = controller;
  inventoryRefreshing.value = true;
  inventoryRequest = Promise.resolve().then(async () => {
    while (inventoryRefreshRequested && !controller.signal.aborted) {
      inventoryRefreshRequested = false;
      try {
        const entries = await listModelInventory({ signal: controller.signal });
        if (!controller.signal.aborted && !inventoryRefreshRequested) {
          updateModels({ entries });
          inventoryKnown.value = true;
          inventoryFailed.value = false;
        }
      } catch {
        if (!controller.signal.aborted) {
          inventoryFailed.value = true;
        }
      }
    }
  }).finally(() => {
    inventoryRequest = undefined;
    inventoryController = undefined;
    inventoryRefreshing.value = false;
  });
  return inventoryRequest;
}

watch(downloadQueue.changed, refreshInventory);

function chooseModel({ modelId: chosenId }: { modelId: string | undefined }): void {
  if (chosenId !== undefined && !blocked.value) {
    modelChoiceRevision++;
    selectModel({ modelId: chosenId });
    if (modelId.value === chosenId) {
      chosenRepositoryModel.value = undefined;
      downloadFailed.value = false;
      failure.value = undefined;
    }
  }
}

function chooseRepositoryModel({ selection, close }: { selection: RepositoryModelSelection, close: (() => void) | undefined }): void {
  if (!blocked.value) {
    modelChoiceRevision++;
    chosenRepositoryModel.value = selection;
    downloadFailed.value = false;
    failure.value = undefined;
    close?.();
  }
}

async function chooseFromSource({ model, close }: { model: LocalModel, close: (() => void) | undefined }): Promise<void> {
  if (blocked.value) {
    return;
  }
  const revision = ++modelChoiceRevision;
  if (!models.value.some(entry => entry.modelId === model.modelId)) {
    await refreshInventory();
  }
  if (disposed || blocked.value || modelChoiceRevision !== revision) {
    return;
  }
  chooseModel({ modelId: model.modelId });
  if (modelId.value === model.modelId) {
    close?.();
  }
}

function openModelManagement({ event }: { event: MouseEvent }): void {
  requestAppSettings({ tab: 'llama_cpp_browser', opener: event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined });
}

async function restartRuntime(): Promise<void> {
  if (runtimeControlsDisabled.value || disposed) {
    return;
  }
  const controller = new AbortController();
  recovery.value = controller;
  try {
    await llamaCppBrowserService.restartRuntime({ signal: controller.signal });
    if (!disposed && !controller.signal.aborted) {
      failure.value = undefined;
      stopped.value = false;
    }
  } catch (error) {
    if (!disposed && !controller.signal.aborted) {
      failure.value = errorCode({ error });
    }
  } finally {
    if (!disposed && recovery.value === controller) {
      recovery.value = undefined;
    }
  }
}

const languages = computed(() => audioLanguageOptions({ locale: currentLocale.value }));
const progressLabel = computed(() => {
  if (preparingReference.value && !stopping.value) {
    return lazyStrings.audioGeneration__preparing_references();
  }
  if (stopping.value) {
    return lazyStrings.audioGeneration__stopping();
  }
  if (acquiringModel.value) {
    return lazyStrings.audioGeneration__preparing_model();
  }
  if (finishing.value && !(state.value.status === 'working' && state.value.progress.phase === 'decoding-audio')) {
    return lazyStrings.audioGeneration__finishing_current_step();
  }
  const current = state.value;
  switch (current.status) {
  case 'idle': case 'error': case 'unavailable': return lazyStrings.audioGeneration__waiting();
  case 'working': {
    const progress = current.progress;
    switch (progress.phase) {
    case 'initializing': return lazyStrings.llamaCppBrowser__initializing();
    case 'loading': return lazyStrings.llamaCppBrowser__loading();
    case 'prefill': return lazyStrings.llamaCppBrowser__prefill();
    case 'decoding-audio': return lazyStrings.audioGeneration__decoding_audio();
    case 'generating': return lazyStrings.audioGeneration__steps_completed({ completed: progress.completed, maximum: progress.total });
    case 'importing': return lazyStrings.audioGeneration__waiting();
    default: {
      const exhaustive: never = progress.phase;
      throw new Error(String(exhaustive));
    }
    }
  }
  default: {
    const exhaustive: never = current;
    throw new Error(String(exhaustive));
  }
  }
});
const errorMessage = computed(() => {
  if (invalid.value) {
    return lazyStrings.audioGeneration__check_parameters();
  }
  if (downloadFailed.value) {
    return lazyStrings.LlamaCppBrowserHuggingFaceManager__download_failed_retry_or_resume();
  }
  const code = failure.value;
  switch (code) {
  case 'audio-model-unsupported': return lazyStrings.audioGeneration__unsupported_model();
  case 'audio-reference-required': return lazyStrings.audioGeneration__reference_required();
  case 'audio-reference-invalid': return lazyStrings.audioGeneration__invalid_reference();
  case 'audio-output-empty': return lazyStrings.audioGeneration__empty_audio();
  case 'context-full': return lazyStrings.audioGeneration__context_full();
  case undefined: return undefined;
  case 'unavailable': case 'invalid-gguf': case 'duplicate-model': case 'missing-model': case 'storage-error':
  case 'runtime-error': case 'template-unsupported': case 'reasoning-unsupported': case 'unsupported-input': case 'busy': case 'aborted': case 'worker-failed':
    return lazyStrings.audioGeneration__generation_failed();
  default: {
    const exhaustive: never = code;
    throw new Error(String(exhaustive));
  }
  }
});

function fieldError({ field }: { field: string }): string | undefined {
  return invalidFields.value.includes(field) ? audioFieldValidationMessage({ field }) : undefined;
}

async function revealInvalidField({ field }: { field: string }): Promise<void> {
  // Open collapsed ancestors before focus. Native form validation cannot focus a
  // hidden number input and otherwise reports only "not focusable" in the console.
  const element = form.value?.querySelector<HTMLElement>(`[data-audio-field="${field}"]`);
  if (!element) {
    return;
  }
  if (referencePanel.value?.contains(element)) {
    utilityPanel.value = 'reference';
  } else if (settingsPanel.value?.contains(element)) {
    utilityPanel.value = 'settings';
  }
  let parent = element.parentElement;
  while (parent && parent !== form.value) {
    if (parent instanceof HTMLDetailsElement) {
      parent.open = true;
    }
    parent = parent.parentElement;
  }
  await nextTick();
  if (disposed || !form.value?.contains(element)) {
    return;
  }
  // Composite inputs put the field marker on the wrapper around their controls.
  const focusTarget = element.matches('input,select,textarea,button') ? element : element.querySelector<HTMLElement>('button:not(:disabled)') ?? element;
  focusTarget?.focus({ preventScroll: true });
  element.scrollIntoView?.({ block: 'nearest' });
}

async function generate(): Promise<void> {
  if (!canGenerate.value) {
    return;
  }
  const pending = pendingModel.value;
  failure.value = undefined;
  downloadFailed.value = false;
  invalidFields.value = [];
  stopped.value = false;
  const accepted = audioGenerationInputSchema.safeParse({ ...parameters.value, modelId: selectedModelId.value, text: text.value, reference: undefined, debug: debug.value ? 'on' : 'off', options: llamaCppBrowserService.getOptions() });
  if (!accepted.success) {
    invalidFields.value = audioValidationFields({ issues: accepted.error.issues });
    await revealInvalidField({ field: invalidFields.value[0] ?? 'input' });
    return;
  }
  if (referenceRequired.value && referenceCount.value === 0) {
    failure.value = 'audio-reference-required';
    await revealInvalidField({ field: 'reference' });
    return;
  }
  utilityPanel.value = undefined;
  const { options: _options, ...input } = accepted.data;
  const request = ++generation;
  const active = new AbortController();
  controller.value = active;
  stopping.value = false;
  const completion = new AbortController();
  completionController.value = completion;
  finishing.value = false;
  const captures = createAudioPreviewRequests();
  previews.value = captures;
  previewPending.value = false;
  try {
    let selectedId = input.modelId;
    if (pending !== undefined) {
      acquiringModel.value = true;
      const model = await acquireRepositoryModel({
        selection: pending,
        usage: 'audio-generation',
        models: models.value,
        capturedRoot: downloadDestination.captureRoot({ destination: pending.destination }),
        signal: active.signal,
        onDownload: ({ id }) => {
          activeDownloadId.value = id;
        },
      });
      active.signal.throwIfAborted();
      selectedId = model.modelId;
      updateModels({ entries: [...models.value.filter(entry => entry.modelId !== model.modelId), model] });
      selectModel({ modelId: model.modelId });
      chosenRepositoryModel.value = undefined;
      acquiringModel.value = false;
      activeDownloadId.value = undefined;
    }
    const settings = captureAudioSettings({ input: { ...accepted.data, modelId: selectedId } });
    preparingReference.value = true;
    const reference = await referenceInput.value?.prepare({ signal: active.signal });
    active.signal.throwIfAborted();
    preparingReference.value = false;
    const result = audioGenerationResultSchema.parse(await llamaCppBrowserService.generateAudio({
      input: { ...input, modelId: selectedId, reference },
      cancellationSignal: active.signal,
      completionSignal: completion.signal,
      preview: {
        requests: captures.requests,
        onPreview: ({ event: { result: incoming, requestVersion } }) => {
          if (disposed || request !== generation || active.signal.aborted) {
            return;
          }
          const result = audioGenerationPreviewSchema.parse(incoming);
          validateAudioWav(result);
          appendHistory({ result, settings });
          if (requestVersion >= captures.requests.version) {
            previewPending.value = false;
          }
        },
      },
    }));
    // An RPC may finish after Stop or route unmount. Never publish that old result.
    if (disposed || request !== generation || active.signal.aborted) {
      return;
    }
    validateAudioWav(result);
    appendHistory({ result, settings });
  } catch (error) {
    if (disposed || request !== generation) {
      return;
    }
    const code = errorCode({ error });
    if (active.signal.aborted || code === 'aborted') {
      stopped.value = true;
    } else {
      downloadFailed.value = acquiringModel.value;
      failure.value = preparingReference.value ? 'audio-reference-invalid' : code;
    }
  } finally {
    if (!disposed && request === generation) {
      if (active.signal.aborted) {
        stopped.value = true;
      }
      preparingReference.value = false;
      acquiringModel.value = false;
      activeDownloadId.value = undefined;
      controller.value = undefined;
      completionController.value = undefined;
      previews.value = undefined;
      previewPending.value = false;
      stopping.value = false;
      finishing.value = false;
    }
  }
  if (!disposed && failure.value !== undefined && referenceErrorCodes.has(failure.value)) {
    await revealInvalidField({ field: 'reference' });
  }
}

function capturePreview(): void {
  if (!canFinish.value || previewPending.value || !previews.value) {
    return;
  }
  previewPending.value = true;
  previews.value.request();
}

function finishAudio(): void {
  if (!canFinish.value) {
    return;
  }
  finishing.value = true;
  previewPending.value = false;
  completionController.value?.abort();
}

function stop(): void {
  if (!controller.value) {
    return;
  }
  stopping.value = true;
  controller.value.abort();
}

onMounted(() => {
  revealSection();
  unsubscribeModels = llamaCppBrowserModelFiles.subscribeModelList({ listener: refreshInventory });
  void refreshInventory();
  unsubscribe = llamaCppBrowserService.subscribe({
    listener: ({ state: next }) => {
      state.value = next;
    },
  });
});
onUnmounted(() => {
  disposed = true;
  generation++;
  recovery.value?.abort();
  controller.value?.abort();
  inventoryController?.abort();
  unsubscribeModels?.();
  unsubscribe?.();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div tw-class="absolute inset-0 overflow-y-auto overscroll-y-contain bg-[#fcfcfd] dark:bg-gray-900" data-testid="audio-generation-scroll">
    <main ref="page" tw-class="mx-auto w-full max-w-3xl space-y-3 px-3 py-4 text-gray-900 sm:px-6 sm:py-5 dark:text-gray-100" data-testid="audio-generation-page">
      <header tw-class="space-y-1">
        <h1 tw-class="flex items-center gap-2.5 text-xl font-semibold tracking-tight"><AudioLinesIcon aria-hidden="true" tw-class="h-5 w-5 shrink-0 text-blue-500 dark:text-blue-400" />{{ lazyStrings.audioGeneration__audio_generation() }}</h1>
        <p tw-class="max-w-2xl text-xs leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__introduction() }}</p>
      </header>
      <form id="audio-generation-input" ref="form" tabindex="-1" novalidate @submit.prevent="generate" tw-class="space-y-3">
        <div tw-class="rounded-xl border border-gray-200 bg-white shadow-sm shadow-gray-900/5 dark:border-gray-700/70 dark:bg-gray-900" data-testid="audio-composer">
          <div tw-class="rounded-t-xl border-b border-gray-100 bg-gray-50/60 px-3.5 py-2.5 dark:border-gray-800 dark:bg-gray-800/35 sm:px-4">
            <fieldset :disabled="blocked" tw-class="flex min-w-0 flex-wrap items-start gap-2.5 disabled:opacity-60">
              <div tw-class="min-w-0 flex-[3_1_20rem] space-y-1">
                <label :for="`${id}-model`" tw-class="block text-xs font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__audio_model() }}</label>
                <ModelSelector
                  :input-id="`${id}-model`"
                  surface="settings"
                  trigger-size="compact"
                  :model-value="selectedModelId"
                  :selection-availability="pendingModel ? 'download_required' : undefined"
                  :hide-first-use-download-hint="selectionDownloadIsActive"
                  :first-use-download-destination="pendingModel ? downloadDestination.label({ destination: pendingModel.destination }) : undefined"
                  :models="modelOptions"
                  :models-label="lazyStrings.ModelSelector__models_on_this_device()"
                  :panels="modelPanels"
                  :initial-panel="pendingModel || !modelId ? 'audio-candidates' : undefined"
                  :loading="inventoryRefreshing || scanState === 'scanning'"
                  :disabled="blocked"
                  :invalid="invalidFields.includes('modelId')"
                  :placeholder="lazyStrings.audioGeneration__choose_model()"
                  data-testid="audio-model"
                  data-audio-field="modelId"
                  @update:model-value="chooseModel({ modelId: $event })"
                  @refresh="refreshInventory"
                >
                  <template #panel="{ panel, active, close, popupTarget }">
                    <ModelSelectorFileImport
                      v-if="panel === 'files'"
                      v-model:added="addedModels"
                      :available-model-ids="models.map(model => model.modelId)"
                      :selected-model-id="modelId || undefined"
                      :disabled="!active || blocked"
                      tw-class="pt-3"
                      @choose="model => chooseFromSource({ model, close })"
                      @inventory-changed="refreshInventory"
                    />
                    <RepositoryModelPicker
                      v-else
                      :layout="panel === 'audio-candidates' ? 'candidate-results' : 'inline-results'"
                      :suggestions="audioModelCatalog"
                      repository-usage="audio-generation"
                      :disabled="!active || blocked"
                      :popup-target="popupTarget"
                      selection-policy="first-use-download"
                      :selected-for-first-use="pendingModel"
                      :current-model-id="pendingModel ? undefined : selectedModelId"
                      :refresh-inventory="refreshInventory"
                      @select-model="(model, presentation) => chooseFromSource({ model, close: presentation === 'keep-open' ? undefined : close })"
                      @select-for-first-use="(selection, presentation) => chooseRepositoryModel({ selection, close: presentation === 'keep-open' ? undefined : close })"
                      @close="close()"
                    />
                  </template>
                  <template #model-filters>
                    <label tw-class="flex min-h-8 cursor-pointer items-center gap-2 px-1 text-xs text-gray-600 dark:text-gray-300">
                      <SettingsChoiceControl presentation="checkbox"><input v-model="modelScope" true-value="all" false-value="detected" type="checkbox" @change="scopeChanged" data-testid="audio-all-models" /></SettingsChoiceControl>{{ lazyStrings.audioGeneration__show_all_llama_cpp_browser_models() }}
                    </label>
                    <p v-if="scanState === 'idle' && detectedCount === 0 && models.length > 0 && modelScope === 'detected'" data-testid="audio-no-detected-models" tw-class="px-1 text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__no_audio_models_detected() }}</p>
                  </template>
                </ModelSelector>
                <p v-if="inventoryFailed" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.llamaCppBrowser__operation_failed() }}</p>
                <p v-if="!pendingModel && selectedDetection?.status === 'unverified'" data-testid="audio-model-unverified" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__not_detected_as_audio() }}</p>
              </div>
              <div tw-class="min-w-0 flex-[1_1_9rem] space-y-1">
                <label :for="`${id}-language`" tw-class="block text-xs font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__language() }}</label>
                <span tw-class="block w-full"><SettingsFormSelect :id="`${id}-language`" style="min-height: 3rem" v-model="parameters.language" :aria-describedby="`${id}-language-help`" data-testid="audio-language" data-audio-field="language" :aria-invalid="invalidFields.includes('language') || undefined" :options="[{ value: 'default', label: lazyStrings.audioGeneration__model_default() }, ...languages]" :label="lazyStrings.audioGeneration__language()" :disabled="blocked" /></span>
              </div>
            </fieldset>
          </div>
          <div tw-class="px-3.5 py-3 sm:px-4">
            <label :for="`${id}-text`" tw-class="block text-sm font-medium">{{ lazyStrings.audioGeneration__input_text() }}</label>
            <textarea :id="`${id}-text`" v-model="text" required maxlength="8192" rows="5" :placeholder="lazyStrings.audioGeneration__input_placeholder()" data-testid="audio-text" data-audio-field="text" :disabled="blocked" :aria-invalid="invalidFields.includes('text') || undefined" tw-class="mt-1.5 block min-h-32 w-full resize-y rounded-lg border border-gray-200/80 bg-gray-50/70 px-3 py-2.5 text-sm leading-6 text-gray-800 caret-blue-600 outline-none transition-colors placeholder:text-gray-500 focus:border-blue-400/70 focus:bg-white focus:ring-2 focus:ring-blue-500/15 dark:border-gray-700/60 dark:bg-gray-800/45 dark:text-gray-100 dark:caret-blue-400 dark:placeholder:text-gray-400 dark:focus:bg-gray-800/65 motion-reduce:transition-none" />
          </div>
          <div tw-class="space-y-2.5 rounded-b-xl border-t border-gray-100 bg-gray-50/60 px-3.5 py-2.5 dark:border-gray-800 dark:bg-gray-800/35 sm:px-4">
            <div tw-class="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="audio-composer-actions">
              <div tw-class="flex min-w-0 flex-wrap items-center gap-1">
                <button type="button" :aria-expanded="referenceOpen" :aria-controls="`${id}-reference-panel`" :aria-describedby="referenceRequired && referenceCount === 0 ? `${id}-reference-needed` : undefined" data-testid="audio-toggle-reference" :tw-class="['inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-200/70 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-300 dark:hover:bg-gray-700/80 motion-reduce:transition-none', referenceOpen && 'bg-gray-200/70 dark:bg-gray-700/70']" @click="togglePanel({ panel: 'reference' })">
                  <PaperclipIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />
                  {{ lazyStrings.audioGeneration__reference_voice() }}
                  <span v-if="referenceCount > 0" data-testid="audio-composer-reference-count" tw-class="rounded bg-gray-200/80 px-1 text-[10px] tabular-nums text-gray-700 dark:bg-gray-700 dark:text-gray-100">{{ referenceCount }}</span>
                </button>
                <button ref="settingsTrigger" type="button" :aria-expanded="settingsOpen" :aria-controls="`${id}-settings-panel`" data-testid="audio-toggle-settings" :tw-class="['inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-200/70 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-300 dark:hover:bg-gray-700/80 motion-reduce:transition-none', settingsOpen && 'bg-gray-200/70 dark:bg-gray-700/70']" @click="togglePanel({ panel: 'settings' })">
                  <SlidersHorizontalIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" />
                  {{ lazyStrings.audioGeneration__settings() }}
                </button>
              </div>
              <div tw-class="ml-auto">
                <button type="submit" :disabled="!canGenerate" data-testid="audio-generate" tw-class="inline-flex min-h-10 min-w-0 items-center justify-center gap-1.5 rounded-lg border px-3.5 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50 disabled:cursor-not-allowed disabled:opacity-45 border-blue-300/80 bg-blue-50/60 text-gray-800 hover:border-blue-400 hover:bg-blue-50 dark:border-blue-500/40 dark:bg-gray-800/90 dark:text-gray-100 dark:hover:border-blue-400/60 dark:hover:bg-gray-800"><AudioLinesIcon aria-hidden="true" tw-class="h-4 w-4 text-blue-500 dark:text-blue-400" />{{ lazyStrings.audioGeneration__generate_audio() }}</button>
              </div>
            </div>
            <p v-if="referenceRequired && referenceCount === 0" :id="`${id}-reference-needed`" data-testid="audio-reference-needed" tw-class="text-xs text-gray-600 dark:text-gray-300">{{ lazyStrings.audioGeneration__reference_required() }}</p>
            <p v-if="!runtimeReady" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__runtime_unavailable() }}</p>
            <div v-if="busy" tw-class="flex flex-wrap items-center gap-1.5">
              <button type="button" :disabled="!canFinish || previewPending" @click="capturePreview" data-testid="audio-preview" tw-class="inline-flex min-h-10 items-center gap-2 rounded-lg border border-gray-200 bg-white/70 px-3.5 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 disabled:cursor-not-allowed disabled:opacity-45 dark:border-gray-700/70 dark:bg-gray-800/40 dark:text-gray-200 dark:hover:bg-gray-800"><Loader2Icon v-if="previewPending" tw-class="h-4 w-4 animate-spin motion-reduce:animate-none" />{{ lazyStrings.audioGeneration__capture_preview() }}</button>
              <button type="button" :disabled="!canFinish" @click="finishAudio" data-testid="audio-finish" tw-class="min-h-10 rounded-lg border border-gray-200 bg-white/70 px-3.5 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 disabled:opacity-45 dark:border-gray-700/70 dark:bg-gray-800/40 dark:text-gray-200 dark:hover:bg-gray-800">{{ lazyStrings.audioGeneration__finish_and_keep_audio() }}</button>
              <button type="button" :disabled="stopping" @click="stop" data-testid="audio-stop" tw-class="min-h-10 rounded-lg border border-gray-200 px-3.5 py-2 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400/40 disabled:opacity-45 dark:border-gray-700/70 dark:text-gray-400 dark:hover:bg-gray-800">{{ lazyStrings.audioGeneration__cancel_and_discard() }}</button>
            </div>
            <div v-if="acquiringModel && downloadProgress && !stopping" data-testid="audio-model-download-progress" tw-class="max-w-sm">
              <LlamaCppBrowserDownloadProgress :progress="downloadProgress" appearance="welcome" activity="active" compact />
            </div>
            <p v-else-if="busy" role="status" data-testid="audio-progress" tw-class="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400"><Loader2Icon tw-class="h-4 w-4 animate-spin motion-reduce:animate-none" />{{ progressLabel }}</p>
            <p v-if="busy" data-testid="audio-preview-help" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__preview_help() }}</p>
            <p v-if="previewPending && !finishing && !stopping" role="status" data-testid="audio-preview-pending" tw-class="text-xs text-blue-600 dark:text-blue-400">{{ lazyStrings.audioGeneration__preview_pending() }}</p>
            <p v-if="busy" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__finish_audio_help() }}</p>
            <p v-if="stopped" role="status" data-testid="audio-stopped" tw-class="text-sm text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__generation_stopped() }}</p>
          </div>
        </div>
        <div v-if="invalid || failure" role="alert" data-testid="audio-error" tw-class="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/10 p-4 text-sm text-red-700 dark:text-red-400">
          <p>{{ errorMessage }}</p>
          <ul v-if="invalid" tw-class="mt-2 space-y-2">
            <li v-for="field in invalidFields" :key="field"><button type="button" tw-class="text-left underline" @click="revealInvalidField({ field })">{{ audioFieldLabel({ field }) }}: {{ audioFieldValidationMessage({ field }) }}</button></li>
          </ul>
          <code v-if="failure" tw-class="mt-2 block text-xs">{{ failure }}</code>
        </div>
        <!-- Recording Stop/Discard must remain reachable even if another page's
             shared runtime starts working. Do not put these inside a disabled fieldset. -->
        <div :hidden="!referenceOpen" :id="`${id}-reference-panel`" ref="referencePanel" data-testid="audio-reference-panel">
          <AudioReferenceInput ref="referenceInput" :disabled="blocked" :invalid="invalidFields.includes('reference') || (failure !== undefined && referenceErrorCodes.has(failure))" @busy="referenceBusy = $event" @recording-failed="utilityPanel = 'reference'" @changed="invalidFields = []; failure = undefined" />
        </div>
        <div :hidden="!settingsOpen" :id="`${id}-settings-panel`" ref="settingsPanel" tw-class="space-y-2" data-testid="audio-settings-panel">
          <SettingsSelectScope :active="settingsOpen" :return-focus="settingsTrigger">
            <fieldset :disabled="blocked" tw-class="min-w-0 space-y-5 disabled:opacity-60">
              <details :open="advancedSettingsOpen" @toggle="toggleAdvancedSettings({ event: $event })" data-testid="audio-advanced-settings" tw-class="group/audio-settings overflow-hidden rounded-xl border border-gray-200/70 bg-white/60 dark:border-gray-800/80 dark:bg-gray-900/20">
                <summary ref="advancedSettingsTrigger" tw-class="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40 dark:text-gray-200 dark:hover:bg-gray-800/40 [&::-webkit-details-marker]:hidden"><SlidersHorizontalIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500 dark:text-blue-400" /><span tw-class="flex-1">{{ lazyStrings.audioGeneration__advanced_settings() }}</span><ChevronRightIcon aria-hidden="true" tw-class="h-6 w-6 shrink-0 rounded-lg bg-gray-100/70 p-1.5 text-gray-400 transition-transform duration-200 group-open/audio-settings:rotate-90 group-open/audio-settings:bg-blue-50 group-open/audio-settings:text-blue-500 motion-reduce:transition-none dark:bg-gray-800 dark:group-open/audio-settings:bg-blue-500/10" /></summary>
                <SettingsSelectScope :active="advancedSettingsOpen" :return-focus="advancedSettingsTrigger">
                  <div tw-class="space-y-4 border-t border-gray-100 p-4 dark:border-gray-800">
                    <p :id="`${id}-language-help`" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__language_help() }}</p>
                    <div tw-class="space-y-2">
                      <label :for="`${id}-backend`" tw-class="block text-sm">{{ lazyStrings.audioGeneration__audio_processor() }}</label>
                      <SettingsFormSelect :id="`${id}-backend`" v-model="parameters.audioBackend" data-testid="audio-backend" data-audio-field="audioBackend" :aria-invalid="invalidFields.includes('audioBackend') || undefined" :options="[{ value: 'cpu', label: lazyStrings.audioGeneration__cpu_audio() }, { value: 'profile', label: lazyStrings.audioGeneration__runtime_audio() }]" :label="lazyStrings.audioGeneration__audio_processor()" :disabled="blocked" />
                      <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__processor_help() }}</p>
                    </div>
                    <div tw-class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <label tw-class="space-y-1 text-sm"><span>{{ lazyStrings.audioGeneration__context_tokens() }}</span><input v-model.number="parameters.contextTokens" type="number" min="1024" step="1" required data-testid="audio-context" data-audio-field="contextTokens" :aria-invalid="invalidFields.includes('contextTokens') || undefined" tw-class="block min-h-10 w-full rounded-lg border border-gray-200/80 bg-gray-50/45 px-3 py-2 text-xs tabular-nums text-gray-700 outline-none transition-colors hover:border-blue-200/80 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 dark:border-gray-700/70 dark:bg-gray-800/25 dark:text-gray-200 dark:hover:border-blue-500/35" /><span v-if="fieldError({ field: 'contextTokens' })" tw-class="block text-xs text-red-700 dark:text-red-400">{{ fieldError({ field: 'contextTokens' }) }}</span></label>
                      <label tw-class="space-y-1 text-sm"><span>{{ lazyStrings.audioGeneration__maximum_steps() }}</span><input v-model.number="parameters.maxFrames" type="number" min="1" max="2048" step="1" required data-testid="audio-max-frames" data-audio-field="maxFrames" :aria-invalid="invalidFields.includes('maxFrames') || undefined" tw-class="block min-h-10 w-full rounded-lg border border-gray-200/80 bg-gray-50/45 px-3 py-2 text-xs tabular-nums text-gray-700 outline-none transition-colors hover:border-blue-200/80 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 dark:border-gray-700/70 dark:bg-gray-800/25 dark:text-gray-200 dark:hover:border-blue-500/35" /><span v-if="fieldError({ field: 'maxFrames' })" tw-class="block text-xs text-red-700 dark:text-red-400">{{ fieldError({ field: 'maxFrames' }) }}</span></label>
                      <label tw-class="space-y-1 text-sm"><span>{{ lazyStrings.audioGeneration__backbone_temperature() }}</span><input v-model.number="parameters.temperature" data-testid="audio-temperature" data-audio-field="temperature" :aria-invalid="invalidFields.includes('temperature') || undefined" type="number" min="0" max="2" step="any" required tw-class="block min-h-10 w-full rounded-lg border border-gray-200/80 bg-gray-50/45 px-3 py-2 text-xs tabular-nums text-gray-700 outline-none transition-colors hover:border-blue-200/80 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 dark:border-gray-700/70 dark:bg-gray-800/25 dark:text-gray-200 dark:hover:border-blue-500/35" /><span v-if="fieldError({ field: 'temperature' })" tw-class="block text-xs text-red-700 dark:text-red-400">{{ fieldError({ field: 'temperature' }) }}</span></label>
                      <label tw-class="space-y-1 text-sm"><span>{{ lazyStrings.audioGeneration__backbone_top_k() }}</span><input v-model.number="parameters.topK" data-testid="audio-top-k" data-audio-field="topK" :aria-invalid="invalidFields.includes('topK') || undefined" type="number" min="1" max="256" step="1" required tw-class="block min-h-10 w-full rounded-lg border border-gray-200/80 bg-gray-50/45 px-3 py-2 text-xs tabular-nums text-gray-700 outline-none transition-colors hover:border-blue-200/80 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 dark:border-gray-700/70 dark:bg-gray-800/25 dark:text-gray-200 dark:hover:border-blue-500/35" /><span v-if="fieldError({ field: 'topK' })" tw-class="block text-xs text-red-700 dark:text-red-400">{{ fieldError({ field: 'topK' }) }}</span></label>
                      <label tw-class="space-y-1 text-sm"><span>{{ lazyStrings.audioGeneration__backbone_top_p() }}</span><input v-model.number="parameters.topP" data-testid="audio-top-p" data-audio-field="topP" :aria-invalid="invalidFields.includes('topP') || undefined" type="number" min="0" max="1" step="any" required tw-class="block min-h-10 w-full rounded-lg border border-gray-200/80 bg-gray-50/45 px-3 py-2 text-xs tabular-nums text-gray-700 outline-none transition-colors hover:border-blue-200/80 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 dark:border-gray-700/70 dark:bg-gray-800/25 dark:text-gray-200 dark:hover:border-blue-500/35" /><span v-if="fieldError({ field: 'topP' })" tw-class="block text-xs text-red-700 dark:text-red-400">{{ fieldError({ field: 'topP' }) }}</span></label>
                      <label tw-class="space-y-1 text-sm"><span>{{ lazyStrings.audioGeneration__seed() }}</span><input v-model.number="parameters.seed" data-testid="audio-seed" data-audio-field="seed" :aria-invalid="invalidFields.includes('seed') || undefined" type="number" min="0" max="4294967295" step="1" required tw-class="block min-h-10 w-full rounded-lg border border-gray-200/80 bg-gray-50/45 px-3 py-2 text-xs tabular-nums text-gray-700 outline-none transition-colors hover:border-blue-200/80 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 dark:border-gray-700/70 dark:bg-gray-800/25 dark:text-gray-200 dark:hover:border-blue-500/35" /><span v-if="fieldError({ field: 'seed' })" tw-class="block text-xs text-red-700 dark:text-red-400">{{ fieldError({ field: 'seed' }) }}</span></label>
                    </div>
                    <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__context_help() }}</p>
                    <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__step_limit_help() }}</p>
                    <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__sampling_help() }}</p>
                    <label tw-class="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg bg-gray-50/70 px-3 text-xs text-gray-600 dark:bg-gray-800/30 dark:text-gray-300"><SettingsChoiceControl presentation="checkbox"><input v-model="debug" type="checkbox" /></SettingsChoiceControl>{{ lazyStrings.audioGeneration__native_diagnostics() }}</label>
                  </div>
                </SettingsSelectScope>
              </details>
            </fieldset>
            <details id="audio-generation-models" tw-class="group/audio-runtime overflow-hidden rounded-xl border border-gray-200/70 bg-white/60 dark:border-gray-800/80 dark:bg-gray-900/20" data-testid="audio-runtime-settings">
              <summary tw-class="flex min-h-11 cursor-pointer list-none items-center gap-3 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-500 dark:text-gray-300 dark:hover:bg-gray-800/80 [&::-webkit-details-marker]:hidden"><SlidersHorizontalIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" /><span tw-class="flex-1">{{ lazyStrings.audioGeneration__runtime_settings() }}</span><ChevronRightIcon aria-hidden="true" tw-class="h-4 w-4 text-gray-400 transition-transform duration-200 group-open/audio-runtime:rotate-90 motion-reduce:transition-none" /></summary>
              <div tw-class="space-y-3 border-t border-gray-100 px-4 py-3 dark:border-gray-800">
                <LlamaCppBrowserRuntimeSettings hide-chat-settings :disabled="runtimeControlsDisabled" :release-disabled="runtimeControlsDisabled" @runtime-ready="runtimeReady = $event" />
                <div tw-class="flex flex-wrap items-center gap-2">
                  <button type="button" :disabled="runtimeControlsDisabled" @click="restartRuntime" data-testid="audio-restart-runtime" tw-class="inline-flex min-h-9 items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 disabled:cursor-not-allowed disabled:opacity-45 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"><RefreshCcwIcon :tw-class="['h-4 w-4', { 'animate-spin motion-reduce:animate-none': recovery !== undefined }]" />{{ recovery ? lazyStrings.audioGeneration__reinitializing_runtime() : lazyStrings.audioGeneration__reinitialize_runtime() }}</button>
                  <button type="button" tw-class="inline-flex min-h-9 items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-300 dark:hover:bg-gray-800" data-testid="audio-open-model-management" @click="openModelManagement({ event: $event })"><FolderOpenIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.ConnectionTab__model_management() }}</button>
                </div>
                <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__reinitialize_runtime_help() }}</p>
              </div>
            </details>
          </SettingsSelectScope>
        </div>
      </form>
      <section id="audio-generation-results" tabindex="-1" :aria-label="lazyStrings.audioGeneration__generated_audio()">
        <section v-if="history.length" tw-class="space-y-2.5 pt-1.5" data-testid="audio-history">
          <div tw-class="flex flex-wrap items-center justify-between gap-3">
            <h2 tw-class="text-sm font-semibold tracking-tight text-gray-800 dark:text-gray-100">{{ lazyStrings.audioGeneration__generated_audio() }}</h2>
            <button type="button" @click="clearHistory" data-testid="audio-delete-all" tw-class="min-h-9 rounded-lg px-3 py-2 text-xs font-medium text-gray-500 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/40 dark:text-gray-400 dark:hover:bg-red-500/10 dark:hover:text-red-400">{{ lazyStrings.audioGeneration__delete_all_audio() }}</button>
          </div>
          <AudioHistoryResult v-for="entry in history" :key="entry.id" :entry="entry" @remove="removeHistory({ id: $event })" />
          <p tw-class="text-xs text-gray-500 dark:text-gray-400" data-testid="audio-history-usage">{{ lazyStrings.audioGeneration__history_memory_usage({ count: history.length, mebibytes: (totalBytes / (1024 * 1024)).toFixed(2) }) }}</p>
          <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__output_lifetime() }}</p>
        </section>
      </section>
    </main>
  </div>
</template>
