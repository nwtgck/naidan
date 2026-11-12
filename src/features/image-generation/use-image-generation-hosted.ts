import { resolveVaeTileSize } from './vae-tile-size';
import { copyRemoteImageModelEditor } from './remote-image-model-editor';
import { imageSelectionParameters } from './selection-parameters';
import { remoteImageRecommendation } from './recommended-fields';
import { useImageInferencePreferences } from './composables/use-image-inference-preferences';
import { pendingImageHistory } from './history/pending-saves';
import { isRemoteImageRuntime } from '@/01-models/image-generation-remote';
import { imageRecoveryStore } from './execution/recovery';
import { useImageInferenceLocation } from './composables/use-image-inference-location';
import type { PreparedImageExecution } from './execution/types';
import { prepareLocalImageExecution } from './providers/local';
import type { ImageExecutionJob } from './execution/types';
import { generateId } from '@/01-models/id';
import { findDraftImage, findDraftModelFile, type ImageGenerationDraft } from './generation-draft';
import type { ImageGenerationCompletion, ImageGenerationSubmission, PreparedImageGeneration } from './generation-submission';
import { planImageGenerationSeeds } from '@/01-models/image-generation';
import { downloadBlob } from '@/utils/stream-download';
import { nanoid } from 'nanoid';
import { createImageDiagnosticBuffer, type ImageDiagnostic } from '@/features/stable-diffusion-cpp-browser/diagnostics';
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { lazyStrings, ensureStrings } from '@/strings';
import { rawConfiguration, initialProfile, supportsJspi, supportsMemory64, useImageLibrary, createImageEngineClient, inspectImageInventory } from '@/features/image-generation/providers/local-environment';
import { configurationSchema, getImageRuntimeFeatures, requestSchema, previewSettingsSchema, type PreviewFrame, type ModelSlot, type Request } from '@/features/stable-diffusion-cpp-browser/types';
import type { ImageReleaseReason } from '@/features/stable-diffusion-cpp-browser/worker/types';
import { createImageGallery } from './image-gallery';
import { createImageForm } from './form';
import { useImagePreferences } from '@/features/stable-diffusion-cpp-browser/use-image-preferences';
import { useImageEngineState } from '@/features/stable-diffusion-cpp-browser/use-image-engine-state';
import { useSettings } from '@/composables/useSettings';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { imageLoraRequests, imageLoraHistorySelections } from '@/features/stable-diffusion-cpp-browser/lora-form';
import { emptyImageInputs } from './image-input-form';
import type { ImageModelFacts } from '@/features/stable-diffusion-cpp-browser/recommendations';
import { recommendationForSelection } from '@/features/stable-diffusion-cpp-browser/recommendations';
import type { ImageGenerationView, ImageDownloadFormat, ImageDownloadResult } from './use-image-generation-types';
import { storageService } from '@/00-storage/service';
import type { StorageType } from '@/01-models/types';
import type { BinaryObjectId, ImageGenerationId } from '@/01-models/ids';
import type { ImageGenerationRecord, ImageGenerationSampling } from '@/01-models/image-generation-history';
import { useImageGenerationHistory } from './history/use-image-generation-history';
import { copyImageGenerationSnapshot, snapshotImageGeneration, recoverImageGenerationSnapshot, finishImageGenerationSnapshot } from './history/snapshot';
import { prepareImageHistoryReuse, prepareImageDraftReuse } from './history/reuse';
import { downloadImageBlob, imageGenerationDownloadBlob, type ImageGenerationExportImage } from './history/download';

/** Shared workspace lifecycle. Native imports are isolated behind the local
 * environment facade; the standalone build can use the same RPC execution UI. */
export function useImageGeneration(): ImageGenerationView {
  const configuration = configurationSchema.parse(rawConfiguration);
  const modelFacts = shallowRef<ImageModelFacts>();
  const form = createImageForm({ profile: initialProfile(), runtimeFeatures: getImageRuntimeFeatures({ configuration }), modelFacts });
  const { retainModel, modelResident, preview, keepPreviews, maxPreviews, maxResults, previewError, livePreview, previewSnapshots, debug, diagnosticText, diagnosticStatus, diagnosticFeedback, profile, layout, files, parameters, stepsPreference, guidancePreference, resolvedSteps, resolvedGuidance, vaeTileSizePreference, weightResidency, gpuBudgetMiB, progress, failure, invalid, cancelled, stopping, results } = form;
  const controller = shallowRef<AbortController>();
  const preparingRequests = ref(false);
  const preparingOne = ref(false);
  let preparationController: AbortController | undefined;
  const seedMode = ref<'random' | 'fixed'>('random');
  const benchmarkActive = ref(false);
  const preferenceRestoring = ref(false);
  function currentStorageType(): StorageType {
    try {
      return storageService.getCurrentType();
    } catch {
      return 'memory';
    }
  }
  const storageRevision = ref(0);
  const historyOwner = useImageGenerationHistory({ getStorageType: currentStorageType });
  const history = { ...historyOwner, remove: removeHistoryRecord };
  const historyActions = { busy: ref(false), error: ref(''), missingFiles: ref<string[]>([]), missingInactiveFiles: ref<string[]>([]) };
  const historySaving: ImageGenerationView['historySaving'] = {
    enabled: ref(true),
    supported: computed(() => {
      void storageRevision.value;
      return currentStorageType() === 'opfs';
    }),
    status: ref('idle'),
    error: ref(''),
    pendingCount: ref(0),
    retry: retryHistorySave,
  };
  const unsubscribeStorage = storageService.subscribeToChanges({
    listener: ({ event }) => {
      switch (event.type) {
      case 'migration':
        storageRevision.value++;
        historySaving.status.value = 'idle';
        historySaving.error.value = '';
        break;
      case 'chat_meta_and_chat_group': case 'chat_content': case 'chat_content_generation': case 'settings': case 'naidan_rpc_registry': case 'binary_objects': break;
      default: {
        const exhaustive: never = event;
        throw new Error(String(exhaustive));
      }
      }
    },
  });
  const pendingSaves = new Map<number, ImageGenerationId>();
  const savedHistoryIds = ref(new Map<number, ImageGenerationId>());
  let activeHistoryId: ImageGenerationId | undefined;
  const unsubscribePendingHistory = pendingImageHistory.subscribe({
    listener({ event }) {
      switch (event.type) {
      case 'changed': return;
      case 'saved':
        for (const [resultId, id] of pendingSaves) {
          if (id === event.id && finalGallery.entries().some(entry => entry.id === resultId)) {
            savedHistoryIds.value.set(resultId, id);
          }
        }
        if (activeHistoryId === event.id && historySaving.supported.value) {
          historySaving.status.value = 'saved';
        }
        break;
      case 'discarded':
        if (activeHistoryId === event.id && historySaving.supported.value) {
          historySaving.status.value = 'idle';
        }
        break;
      default: {
        const exhaustive: never = event;
        throw new Error(String(exhaustive));
      }
      }
      for (const [resultId, id] of pendingSaves) {
        if (id === event.id) {
          pendingSaves.delete(resultId);
        }
      }
      historySaving.pendingCount.value = pendingSaves.size;
      if (activeHistoryId === event.id) {
        historySaving.error.value = '';
      }
      clearDiscardedHistoryStatus();
    },
  });
  let historySaveRunning = false;
  let restoredModels: Request['models'] | undefined;
  const inputIds = new WeakMap<File, BinaryObjectId>();
  const inferenceLocation = useImageInferenceLocation({ form, blocked: () => busy.value || benchmarkActive.value || preferenceRestoring.value || historyActions.busy.value || historySaving.status.value === 'saving', identifyInput });
  const remote = computed(() => inferenceLocation.kind.value === 'naidan_rpc');
  function identifyInput({ file }: { file: File }): BinaryObjectId {
    let id = inputIds.get(file);
    if (!id) {
      id = generateId<BinaryObjectId>();
      inputIds.set(file, id);
    }
    return id;
  }
  let preferenceFilesMissing = false;
  const diagnosticBuffer = createImageDiagnosticBuffer();
  const manualFacts = shallowRef<ImageModelFacts>();
  const manualInspectionState = ref<'idle' | 'scanning' | 'failed'>('idle');
  let manualInspection: AbortController | undefined;
  let manualInspectionPromise: Promise<void> | undefined;
  let manualSelectionRevision = 0;
  function recordDiagnostic({ diagnostic }: { diagnostic: ImageDiagnostic }): void {
    if (disposed) {
      return;
    }
    diagnosticBuffer.append({ diagnostic });
    diagnosticText.value = diagnosticBuffer.text();
    switch (diagnostic.event) {
    case 'waiting': diagnosticStatus.value = `${diagnostic.stage} · ${(diagnostic.elapsedMs / 1000).toFixed(0)} s · Worker silence ${(Number(diagnostic.fields.workerSilentMs) / 1000).toFixed(0)} s`;
      break;
    case 'start': case 'complete': case 'failed': case 'cancelled': case 'progress':
      diagnosticStatus.value = `${diagnostic.stage} · ${diagnostic.event} · ${(diagnostic.elapsedMs / 1000).toFixed(1)} s`;
      break;
    case 'request': case 'native': case 'file-summary': case 'file-read': case 'gpu': case 'dropped': break;
    default: {
      const exhaustive: never = diagnostic.event;
      throw new Error(String(exhaustive));
    }
    }
  }
  async function copyDiagnostics(): Promise<void> {
    try {
      await navigator.clipboard.writeText(diagnosticText.value);
      diagnosticFeedback.value = await ensureStrings.stableDiffusionCppBrowser__logs_copied();
    } catch {
      diagnosticFeedback.value = await ensureStrings.stableDiffusionCppBrowser__logs_copy_failed();
    }
  }
  function saveDiagnostics(): void {
    const filename = `naidan-image-diagnostics-${nanoid()}.jsonl`;
    // This diagnostic ring is bounded independently of output size. Keep its
    // save path usable even while diagnosing an unavailable Service Worker.
    downloadBlob({ blob: new Blob([diagnosticText.value], { type: 'text/plain;charset=utf-8' }), filename });
  }
  const finalGallery = createImageGallery<{ parameters: ImageGenerationRecord['request']['parameters'], sampling?: ImageGenerationSampling, modelVersion: string, uniformOutput: boolean, elapsedMs: number, request: ImageGenerationRecord['request'], image: ImageGenerationExportImage }>({ initialLimit: 20, maxBytes: 256 * 1024 ** 2 });
  const liveGallery = createImageGallery<Omit<PreviewFrame, 'png'> & { elapsedMs: number }>({ initialLimit: 1, maxBytes: 64 * 1024 ** 2 });
  const snapshotGallery = createImageGallery<Omit<PreviewFrame, 'png'> & { elapsedMs: number, request: ImageGenerationRecord['request'] }>({ initialLimit: 16, maxBytes: 64 * 1024 ** 2 });
  let disposed = false;
  let client: ReturnType<typeof createImageEngineClient> | undefined;
  let activeJob: ImageExecutionJob | undefined;
  let generateStartedAt = 0;
  let stopRequested = false;
  let submissionActive = false;
  const now = (): number => globalThis.performance?.now() ?? Date.now();
  const busy = computed(() => controller.value !== undefined);
  // Basic inputs are a draft for the next immutable request. Context changes
  // and submission retain the stricter formDisabled guard below.
  const draftRestoreDisabled = computed(() => preferenceRestoring.value || busy.value || benchmarkActive.value || historyActions.busy.value || historySaving.status.value === 'saving');
  const draftDisabled = computed(() => preferenceRestoring.value || benchmarkActive.value || historyActions.busy.value || !remote.value && configuration.kind === 'unavailable');
  const formDisabled = computed(() => preferenceRestoring.value || busy.value || benchmarkActive.value || historyActions.busy.value || historySaving.status.value === 'saving' || !remote.value && configuration.kind === 'unavailable');
  const library = useImageLibrary({
    runtimeFeatures: getImageRuntimeFeatures({ configuration }),
    downloadsBlocked: () => configuration.kind === 'unavailable',
    blocked: () => formDisabled.value,
    dependencies: undefined,
    onSelection({ family, turbo }) {
      // Background local inspection must not change a remote draft.
      if (!remote.value) {
        parameters.value = imageSelectionParameters({ parameters: parameters.value, family, turbo, location: 'local' });
      }
    },
  });
  // A retained local model is not evidence about the model on a remote peer.
  watch(() => remote.value ? inferenceLocation.selectedFacts.value : library.selectedCandidateKey.value ? library.selectedFacts.value : manualFacts.value, value => {
    modelFacts.value = value;
  }, { immediate: true, flush: 'sync' });
  const recommendation = computed(() => remote.value
    ? remoteImageRecommendation({ recommendation: recommendationForSelection({ model: inferenceLocation.selectedFacts.value }) })
    : recommendationForSelection({ model: library.selectedCandidateKey.value ? library.selectedFacts.value : manualFacts.value }));
  const resolvedVaeTileSize = computed(() => resolveVaeTileSize({
    preference: vaeTileSizePreference.value,
    family: remote.value ? inferenceLocation.selectedFacts.value?.family : library.selectedCandidateKey.value ? library.selectedFacts.value?.family : manualFacts.value?.family,
  }));
  // Adapters and input images belong to the selected base model; do not carry
  // them silently to another model with a different conditioning contract.
  watch([library.selectedCandidateKey, layout, () => files.value.model, () => files.value.diffusion], () => {
    restoredModels = undefined;
    manualSelectionRevision++;
    // Inspection belongs to the active primary selection, including layout.
    // A result from the other retained slot must never choose this model's tile.
    manualInspection?.abort();
    manualInspection = undefined;
    manualInspectionPromise = undefined;
    manualFacts.value = undefined;
    manualInspectionState.value = 'idle';
    if (preferenceFilesMissing && !preferenceRestoring.value && (library.selectedFacts.value || files.value.model || files.value.diffusion)) {
      clearHistoryMissingFiles();
    }
    form.loras.value = [];
    if (!remote.value) {
      form.imageInputs.value = emptyImageInputs();
    }
  }, { flush: 'sync' });
  watch(layout, () => {
    if (!remote.value && !library.selectedCandidateKey.value) {
      void inspectManualFiles();
    }
  });
  function inspectManualFiles(): Promise<void> {
    const pending = inspectManualFilesOnce();
    manualInspectionPromise = pending;
    const clear = () => {
      if (manualInspectionPromise === pending) {
        manualInspectionPromise = undefined;
      }
    };
    void pending.then(clear, clear);
    return pending;
  }
  async function inspectManualFilesOnce(): Promise<void> {
    if (formDisabled.value || disposed) {
      return;
    }
    manualInspection?.abort();
    manualFacts.value = undefined;
    manualInspectionState.value = 'idle';
    const slot = (() => {
      switch (layout.value) {
      case 'checkpoint': return 'model' as const;
      case 'components': return 'diffusion' as const;
      default: {
        const exhaustive: never = layout.value;
        throw new Error(String(exhaustive));
      }
      }
    })();
    const file = files.value[slot];
    if (!file) {
      return;
    }
    const controller = new AbortController();
    manualInspection = controller;
    manualInspectionState.value = 'scanning';
    try {
      const next = await inspectImageInventory({
        signal: controller.signal,
        onProgress() {},
        repositories: [{ repositoryKey: 'manual', repositoryLabel: 'manual', files: [{ relativePath: file.name, file }] }],
      });
      if (!disposed && manualInspection === controller && !controller.signal.aborted) {
        const candidate = next.candidates.find(item => item.roles.includes(slot) && !item.issue);
        manualFacts.value = candidate ? { family: candidate.family, variant: candidate.variant, evidence: candidate.evidence } : undefined;
        manualInspectionState.value = 'idle';
      }
    } catch {
      if (!disposed && manualInspection === controller && !controller.signal.aborted) {
        manualInspectionState.value = 'failed';
      }
    } finally {
      if (manualInspection === controller) {
        manualInspection = undefined;
      }
    }
  }
  function applyRecommendedSettings(): void {
    const preset = recommendation.value;
    if (!preset || draftDisabled.value || !remote.value && library.importing.value || disposed) {
      return;
    }
    const defaults = form.modelParameterDefaults.value;
    switch (defaults.steps.origin) {
    case 'recommended':
      stepsPreference.value = 'auto';
      parameters.value.steps = defaults.steps.value;
      break;
    case 'standard': break;
    default: {
      const exhaustive: never = defaults.steps.origin;
      throw new Error(String(exhaustive));
    }
    }
    switch (defaults.guidance.origin) {
    case 'recommended':
      guidancePreference.value = 'auto';
      parameters.value.guidance = defaults.guidance.value;
      break;
    case 'standard': break;
    default: {
      const exhaustive: never = defaults.guidance.origin;
      throw new Error(String(exhaustive));
    }
    }
    // Resolution belongs to the composition the user chose. Applying a model
    // preset changes sampling settings without resizing that composition.
    if (preset.applicableFields) {
      const fields = preset.applicableFields.filter(field => field !== 'width' && field !== 'height' && field !== 'bf16WeightType' && field !== 'vaeTileSize' && field !== 'steps' && field !== 'guidance'
        && (!preset.recommendedFieldsOnly || preset.recommendedFields?.includes(field)));
      parameters.value = { ...parameters.value, ...Object.fromEntries(fields.map(field => [field, preset.parameters[field]])) };
    } else if (preset.recommendedFieldsOnly) {
      // A partially supported model must not overwrite steps/scheduler with
      // ordinary browser defaults that are not valid Turbo recommendations.
      const fields = preset.recommendedFields ?? [];
      parameters.value = {
        ...parameters.value,
        ...Object.fromEntries(fields.filter(field => field !== 'width' && field !== 'height' && field !== 'bf16WeightType' && field !== 'vaeTileSize' && field !== 'steps' && field !== 'guidance').map(field => [field, preset.parameters[field]])),
      };
    } else {
      // Precision and tile intent are user/runtime choices, not sampling presets.
      const { width: _width, height: _height, bf16WeightType: _bf16WeightType, vaeTileSize: _vaeTileSize, steps: _steps, guidance: _guidance, ...settings } = preset.parameters;
      parameters.value = { ...parameters.value, ...settings };
    }
    if (!busy.value && !preset.recommendedFieldsOnly) {
      preview.value = { ...preview.value, ...preset.preview };
    }
  }
  function randomSeed(): string {
    return String(Math.max(1, crypto.getRandomValues(new Uint32Array(1))[0] ?? 1));
  }
  function randomizeSeed(): void {
    if (draftDisabled.value || disposed) {
      return;
    }
    parameters.value.seed = randomSeed();
    seedMode.value = 'fixed';
  }
  const artifact = computed(() => {
    switch (configuration.kind) {
    case 'available': return configuration.artifacts.find(item => item.profile === profile.value);
    case 'unavailable': return undefined;
    default: {
      const exhaustive: never = configuration;
      throw new Error(String(exhaustive));
    }
    }
  });
  const unavailable = computed(() => {
    if (remote.value) {
      return undefined;
    }
    switch (configuration.kind) {
    case 'unavailable': {
      switch (configuration.reason) {
      case 'standalone': return lazyStrings.stableDiffusionCppBrowser__hosted_build_required();
      case 'not-installed': return lazyStrings.stableDiffusionCppBrowser__artifact_not_installed();
      default: {
        const exhaustive: never = configuration.reason;
        throw new Error(String(exhaustive));
      }
      }
    }
    case 'available':
      if (!globalThis.isSecureContext || !('gpu' in navigator) || typeof DecompressionStream === 'undefined' || typeof OffscreenCanvas === 'undefined') {
        return lazyStrings.stableDiffusionCppBrowser__webgpu_required();
      }
      if (profile.value.endsWith('jspi') && !supportsJspi()) {
        return lazyStrings.stableDiffusionCppBrowser__jspi_unavailable();
      }
      if (profile.value === 'webgpu-wasm64-jspi' && !supportsMemory64()) {
        return lazyStrings.stableDiffusionCppBrowser__memory64_unavailable();
      }
      return undefined;
    default: {
      const exhaustive: never = configuration;
      throw new Error(String(exhaustive));
    }
    }
  });
  // Availability is not inferred from a lazily loaded translated string.
  const localSupported = computed(() => artifact.value !== undefined && globalThis.isSecureContext && 'gpu' in navigator && typeof DecompressionStream !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && (!profile.value.endsWith('jspi') || supportsJspi()) && (profile.value !== 'webgpu-wasm64-jspi' || supportsMemory64()));
  const supported = computed(() => remote.value || localSupported.value);
  const engineState = useImageEngineState({ client: () => client, supported: localSupported, progress, modelResident });
  function chooseFile({ slot, event }: { slot: ModelSlot, event: Event }): void {
    if (formDisabled.value || library.importing.value || !(event.target instanceof HTMLInputElement)) {
      return;
    }
    library.useManualFiles();
    const previousModels = restoredModels;
    restoredModels = undefined;
    manualFacts.value = undefined;
    const file = event.target.files?.[0];
    files.value = { ...files.value, [slot]: file };
    if (previousModels) {
      // Keep metadata for every unchanged slot whose File remains selected, even
      // when the base-model watcher resets adapters and input images. Only the
      // replacement loses its old path and split-file association.
      const retained = previousModels.filter(model => model.slot !== slot);
      restoredModels = file ? [...retained, { slot, file }] : retained;
    }
    void inspectManualFiles();
  }
  function resetFiles(): void {
    if (formDisabled.value || library.importing.value || disposed) {
      return;
    }
    library.useManualFiles();
    restoredModels = undefined;
    manualFacts.value = undefined;
    manualInspection?.abort();
    manualInspection = undefined;
    manualInspectionState.value = 'idle';
    files.value = {};
  }
  function releaseFor({ reason }: { reason: ImageReleaseReason }): void {
    client?.release({ reason });
    modelResident.value = false;
    engineState.invalidate();
  }
  function acquireBenchmark(): boolean {
    if (disposed || benchmarkActive.value || busy.value || formDisabled.value || !supported.value || library.importing.value || library.scanState.value === 'scanning') {
      return false;
    }
    benchmarkActive.value = true;
    manualInspection?.abort();
    manualInspection = undefined;
    manualInspectionState.value = 'idle';
    library.cancelScan();
    releaseModel();
    return true;
  }
  function releaseBenchmark(): void {
    benchmarkActive.value = false;
  }
  let releaseAfterRun: AbortController | undefined;
  function setRetainModel({ retain }: { retain: boolean }): void {
    retainModel.value = retain;
    if (!retain) {
      releaseModel();
    }
  }
  function releaseModel(): void {
    if (controller.value) {
      releaseAfterRun = controller.value;
      return;
    }
    releaseFor({ reason: 'explicit-release' });
  }
  function removeResult({ resultId }: { resultId: number }): void {
    finalGallery.remove({ id: resultId });
    results.value = finalGallery.entries();
    prunePendingHistory();
  }
  function clearResults(): void {
    finalGallery.clear();
    results.value = [];
    prunePendingHistory();
  }
  function prunePendingHistory(): void {
    const retained = new Set(finalGallery.entries().map(entry => entry.id));
    // Gallery limits and removal only release presentation; failed publications
    // stay in the process-owned pending history until saved or explicitly discarded.
    for (const id of savedHistoryIds.value.keys()) {
      if (!retained.has(id)) {
        savedHistoryIds.value.delete(id);
      }
    }
    historySaving.pendingCount.value = pendingSaves.size;
    clearDiscardedHistoryStatus();
  }
  function clearDiscardedHistoryStatus(): void {
    if (historySaving.status.value !== 'failed' && historySaving.status.value !== 'saved') {
      return;
    }
    const stillRetained = [...pendingSaves.values()].some(id => id === activeHistoryId)
      || [...savedHistoryIds.value.values()].some(id => id === activeHistoryId);
    if (!stillRetained) {
      historySaving.status.value = 'idle';
      historySaving.error.value = '';
    }
  }
  function savedHistoryId({ resultId }: { resultId: number }): ImageGenerationId | undefined {
    return historySaving.supported.value ? savedHistoryIds.value.get(resultId) : undefined;
  }
  async function removeHistoryRecord({ id }: { id: ImageGenerationId }): Promise<void> {
    await historyOwner.remove({ id });
    // Forget navigation only after deletion succeeds. Generated result images
    // and shared binary objects remain independently available.
    for (const [resultId, historyId] of savedHistoryIds.value) {
      if (historyId === id) {
        savedHistoryIds.value.delete(resultId);
      }
    }
    clearDiscardedHistoryStatus();
  }
  function removePreview({ previewId }: { previewId: number }): void {
    snapshotGallery.remove({ id: previewId });
    previewSnapshots.value = snapshotGallery.entries();
  }
  function clearPreviews(): void {
    liveGallery.clear();
    snapshotGallery.clear();
    livePreview.value = undefined;
    previewSnapshots.value = [];
  }
  watch(maxResults, value => {
    finalGallery.setLimit({ value });
    results.value = finalGallery.entries();
    prunePendingHistory();
  });
  watch(maxPreviews, value => {
    snapshotGallery.setLimit({ value });
    previewSnapshots.value = snapshotGallery.entries();
  });
  let lastValidPreview = { ...preview.value };
  watch(preview, settings => {
    const parsed = previewSettingsSchema.safeParse(settings);
    previewError.value = parsed.success ? '' : 'invalid';
    if (parsed.success) {
      lastValidPreview = parsed.data;
      if (busy.value) {
        activeJob?.updatePreview?.({ settings: parsed.data });
      }
    } else if (!settings.enabled && busy.value) {
      // Turning capture OFF must work even while an interval input is empty.
      activeJob?.updatePreview?.({ settings: { ...lastValidPreview, enabled: false } });
    }
  }, { deep: true, flush: 'sync' });
  // Selection and restoration edit the next request. The native client checks
  // source/runtime compatibility at Generate, never during passive navigation.
  async function retryHistorySave(): Promise<void> {
    if (!pendingSaves.size || historySaveRunning || disposed) {
      return;
    }
    historySaveRunning = true;
    historyActions.error.value = '';
    const revision = storageRevision.value;
    let currentStatus = historySaving.status.value;
    let currentError = historySaving.error.value;
    historySaving.status.value = 'saving';
    try {
      for (const [resultId, id] of pendingSaves) {
        if (disposed) {
          break;
        }
        if (!pendingImageHistory.list().some(entry => entry.record.id === id)) {
          pendingSaves.delete(resultId);
          continue;
        }
        try {
          await pendingImageHistory.retry({ id });
          pendingSaves.delete(resultId);
          if (finalGallery.entries().some(entry => entry.id === resultId)) {
            savedHistoryIds.value.set(resultId, id);
          }
          if (id === activeHistoryId) {
            currentStatus = 'saved';
            currentError = '';
          }
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          if (id === activeHistoryId) {
            currentStatus = 'failed';
            currentError = message;
          } else {
            historyActions.error.value = message;
          }
        }
      }
      if (!disposed && revision === storageRevision.value && currentStorageType() === 'opfs') {
        // Saving owns the completed record, not the time needed to search all
        // history. The history owner tracks this refresh, including its errors
        // and disposal, without keeping the next generation disabled.
        void history.reload();
      }
    } finally {
      historySaveRunning = false;
      historySaving.pendingCount.value = pendingSaves.size;
      if (!disposed) {
        historySaving.status.value = revision === storageRevision.value ? currentStatus : 'idle';
        historySaving.error.value = revision === storageRevision.value ? currentError : '';
        // A result can be discarded while an OPFS save is pending. Its late
        // completion must not restore an error/status for an absent image.
        clearDiscardedHistoryStatus();
      }
    }
  }
  function clearHistoryMissingFiles(): void {
    preferenceFilesMissing = false;
    historyActions.missingFiles.value = [];
    historyActions.missingInactiveFiles.value = [];
  }
  function captureDraft(): ImageGenerationDraft | undefined {
    if (disposed) {
      return undefined;
    }
    if (remote.value) {
      const snapshot = inferenceLocation.captureDraftRequest({ seed: parameters.value.seed });
      return {
        inferenceLocation: inferenceLocation.captureLocation(),
        stepsPreference: stepsPreference.value,
        guidancePreference: guidancePreference.value,
        vaeTileSizePreference: vaeTileSizePreference.value,
        request: snapshot.request,
        layout: layout.value,
        modelSelection: undefined,
        remoteModelEditor: copyRemoteImageModelEditor({ editor: inferenceLocation.editor.value }),
        loraStates: [],
        seedMode: seedMode.value,
        debug: 'off',
        retainModel: false,
        keepPreviews: keepPreviews.value,
        maxPreviews: maxPreviews.value,
        maxResults: maxResults.value,
        files: snapshot.inputFiles,
        modelFiles: [],
      };
    }
    if (!artifact.value) {
      const snapshot = inferenceLocation.captureDraftRequest({ seed: parameters.value.seed });
      return {
        inferenceLocation: { kind: 'local' },
        stepsPreference: stepsPreference.value,
        guidancePreference: guidancePreference.value,
        vaeTileSizePreference: vaeTileSizePreference.value,
        request: { ...snapshot.request, parameters: { ...parameters.value, steps: resolvedSteps.value, guidance: resolvedGuidance.value, vaeTileSize: resolvedVaeTileSize.value } },
        layout: layout.value,
        modelSelection: library.captureModelSelection({ loras: form.loras.value }),
        remoteModelEditor: undefined,
        loraStates: [],
        seedMode: seedMode.value,
        debug: debug.value,
        retainModel: retainModel.value,
        keepPreviews: keepPreviews.value,
        maxPreviews: maxPreviews.value,
        maxResults: maxResults.value,
        files: snapshot.inputFiles,
        modelFiles: [],
      };
    }
    const slots: ModelSlot[] = (() => {
      switch (layout.value) {
      case 'checkpoint': return ['model'];
      case 'components': return ['diffusion', 'vae', 'clipL', 'clipG', 't5', 'lm'];
      default: {
        const exhaustive: never = layout.value;
        throw new Error(String(exhaustive));
      }
      }
    })();
    const sourceCommit = (() => {
      switch (configuration.kind) {
      case 'available': return configuration.sourceCommit;
      case 'unavailable': return '';
      default: {
        const exhaustive: never = configuration;
        throw new Error(String(exhaustive));
      }
      }
    })();
    const models = library.selectedCandidateKey.value ? library.selectedModels() ?? [] : restoredModels ?? slots.flatMap(slot => {
      const file = files.value[slot];
      return file ? [{ slot, file }] : [];
    });
    const modelFiles: ImageGenerationDraft['modelFiles'] = [];
    const snapshot = snapshotImageGeneration({
      request: {
        debug: debug.value,
        runId: 0,
        sessionId: '',
        artifact: artifact.value,
        baseUrl: window.location.href,
        models,
        loras: imageLoraHistorySelections({ selections: form.loras.value }),
        imageInputs: form.imageInputs.value,
        parameters: { ...parameters.value, steps: resolvedSteps.value, guidance: resolvedGuidance.value, vaeTileSize: resolvedVaeTileSize.value },
        preview: { ...preview.value },
        weightResidency: weightResidency.value,
        gpuBudgetMiB: gpuBudgetMiB.value === '' ? undefined : gpuBudgetMiB.value,
      },
      sourceCommit,
      createdAt: Date.now(),
      identifyInput,
      locateFile({ file }) {
        const location = library.historyFileLocation({ file });
        modelFiles.push({ location, file });
        return location;
      },
    });
    return {
      inferenceLocation: inferenceLocation.captureLocation(),
      stepsPreference: stepsPreference.value,
      guidancePreference: guidancePreference.value,
      vaeTileSizePreference: vaeTileSizePreference.value,
      request: snapshot.request,
      layout: layout.value,
      modelSelection: library.captureModelSelection({ loras: form.loras.value }),
      remoteModelEditor: undefined,
      loraStates: form.loras.value.map(({ enabled, strength }) => ({ enabled, strength })),
      seedMode: seedMode.value,
      debug: debug.value,
      retainModel: retainModel.value,
      keepPreviews: keepPreviews.value,
      maxPreviews: maxPreviews.value,
      maxResults: maxResults.value,
      files: snapshot.inputFiles,
      modelFiles,
    };
  }
  function resetDraft(): void {
    if (formDisabled.value || disposed) {
      return;
    }
    parameters.value = { ...parameters.value, prompt: '', negativePrompt: '' };
    seedMode.value = 'random';
    form.imageInputs.value = emptyImageInputs();
    failure.value = '';
    invalid.value = false;
  }
  async function restoreDraft({ draft }: { draft: ImageGenerationDraft }): Promise<void> {
    await restoreDraftChecked({ draft });
  }
  async function restoreDraftChecked({ draft }: { draft: ImageGenerationDraft }): Promise<boolean> {
    if (draftRestoreDisabled.value || disposed) {
      return false;
    }
    const revision = storageRevision.value;
    if (draft.inferenceLocation?.kind === 'local' || draft.request.runtime && draft.request.runtime.profile !== 'naidan-rpc') {
      nativePreferences.discardDeferredModelSelection();
    }
    const restored = draft.request.runtime ? await restoreRequest({
      request: { ...draft.request, runtime: draft.request.runtime },
      purpose: { type: 'draft', loraStates: draft.loraStates, layout: draft.layout, modelSelection: draft.modelSelection, remoteModelEditor: draft.remoteModelEditor },
      findFile: ({ location }) => {
        // Stored sources must follow the current inventory after an explicit
        // refresh. Only directly chosen files are owned by the memory draft.
        switch (location.type) {
        case 'file': return findDraftModelFile({ entries: draft.modelFiles, location });
        case 'opfs': case 'host': case 'temp': return library.findHistoryFile({ location });
        default: {
          const exhaustive: never = location;
          throw new Error(String(exhaustive));
        }
        }
      },
      getImage: async ({ binaryObjectId }) => findDraftImage({ files: draft.files, binaryObjectId }) ?? await history.getImage({ binaryObjectId }),
    }) : await restoreUnfinishedDraft({ draft });
    if (!restored || disposed || revision !== storageRevision.value) {
      return false;
    }
    // Only new metadata carries automatic intent. Legacy numeric drafts are fixed,
    // even when their value equals the current browser standard.
    // Older remote drafts had no tile control; retain receiver model-following
    // behavior only when neither intent nor an effective numeric tile exists.
    vaeTileSizePreference.value = draft.vaeTileSizePreference ?? draft.request.parameters.vaeTileSize
      ?? (draft.inferenceLocation?.kind === 'naidan_rpc' || draft.request.runtime?.profile === 'naidan-rpc' ? 'auto' : 32);
    stepsPreference.value = draft.stepsPreference ?? draft.request.parameters.steps;
    guidancePreference.value = draft.guidancePreference ?? draft.request.parameters.guidance;
    seedMode.value = draft.seedMode;
    debug.value = draft.debug;
    retainModel.value = draft.retainModel;
    keepPreviews.value = draft.keepPreviews;
    maxPreviews.value = draft.maxPreviews;
    maxResults.value = draft.maxResults;
    // Reuse the existing identities after resolving input files from persistence.
    const inputs = form.imageInputs.value;
    if (inputs.initImage && draft.request.imageInputs.initImage) {
      inputIds.set(inputs.initImage, draft.request.imageInputs.initImage.binaryObjectId);
    }
    inputs.referenceImages.forEach((file, index) => {
      const image = draft.request.imageInputs.referenceImages[index];
      if (image) {
        inputIds.set(file, image.binaryObjectId);
      }
    });
    return true;
  }
  async function restoreUnfinishedDraft({ draft }: { draft: ImageGenerationDraft }): Promise<boolean> {
    const revision = storageRevision.value;
    historyActions.busy.value = true;
    historyActions.error.value = '';
    try {
      const load = async ({ image }: { image: { binaryObjectId: BinaryObjectId, name: string } }): Promise<File> => {
        const blob = findDraftImage({ files: draft.files, binaryObjectId: image.binaryObjectId }) ?? await history.getImage({ binaryObjectId: image.binaryObjectId });
        if (!blob) {
          throw new Error(`Image generation input is missing: ${image.name}`);
        }
        return new File([blob], image.name, { type: blob.type });
      };
      const inputs = draft.request.imageInputs;
      const initImage = inputs.initImage ? await load({ image: inputs.initImage }) : undefined;
      const referenceImages: File[] = [];
      for (const image of inputs.referenceImages) {
        referenceImages.push(await load({ image }));
      }
      if (disposed || revision !== storageRevision.value || !draft.inferenceLocation) {
        return false;
      }
      inferenceLocation.restoreLocation({ location: draft.inferenceLocation, modelEditor: draft.remoteModelEditor });
      layout.value = draft.layout;
      parameters.value = { ...parameters.value, ...draft.request.parameters };
      preview.value = { ...draft.request.preview };
      form.imageInputs.value = { initImage, referenceImages, strength: inputs.strength };
      historyActions.missingFiles.value = [];
      historyActions.missingInactiveFiles.value = [];
      invalid.value = false;
      failure.value = '';
      return true;
    } catch (cause) {
      if (!disposed && revision === storageRevision.value) {
        historyActions.error.value = cause instanceof Error ? cause.message : String(cause);
      }
      return false;
    } finally {
      historyActions.busy.value = false;
    }
  }
  async function reuseHistory({ record }: { record: ImageGenerationRecord }): Promise<void> {
    await restoreRequest({ request: record.request, purpose: { type: 'history' }, findFile: library.findHistoryFile, getImage: history.getImage });
  }
  async function restoreRequest({ request, findFile, getImage, purpose }: {
    purpose: { type: 'history' } | { type: 'draft', loraStates: ImageGenerationDraft['loraStates'], layout: ImageGenerationDraft['layout'], modelSelection: ImageGenerationDraft['modelSelection'], remoteModelEditor: ImageGenerationDraft['remoteModelEditor'] },
    request: ImageGenerationRecord['request'],
    findFile: ({ location }: { location: ImageGenerationRecord['request']['models'][number]['file'] }) => File | undefined,
    getImage: ({ binaryObjectId }: { binaryObjectId: BinaryObjectId }) => Promise<Blob | undefined>,
  }): Promise<boolean> {
    const blocked = (() => {
      switch (purpose.type) {
      case 'draft': return draftRestoreDisabled.value;
      case 'history': return formDisabled.value;
      default: {
        const exhaustive: never = purpose;
        throw new Error(String(exhaustive));
      }
      }
    })();
    if (blocked || library.importing.value || disposed) {
      return false;
    }
    historyActions.busy.value = true;
    historyActions.error.value = '';
    const revision = storageRevision.value;
    try {
      switch (request.runtime.profile) {
      case 'naidan-rpc': {
        const load = async ({ image }: { image: { binaryObjectId: BinaryObjectId, name: string } }) => {
          const blob = await getImage({ binaryObjectId: image.binaryObjectId });
          if (!blob) {
            throw new Error(`Image generation input is missing: ${image.name}`);
          }
          return new File([blob], image.name, { type: blob.type });
        };
        const initImage = request.imageInputs.initImage ? await load({ image: request.imageInputs.initImage }) : undefined;
        const referenceImages: File[] = [];
        for (const image of request.imageInputs.referenceImages) {
          referenceImages.push(await load({ image }));
        }
        if (disposed || revision !== storageRevision.value) {
          return false;
        }
        inferenceLocation.restore({
          value: request.runtime,
          modelEditor: (() => {
            switch (purpose.type) {
            case 'draft': return purpose.remoteModelEditor;
            case 'history': return undefined;
            default: {
              const exhaustive: never = purpose;
              throw new Error(String(exhaustive));
            }
            }
          })(),
        });
        const { prompt, negativePrompt, width, height, seed, steps, guidance, sampler, scheduler, distilledGuidance } = request.parameters;
        parameters.value = { ...parameters.value, prompt, negativePrompt, width, height, seed, steps, guidance, sampler, scheduler, distilledGuidance };
        stepsPreference.value = request.parameters.steps;
        guidancePreference.value = request.parameters.guidance;
        vaeTileSizePreference.value = request.parameters.vaeTileSize ?? 'auto';
        preview.value = { ...request.preview };
        seedMode.value = 'fixed';
        form.imageInputs.value = { initImage, referenceImages, strength: request.imageInputs.strength };
        historyActions.missingFiles.value = [];
        historyActions.missingInactiveFiles.value = [];
        invalid.value = false;
        failure.value = '';
        return true;
      }
      case 'webgpu-wasm32-asyncify': case 'webgpu-wasm32-jspi': case 'webgpu-wasm64-jspi': break;
      default: {
        const exhaustive: never = request.runtime;
        throw new Error(String(exhaustive));
      }
      }
      nativePreferences.discardDeferredModelSelection();
      await library.prepareHistoryFiles({
        requiredFiles: [
          ...request.models.flatMap(model => [model.file, ...model.companions.map(companion => companion.file)]),
          ...request.loras.map(lora => lora.file),
        ].filter(location => !findFile({ location })),
      });
      if (disposed || revision !== storageRevision.value) {
        return false;
      }
      const restored = await (() => {
        switch (purpose.type) {
        case 'draft': return prepareImageDraftReuse({ record: { request }, findFile, getImage, loraStates: purpose.loraStates });
        case 'history': return prepareImageHistoryReuse({ record: { request }, findFile, getImage });
        default: {
          const exhaustive: never = purpose;
          throw new Error(String(exhaustive));
        }
        }
      })();
      if (disposed || revision !== storageRevision.value) {
        return false;
      }
      // All reads/validation finish before changing the editor. Missing weights
      // are an explicit re-selection state, never a fallback to another model.
      historyActions.busy.value = false;
      inferenceLocation.kind.value = 'local';
      library.useManualFiles();
      switch (purpose.type) {
      case 'draft': layout.value = purpose.layout;
        break;
      case 'history': layout.value = restored.models.some(model => model.slot === 'diffusion') ? 'components' : 'checkpoint';
        break;
      default: {
        const exhaustive: never = purpose;
        throw new Error(String(exhaustive));
      }
      }
      files.value = Object.fromEntries(restored.models.map(model => [model.slot, model.file]));
      // Base-model changes intentionally clear adapters/inputs elsewhere. Apply
      // ALL primary selections first, then restore dependent draft state once.
      const selection = (() => {
        switch (purpose.type) {
        case 'draft': return purpose.modelSelection ? library.restoreModelSelection({ selection: purpose.modelSelection }) : undefined;
        case 'history': return undefined;
        default: {
          const exhaustive: never = purpose;
          throw new Error(String(exhaustive));
        }
        }
      })();
      parameters.value = restored.parameters;
      vaeTileSizePreference.value = restored.parameters.vaeTileSize;
      stepsPreference.value = restored.parameters.steps;
      guidancePreference.value = restored.parameters.guidance;
      seedMode.value = 'fixed';
      preview.value = restored.preview;
      profile.value = request.runtime.profile;
      weightResidency.value = request.runtime.weightResidency;
      gpuBudgetMiB.value = request.runtime.gpuBudgetMiB ?? '';
      form.loras.value = selection?.loras ?? restored.loras;
      form.imageInputs.value = restored.imageInputs;
      restoredModels = restored.models.length ? restored.models : undefined;
      preferenceFilesMissing = false;
      historyActions.missingFiles.value = [...new Set([...restored.missing, ...(selection?.missing ?? [])])];
      historyActions.missingInactiveFiles.value = [...new Set([...restored.missingInactive, ...(selection?.missingInactive ?? [])])];
      invalid.value = false;
      failure.value = '';
      manualFacts.value = undefined;
      return true;
    } catch (cause) {
      if (!disposed && revision === storageRevision.value) {
        historyActions.error.value = cause instanceof Error ? cause.message : String(cause);
      }
      return false;
    } finally {
      historyActions.busy.value = false;
    }
  }
  async function useHistoryImage({ binaryObjectId, role }: { binaryObjectId: BinaryObjectId, role: 'initial' | 'reference' }): Promise<void> {
    if (formDisabled.value || library.importing.value || disposed) {
      return;
    }
    historyActions.error.value = '';
    historyActions.busy.value = true;
    const revision = storageRevision.value;
    try {
      const blob = await history.getImage({ binaryObjectId });
      if (disposed || revision !== storageRevision.value) {
        return;
      }
      if (!blob) {
        throw new Error('The saved image is missing');
      }
      const file = new File([blob], 'history-image.png', { type: blob.type });
      inputIds.set(file, binaryObjectId);
      switch (role) {
      case 'initial': form.imageInputs.value = { ...form.imageInputs.value, initImage: file };
        break;
      case 'reference': form.imageInputs.value = { ...form.imageInputs.value, referenceImages: [...form.imageInputs.value.referenceImages, file] };
        break;
      default: {
        const exhaustive: never = role;
        throw new Error(String(exhaustive));
      }
      }
    } catch (cause) {
      if (!disposed && revision === storageRevision.value) {
        historyActions.error.value = cause instanceof Error ? cause.message : String(cause);
      }
    } finally {
      historyActions.busy.value = false;
    }
  }
  async function downloadHistory({ binaryObjectId, record, format, includeMetadata }: { binaryObjectId: BinaryObjectId, record: ImageGenerationRecord, format: ImageDownloadFormat, includeMetadata: boolean }): Promise<ImageDownloadResult> {
    if (disposed) {
      return { status: 'cancelled' };
    }
    try {
      const frame = record.previews.find(frame => frame.binaryObjectId === binaryObjectId);
      const output: ImageGenerationExportImage = (() => {
        if (record.result.binaryObjectId === binaryObjectId) {
          return { kind: 'final', width: record.result.width, height: record.result.height };
        }
        if (frame) {
          return { kind: 'preview', width: frame.width, height: frame.height, step: frame.step, steps: frame.steps, mode: frame.mode };
        }
        throw new Error('This image does not belong to the selected generation');
      })();
      const image = await history.getImage({ binaryObjectId });
      if (!image) {
        throw new Error('The saved image is missing');
      }
      const blob = await imageGenerationDownloadBlob({ png: image, request: record.request, image: output, format, includeMetadata });
      if (disposed) {
        return { status: 'cancelled' };
      }
      downloadImageBlob({ blob, filename: `naidan-generated-image.${format}` });
      return { status: 'downloaded' };
    } catch (cause) {
      return downloadFailed({ cause });
    }
  }
  async function downloadResult({ resultId, format, includeMetadata }: { resultId: number, format: ImageDownloadFormat, includeMetadata: boolean }): Promise<ImageDownloadResult> {
    if (disposed) {
      return { status: 'cancelled' };
    }
    try {
      const result = finalGallery.entries().find(result => result.id === resultId);
      const image = finalGallery.getBlob({ id: resultId });
      if (!result || !image) {
        throw new Error('The generated image is no longer available');
      }
      const blob = await imageGenerationDownloadBlob({ png: image, request: result.request, image: result.image, format, includeMetadata });
      if (disposed) {
        return { status: 'cancelled' };
      }
      downloadImageBlob({ blob, filename: `naidan-generated-image.${format}` });
      return { status: 'downloaded' };
    } catch (cause) {
      return downloadFailed({ cause });
    }
  }
  async function downloadPreview({ previewId, format, includeMetadata }: { previewId: number, format: ImageDownloadFormat, includeMetadata: boolean }): Promise<ImageDownloadResult> {
    if (disposed) {
      return { status: 'cancelled' };
    }
    try {
      const preview = snapshotGallery.entries().find(preview => preview.id === previewId);
      const png = snapshotGallery.getBlob({ id: previewId });
      if (!preview || !png) {
        throw new Error('The preview image is no longer available');
      }
      const image: ImageGenerationExportImage = { kind: 'preview', width: preview.width, height: preview.height, step: preview.step, steps: preview.steps, mode: preview.mode };
      const blob = await imageGenerationDownloadBlob({ png, request: preview.request, image, format, includeMetadata });
      if (disposed) {
        return { status: 'cancelled' };
      }
      downloadImageBlob({ blob, filename: `naidan-image-preview.${format}` });
      return { status: 'downloaded' };
    } catch (cause) {
      return downloadFailed({ cause });
    }
  }
  function downloadFailed({ cause }: { cause: unknown }): ImageDownloadResult {
    if (disposed) {
      return { status: 'cancelled' };
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    // Each download menu owns its outcome. Do not clear or replace an unrelated
    // history/reuse error, or leave download errors visible on another pane.
    return { status: 'failed', message };
  }
  function preparedGeneration({ execution, snapshot, seeds, historyWriter }: {
    execution: PreparedImageExecution, snapshot: import('./history/snapshot').ImageGenerationSnapshot, seeds: string[],
    historyWriter: ReturnType<typeof storageService.createImageGenerationHistoryWriter> | undefined,
  }): PreparedImageGeneration {
    const policy = preparingRequests.value ? { retain: retainModel.value, enabled: preview.value.enabled, keep: keepPreviews.value } : undefined;
    let consumed = false;
    return {
      get snapshot() {
        return copyImageGenerationSnapshot({ snapshot });
      },
      get seeds() {
        return [...seeds];
      },
      async execute({ submission, signal }) {
        if (consumed || disposed || busy.value) {
          throw new Error('This generation plan is no longer available.');
        }
        signal?.throwIfAborted();
        consumed = true;
        const operation = new AbortController();
        const abort = () => operation.abort(signal?.reason);
        signal?.addEventListener('abort', abort, { once: true });
        try {
          await execute({ execution, snapshot, seeds, submission, operation, policy, historyWriter });
        } finally {
          signal?.removeEventListener('abort', abort);
        }
      },
    };
  }

  async function prepareGeneration({ count, signal, historyWriter }: { count: number, signal: AbortSignal | undefined, historyWriter: ReturnType<typeof storageService.createImageGenerationHistoryWriter> | undefined }): Promise<PreparedImageGeneration | undefined> {
    if (formDisabled.value || disposed) {
      return undefined;
    }
    signal?.throwIfAborted();
    const operation = new AbortController();
    const abort = () => operation.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    preparingOne.value = true;
    if (!preparingRequests.value) {
      preparationController = operation;
    }
    failure.value = '';
    invalid.value = false;
    try {
      if (!remote.value) {
        const plan = await prepareLocalGeneration({ count, signal: operation.signal, historyWriter });
        operation.signal.throwIfAborted();
        return plan;
      }
      controller.value = operation;
      const seed = (() => {
        const mode = seedMode.value;
        switch (mode) {
        case 'random': return randomSeed();
        case 'fixed': return parameters.value.seed;
        default: {
          const exhaustive: never = mode;
          throw new Error(String(exhaustive));
        }
        }
      })();
      const seeds = planImageGenerationSeeds({ baseSeed: seed, count });
      const execution = await inferenceLocation.prepare({ seed, createdAt: Date.now(), signal: operation.signal });
      operation.signal.throwIfAborted();
      if (disposed) {
        return undefined;
      }
      parameters.value.seed = seed;
      return preparedGeneration({ execution, snapshot: execution.snapshot, seeds, historyWriter });
    } catch (error) {
      if (!disposed && !operation.signal.aborted) {
        failure.value = error instanceof Error ? error.message : String(error);
      }
      if (operation.signal.aborted) {
        throw error;
      }
      return undefined;
    } finally {
      preparingOne.value = false;
      if (preparationController === operation) {
        preparationController = undefined;
      }
      signal?.removeEventListener('abort', abort);
      if (controller.value === operation) {
        controller.value = undefined;
      }
    }
  }

  async function generate({ submission }: { submission: ImageGenerationSubmission | undefined }): Promise<void> {
    if (preparingRequests.value || preparingOne.value || formDisabled.value || disposed) {
      return;
    }
    const historyWriter = submission === undefined && historySaving.enabled.value && historySaving.supported.value ? storageService.createImageGenerationHistoryWriter() : undefined;
    const plan = await prepareGeneration({ count: submission?.count ?? 1, signal: undefined, historyWriter });
    if (plan) {
      await plan.execute({ submission, signal: undefined });
    }
  }

  async function prepareRequests({ requests, signal }: { requests: { draft: ImageGenerationDraft, count: number }[], signal: AbortSignal }): Promise<PreparedImageGeneration[]> {
    if (preparingRequests.value || formDisabled.value || disposed) {
      throw new Error('Wait for the image editor to become available.');
    }
    if (!requests.length || requests.length > 128) {
      throw new Error('Use 1–128 generation requests.');
    }
    const common = captureDraft();
    if (!common) {
      throw new Error('The shared image configuration is unavailable.');
    }
    const revision = storageRevision.value;
    const operation = new AbortController();
    const abort = () => operation.abort(signal.reason);
    signal.throwIfAborted();
    signal.addEventListener('abort', abort, { once: true });
    preparationController = operation;
    preparingRequests.value = true;
    const plans: PreparedImageGeneration[] = [];
    let preparationError: unknown;
    let preparationFailed = false;
    let restorationError: unknown;
    let restorationFailed = false;
    try {
      for (const [index, request] of requests.entries()) {
        operation.signal.throwIfAborted();
        if (disposed || revision !== storageRevision.value) {
          throw new Error('The image storage changed during preparation.');
        }
        const restored = await restoreDraftChecked({ draft: request.draft });
        if (!restored || historyActions.error.value || historyActions.missingFiles.value.length) {
          throw new Error(`Request ${index + 1}: ${historyActions.error.value || historyActions.missingFiles.value.join(', ') || 'The requested configuration could not be restored.'}`);
        }
        const plan = await prepareGeneration({ count: request.count, signal: operation.signal, historyWriter: undefined });
        if (!plan) {
          throw new Error(`Request ${index + 1}: ${failure.value || 'Check the model configuration and generation parameters.'}`);
        }
        plans.push(plan);
      }
    } catch (error) {
      preparationFailed = true;
      preparationError = error;
    } finally {
      try {
        if (!disposed && revision === storageRevision.value) {
          if (!await restoreDraftChecked({ draft: common })) {
            restorationFailed = true;
            restorationError = new Error('The shared configuration could not be restored. Check the editor before generating.');
          }
          // Preference watchers must observe restoration while still suspended.
          await nextTick();
        }
      } catch (error) {
        restorationFailed = true;
        restorationError = error;
      } finally {
        signal.removeEventListener('abort', abort);
        preparationController = undefined;
        preparingRequests.value = false;
      }
    }
    if (restorationFailed) {
      throw restorationError;
    }
    if (preparationFailed) {
      throw preparationError;
    }
    operation.signal.throwIfAborted();
    if (disposed || revision !== storageRevision.value) {
      throw new Error('The image storage changed during preparation.');
    }
    return plans;
  }
  async function prepareLocalGeneration({ count, signal, historyWriter }: { count: number, signal: AbortSignal, historyWriter: ReturnType<typeof storageService.createImageGenerationHistoryWriter> | undefined }): Promise<PreparedImageGeneration | undefined> {
    if (!supported.value || !artifact.value || historyActions.missingFiles.value.length || library.importing.value || disposed) {
      return;
    }
    if ((stepsPreference.value === 'auto' || guidancePreference.value === 'auto' || parameters.value.vaeTiling && vaeTileSizePreference.value === 'auto') && !library.selectedCandidateKey.value) {
      const selectedFiles = files.value, selectedLayout = layout.value, selectedRevision = manualSelectionRevision;
      // A second inspection can supersede the first without changing the File.
      // Wait for the current owner rather than accepting an aborted result.
      let pending = manualInspectionPromise ?? (!manualFacts.value ? inspectManualFiles() : undefined);
      do {
        await pending;
        if (disposed || signal.aborted || remote.value || library.selectedCandidateKey.value || files.value !== selectedFiles || layout.value !== selectedLayout || manualSelectionRevision !== selectedRevision) {
          return;
        }
        pending = manualInspectionPromise;
      } while (pending);
      if (stepsPreference.value === 'auto' || guidancePreference.value === 'auto' || parameters.value.vaeTiling && vaeTileSizePreference.value === 'auto') {
        switch (manualInspectionState.value) {
        case 'idle': break;
        case 'failed': case 'scanning':
          invalid.value = true;
          failure.value = stepsPreference.value === 'auto' || guidancePreference.value === 'auto'
            ? await ensureStrings.imageGeneration__model_parameter_inspection_failed()
            : await ensureStrings.imageGeneration__vae_tile_inspection_failed();
          return;
        default: {
          const exhaustive: never = manualInspectionState.value;
          throw new Error(String(exhaustive));
        }
        }
      }
    }
    historySaving.status.value = 'idle';
    historySaving.error.value = '';
    activeHistoryId = undefined;
    invalid.value = false;
    failure.value = '';
    cancelled.value = false;
    stopping.value = false;
    const selectedSlots: ModelSlot[] = (() => {
      switch (layout.value) {
      case 'checkpoint': return ['model'];
      case 'components': return ['diffusion', 'vae', 'clipL', 'clipG', 't5', 'lm'];
      default: {
        const exhaustive: never = layout.value;
        throw new Error(String(exhaustive));
      }
      }
    })();
    const manualModels = selectedSlots.flatMap(slot => {
      const file = files.value[slot];
      return file === undefined ? [] : [{ slot, file }];
    });
    const models = library.selectedCandidateKey.value ? library.selectedModels() : restoredModels ?? manualModels;
    if (!models) {
      invalid.value = true;
      return;
    }
    // Lab random mode resolves in the browser before the immutable request is
    // captured. Diagnostics keeps its separate seed/protocol unchanged.
    const seed = (() => {
      switch (seedMode.value) {
      case 'random': return randomSeed();
      case 'fixed': return parameters.value.seed;
      default: {
        const exhaustive: never = seedMode.value;
        throw new Error(String(exhaustive));
      }
      }
    })();
    const requestedParameters = { ...parameters.value, seed, steps: resolvedSteps.value, guidance: resolvedGuidance.value, vaeTileSize: resolvedVaeTileSize.value };
    if (requestedParameters.seed === '-1') {
      invalid.value = true;
      return;
    }
    const parsed = requestSchema.safeParse({ debug: debug.value, artifact: artifact.value, baseUrl: new URL(import.meta.env.BASE_URL, document.baseURI).href, models, loras: imageLoraRequests({ selections: form.loras.value }), imageInputs: form.imageInputs.value, parameters: requestedParameters, preview: preview.value, weightResidency: weightResidency.value, gpuBudgetMiB: gpuBudgetMiB.value === '' ? undefined : gpuBudgetMiB.value });
    if (!parsed.success) {
      invalid.value = true;
      return;
    }
    let seeds: string[];
    try {
      seeds = planImageGenerationSeeds({ baseSeed: parsed.data.parameters.seed, count });
    } catch {
      invalid.value = true;
      return;
    }
    parameters.value.seed = parsed.data.parameters.seed;
    const sourceCommit = (() => {
      switch (configuration.kind) {
      case 'available': return configuration.sourceCommit;
      case 'unavailable': return '';
      default: {
        const exhaustive: never = configuration;
        throw new Error(String(exhaustive));
      }
      }
    })();
    // Preserve disabled selections in history without making their files part
    // of request validation, Worker transport or native model loading.
    const snapshot = snapshotImageGeneration({ request: { ...parsed.data, loras: imageLoraHistorySelections({ selections: form.loras.value }) }, sourceCommit, locateFile: library.historyFileLocation, createdAt: Date.now(), identifyInput });
    const execution = prepareLocalImageExecution({
      request: parsed.data,
      snapshot,
      client: () => client ??= createImageEngineClient({
        onReleased: () => {
          modelResident.value = false;
          engineState.invalidate();
        },
      }),
      onDiagnostic: recordDiagnostic,
      onModelResident: ({ resident }) => {
        modelResident.value = resident;
      },
    });
    return preparedGeneration({ execution, snapshot, seeds, historyWriter });
  }
  async function execute({ execution, snapshot, seeds, submission, operation, policy, historyWriter }: {
    execution: PreparedImageExecution, snapshot: import('./history/snapshot').ImageGenerationSnapshot,
    seeds: string[], submission: ImageGenerationSubmission | undefined, operation: AbortController,
    policy: { retain: boolean, enabled: boolean, keep: boolean } | undefined,
    historyWriter: ReturnType<typeof storageService.createImageGenerationHistoryWriter> | undefined,
  }): Promise<void> {
    const retainAfterRun = policy?.retain ?? retainModel.value;
    let nativeFailed = false, nativeStarted = false;
    let reservation: { release(): void } | undefined;
    invalid.value = false;
    failure.value = '';
    cancelled.value = false;
    stopping.value = false;
    activeHistoryId = snapshot.id;
    const runPreviewIds = new Set<number>();
    diagnosticBuffer.clear();
    diagnosticText.value = '';
    diagnosticStatus.value = '';
    diagnosticFeedback.value = '';
    liveGallery.clear();
    livePreview.value = undefined;
    manualInspection?.abort();
    manualInspection = undefined;
    manualInspectionState.value = 'idle';
    generateStartedAt = now();
    const runDimensions = { width: snapshot.request.parameters.width, height: snapshot.request.parameters.height };
    form.latestRun.value = { ...runDimensions, status: 'running' };
    controller.value = operation;
    progress.value = { phase: 'runtime', step: 0, steps: 0 };
    let finalImageReceived = false;
    let completion: ImageGenerationCompletion = { type: 'cancelled' };
    stopRequested = false;
    submissionActive = submission !== undefined;
    try {
      // Set busy before awaiting persistence, so double clicks cannot create two
      // owners. The consumer captures the destination before any asynchronous work.
      reservation = execution.reserve?.({ signal: operation.signal });
      if (historyWriter) {
        await historyWriter.ready();
      }
      if (submission) {
        await submission.accepted({ snapshot, seeds: [...seeds] });
      }
      if (disposed || operation.signal.aborted || stopRequested) {
        return;
      }
      for (const [index, actualSeed] of seeds.entries()) {
        if (disposed || operation.signal.aborted || stopRequested) {
          break;
        }
        // Each image has its own preview phase. A previous image's success must
        // not hide previews or failures of the next image in the same run.
        finalImageReceived = false;
        form.latestRun.value = { ...runDimensions, status: 'running' };
        const imageSnapshot = { ...snapshot, request: { ...snapshot.request, parameters: { ...snapshot.request.parameters, seed: actualSeed } } };
        generateStartedAt = now();
        runPreviewIds.clear();
        liveGallery.clear();
        livePreview.value = undefined;
        progress.value = { phase: 'runtime', step: 0, steps: 0 };
        if (historyWriter) {
          pendingImageHistory.assertCapacity();
        }
        const recovery = isRemoteImageRuntime({ runtime: snapshot.request.runtime })
          ? imageRecoveryStore.reserve({ bytes: 32 * 1024 * 1024 + snapshot.inputFiles.reduce((total, file) => total + file.blob.size, 0) })
          : undefined;
        let job: ImageExecutionJob;
        try {
          nativeStarted = true;
          job = execution.start({
            seed: actualSeed,
            signal: operation.signal,
            onProgress({ event }) {
              if (!disposed && !operation.signal.aborted) {
                progress.value = event;
                switch (event.phase) {
                case 'model': if (!isRemoteImageRuntime({ runtime: snapshot.request.runtime })) {
                  modelResident.value = false;
                }
                  break;
                case 'runtime': case 'sampling': case 'decoding': case 'encoding': break;
                default: {
                  const exhaustive: never = event.phase;
                  throw new Error(String(exhaustive));
                }
                }
              }
            },
            onPreview({ frame }) {
              if (disposed || operation.signal.aborted || stopping.value || !(policy?.enabled ?? preview.value.enabled)) {
                return;
              }
              const { png, ...metadata } = frame;
              const entry = { ...metadata, elapsedMs: Math.max(0, now() - generateStartedAt) };
              liveGallery.add({ blob: png, width: frame.width, height: frame.height, metadata: entry });
              livePreview.value = liveGallery.entries()[0];
              if (policy?.keep ?? keepPreviews.value) {
                const saved = snapshotGallery.add({ blob: png, width: frame.width, height: frame.height, metadata: { ...entry, request: imageSnapshot.request } });
                runPreviewIds.add(saved.id);
                previewSnapshots.value = snapshotGallery.entries();
              }
            },
          });
        } catch (error) {
          nativeFailed = true;
          recovery?.release();
          throw error;
        }
        activeJob = job;
        let outcome: Awaited<ImageExecutionJob['result']>;
        try {
          outcome = await job.result;
        } catch (error) {
          nativeFailed = true;
          recovery?.release();
          throw error;
        }
        if (outcome.status === 'interrupted' && outcome.recoverable && recovery) {
          const recovered = recoverImageGenerationSnapshot({ snapshot: imageSnapshot, output: outcome.recoverable, elapsedMs: Math.max(0, now() - generateStartedAt) });
          let id: ImageGenerationId;
          try {
            id = recovery.retain({ ...recovered, retry: submission?.retry });
          } catch (error) {
            recovery.release();
            throw error;
          }
          // Retain first, even after unmount or an abort. A failed publication
          // retries the same asset, not the inference that produced its pixels.
          completion = { type: 'interrupted' };
          if (submission?.recovered) {
            await submission.recovered({ index, ...recovered, onPersisted: () => imageRecoveryStore.remove({ id }), onDiscarded: () => imageRecoveryStore.remove({ id }) });
          }
          if (!disposed) {
            failure.value = outcome.message;
            form.latestRun.value = { ...runDimensions, status: 'failed', failure: outcome.message };
          }
          break;
        }
        recovery?.release();
        if (activeJob === job) {
          activeJob = undefined;
        }
        if (disposed || operation.signal.aborted) {
          break;
        }
        progress.value = undefined;
        const result = (() => {
          switch (outcome.status) {
          case 'completed': return outcome.output;
          case 'cancelled': return undefined;
          case 'failed': case 'interrupted': nativeFailed = true;
            throw new Error(outcome.message);
          default: {
            const exhaustive: never = outcome;
            throw new Error(String(exhaustive));
          }
          }
        })();
        if (!result) {
          stopRequested = true;
          break;
        }
        if (isRemoteImageRuntime({ runtime: imageSnapshot.request.runtime })) {
          if (!result.resolvedParameters) {
            throw new Error('The image provider did not confirm its resolved request parameters');
          }
          // The remote catalog only supplies a draft projection. Confirmed
          // provider request values belong to this image, never to editor state.
          imageSnapshot.request.parameters = { ...imageSnapshot.request.parameters, ...result.resolvedParameters };
        }
        finalImageReceived = true;
        const elapsedMs = Math.max(0, now() - generateStartedAt);
        form.latestRun.value = { ...runDimensions, status: 'succeeded' };
        let publication: ReturnType<typeof finishImageGenerationSnapshot> | undefined;
        if (submission || historyWriter) {
          const previews: PreviewFrame[] = snapshotGallery.entries().flatMap(entry => {
            if (!runPreviewIds.has(entry.id)) {
              return [];
            }
            const png = snapshotGallery.getBlob({ id: entry.id });
            const { id: _id, url: _url, elapsedMs: _elapsedMs, request: _request, ...frame } = entry;
            return png ? [{ ...frame, png }] : [];
          });
          const output = finishImageGenerationSnapshot({ snapshot: imageSnapshot, result: { ...result, uniformOutput: result.uniformOutput ?? false }, previews, elapsedMs });
          if (historyWriter) {
            pendingImageHistory.retain({ ...output, save: ({ publication }) => historyWriter.save(publication) });
          }
          publication = output;
        }
        let finalEntry: ReturnType<typeof finalGallery.add>;
        try {
          finalEntry = finalGallery.add({
            blob: result.png,
            width: result.width,
            height: result.height,
            metadata: { parameters: { ...imageSnapshot.request.parameters }, ...(result.sampling ? { sampling: { sampler: { ...result.sampling.sampler }, scheduler: { ...result.sampling.scheduler } } } : {}), modelVersion: result.modelVersion, uniformOutput: result.uniformOutput ?? false, elapsedMs, request: imageSnapshot.request, image: { kind: 'final', width: result.width, height: result.height } },
          });
          results.value = finalGallery.entries();
          prunePendingHistory();
        } finally {
          // Saving owns pixels even when presentation fails. Keep a visible
          // result when a workspace sink fails its publication afterwards.
          if (submission && publication) {
            await submission.output({ index, ...publication });
          }
        }
        if (!submission && publication && historyWriter) {
          pendingSaves.set(finalEntry.id, publication.record.id);
          historySaving.pendingCount.value = pendingSaves.size;
          await retryHistorySave();
        }
        if (index === seeds.length - 1) {
          completion = { type: 'completed' };
        }
      }
      switch (completion.type) {
      case 'completed': case 'interrupted': break;
      case 'cancelled': cancelled.value = true;
        form.latestRun.value = { ...runDimensions, status: 'cancelled' };
        break;
      default: {
        const exhaustive: never = completion;
        throw new Error(String(exhaustive));
      }
      }
    } catch (error) {
      if (nativeFailed && !isRemoteImageRuntime({ runtime: snapshot.request.runtime })) {
        releaseFor({ reason: 'failed' });
      }
      switch (completion.type) {
      case 'interrupted': break; // Saving cannot confirm interrupted execution.
      case 'completed': case 'cancelled':
        completion = operation.signal.aborted || disposed ? { type: 'cancelled' } : { type: 'failed', message: (error instanceof Error ? error.message : String(error)).slice(-32768) };
        break;
      default: {
        const exhaustive: never = completion;
        throw new Error(String(exhaustive));
      }
      }
      if (!disposed) {
        switch (completion.type) {
        case 'interrupted': failure.value = error instanceof Error ? error.message : String(error);
          break;
        case 'cancelled':
          cancelled.value = true;
          if (!finalImageReceived) {
            form.latestRun.value = { ...runDimensions, status: 'cancelled' };
          }
          break;
        case 'failed':
          failure.value = completion.message;
          if (!finalImageReceived) {
            form.latestRun.value = { ...runDimensions, status: 'failed', failure: failure.value };
          }
          break;
        default: {
          const exhaustive: never = completion;
          throw new Error(String(exhaustive));
        }
        }
      }
    } finally {
      // End native progress before saving terminal metadata. Partial outputs and
      // failed-save buffers belong to the consumer, even when the page is leaving.
      progress.value = undefined;
      reservation?.release();
      try {
        await submission?.finished({ completion });
      } catch (error) {
        if (!disposed) {
          failure.value = (error instanceof Error ? error.message : String(error)).slice(-32768);
        }
      } finally {
        const explicitRelease = releaseAfterRun === operation;
        if (explicitRelease) {
          releaseAfterRun = undefined;
        }
        submissionActive = false;
        activeJob = undefined;
        if (!disposed) {
          controller.value = undefined;
          stopping.value = false;
          // Retention is a run-level policy, not a per-image policy.
          if (!isRemoteImageRuntime({ runtime: snapshot.request.runtime }) && (nativeStarted && !retainAfterRun || explicitRelease) && modelResident.value) {
            releaseFor({ reason: 'retention-disabled' });
          }
          if (!isRemoteImageRuntime({ runtime: snapshot.request.runtime })) {
            engineState.afterRun();
          }
        }
      }
    }
  }
  function cancel(): void {
    preparationController?.abort();
    if (!busy.value || (!progress.value && !submissionActive) || stopping.value) {
      return;
    }
    stopRequested = true;
    stopping.value = true;
    if (progress.value) {
      activeJob?.cancel();
    }
  }
  function forceCancel(): void {
    preparationController?.abort();
    if (!busy.value || (!progress.value && !submissionActive)) {
      return;
    }
    stopRequested = true;
    controller.value?.abort();
  }
  const { settings, initialized, captureExperimentalStorage, updateExperimentalForStorage } = useSettings();
  const { addErrorEvent } = useGlobalEvents();
  useImageInferencePreferences({
    suspended: preparingRequests,
    settings,
    initialized,
    inferenceLocation,
    captureStorage: captureExperimentalStorage,
    updateForStorage: updateExperimentalForStorage,
    failed({ error }) {
      addErrorEvent({ source: 'image-generation-execution-settings', message: error instanceof Error ? error.message : String(error) });
    },
  });
  const nativePreferences = useImagePreferences({
    suspended: preparingRequests,
    settings,
    initialized,
    captureStorage: captureExperimentalStorage,
    updateForStorage: updateExperimentalForStorage,
    form,
    seedMode,
    historyEnabled: historySaving.enabled,
    library,
    localModels: computed(() => !remote.value),
    restoring: preferenceRestoring,
    restored({ missing, missingInactive }) {
      preferenceFilesMissing = missing.length > 0 || missingInactive.length > 0;
      historyActions.missingFiles.value = missing;
      historyActions.missingInactiveFiles.value = missingInactive;
    },
    failed({ error }) {
      const message = error instanceof Error ? error.message : String(error);
      // Settings failures use the shared error event surface; they must not
      // leave an unrelated history action in an error state after retry.
      addErrorEvent({ source: 'browser-image-generation-settings', message });
    },
  });
  const refreshLocalModels = (): void => {
    if (!preferenceRestoring.value && !remote.value) {
      void library.refresh();
    }
  };
  const refreshLocalAccess = (): void => {
    if (!preferenceRestoring.value && !remote.value) {
      void library.refreshAccess();
    }
  };
  onMounted(() => {
    refreshLocalModels();
    window.addEventListener('focus', refreshLocalAccess);
  });
  onUnmounted(() => {
    window.removeEventListener('focus', refreshLocalAccess);
    disposed = true;
    engineState.dispose();
    manualInspection?.abort();
    preparationController?.abort();
    controller.value?.abort();
    client?.dispose();
    unsubscribeStorage();
    unsubscribePendingHistory();
    void history.dispose();
    pendingSaves.clear();
    savedHistoryIds.value.clear();
    modelResident.value = false;
    finalGallery.clear();
    clearPreviews();
  });
  return { ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}), ...form, resolvedVaeTileSize, inferenceLocation, captureDraft, restoreDraft, resetDraft, draftRestoreDisabled: computed(() => draftRestoreDisabled.value || preparingRequests.value || preparingOne.value), engineState: engineState.view, seedMode, randomizeSeed, history, historySaving, historyActions, reuseHistory, useHistoryImage, savedHistoryId, downloadHistory, downloadResult, downloadPreview, clearHistoryMissingFiles, acquireBenchmark, releaseBenchmark, library, busy: computed(() => busy.value || preparingRequests.value || preparingOne.value), supported, formDisabled: computed(() => formDisabled.value || preparingRequests.value || preparingOne.value), draftDisabled: computed(() => draftDisabled.value || preparingRequests.value || preparingOne.value), unavailable, recommendation, manualInspectionState, inspectManualFiles, applyRecommendedSettings, chooseFile, resetFiles, removeResult, clearResults, removePreview, clearPreviews, releaseModel, setRetainModel, prepareRequests, generate, cancel, forceCancel, copyDiagnostics, saveDiagnostics };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
