import { nanoid } from 'nanoid';
import { createImageDiagnosticBuffer, type ImageDiagnostic } from './diagnostics';
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { lazyStrings, ensureStrings } from '@/strings';
import rawConfiguration from 'virtual:stable-diffusion-cpp-browser/config';
import { configurationSchema, parametersSchema, requestSchema, previewSettingsSchema, type Parameters, type PreviewFrame, type ModelSlot, type Request } from './types';
import type { ImageReleaseReason } from '@/features/stable-diffusion-cpp-browser/worker/types';
import { createImageClient } from '@/features/stable-diffusion-cpp-browser/worker/client';
import { initialProfile, supportsJspi, supportsMemory64 } from './capabilities';
import { useImageLibrary } from './use-image-library';
import { createImageGallery } from './image-gallery';
import { createImageForm } from './form';
import { useImagePreferences } from './use-image-preferences';
import { useSettings } from '@/composables/useSettings';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { imageLoraRequests, imageLoraHistorySelections } from './lora-form';
import { emptyImageInputs } from './image-input-form';
import { inspectImageInventory } from './inventory-worker/client';
import type { ImageModelFacts } from './recommendations';
import { recommendationForSelection } from './recommendations';
import type { ImageGenerationView, ImageDownloadFormat, ImageDownloadResult } from './use-image-generation-types';
import { storageService } from '@/00-storage/service';
import type { StorageType } from '@/01-models/types';
import type { BinaryObjectId, ImageGenerationId } from '@/01-models/ids';
import type { ImageGenerationRecord } from '@/01-models/image-generation-history';
import { useImageGenerationHistory } from './history/use-image-generation-history';
import { snapshotImageGeneration, finishImageGenerationSnapshot } from './history/snapshot';
import { prepareImageHistoryReuse } from './history/reuse';
import { downloadImageBlob, imageGenerationDownloadBlob, type ImageGenerationExportImage } from './history/download';

/** Hosted policy and lifecycle. The standalone facade never imports this module. */
export function useImageGeneration(): ImageGenerationView {
  const configuration = configurationSchema.parse(rawConfiguration);
  const form = createImageForm({ profile: initialProfile() });
  const { retainModel, modelResident, preview, keepPreviews, maxPreviews, maxResults, previewError, livePreview, previewSnapshots, debug, diagnosticText, diagnosticStatus, diagnosticFeedback, profile, layout, files, parameters, weightResidency, gpuBudgetMiB, progress, failure, invalid, cancelled, stopping, results } = form;
  const controller = shallowRef<AbortController>();
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
      void storageRevision.value; return currentStorageType() === 'opfs';
    }),
    status: ref('idle'), error: ref(''), pendingCount: ref(0), retry: retryHistorySave,
  };
  const unsubscribeStorage = storageService.subscribeToChanges({ listener: ({ event }) => {
    switch (event.type) {
    case 'migration':
      storageRevision.value++;
      historySaving.status.value = 'idle';
      historySaving.error.value = '';
      break;
    case 'chat_meta_and_chat_group': case 'chat_content': case 'chat_content_generation': case 'settings': case 'binary_objects': break;
    default: { const exhaustive: never = event; throw new Error(String(exhaustive)); }
    }
  } });
  const pendingSaves = new Map<number, ReturnType<typeof finishImageGenerationSnapshot>>();
  const savedHistoryIds = ref(new Map<number, ImageGenerationId>());
  let activeHistoryId: ImageGenerationId | undefined;
  let historySaveRunning = false;
  let restoredModels: Request['models'] | undefined;
  let preferenceFilesMissing = false;
  const diagnosticBuffer = createImageDiagnosticBuffer();
  const manualFacts = shallowRef<ImageModelFacts>();
  const manualInspectionState = ref<'idle' | 'scanning' | 'failed'>('idle');
  let manualInspection: AbortController | undefined;
  function recordDiagnostic({ diagnostic }: { diagnostic: ImageDiagnostic }): void {
    if (disposed) return;
    diagnosticBuffer.append({ diagnostic }); diagnosticText.value = diagnosticBuffer.text();
    switch (diagnostic.event) {
    case 'waiting': diagnosticStatus.value = `${diagnostic.stage} · ${(diagnostic.elapsedMs / 1000).toFixed(0)} s · Worker silence ${(Number(diagnostic.fields.workerSilentMs) / 1000).toFixed(0)} s`; break;
    case 'start': case 'complete': case 'failed': case 'cancelled': case 'progress':
      diagnosticStatus.value = `${diagnostic.stage} · ${diagnostic.event} · ${(diagnostic.elapsedMs / 1000).toFixed(1)} s`; break;
    case 'request': case 'native': case 'file-summary': case 'file-read': case 'gpu': case 'dropped': break;
    default: { const exhaustive: never = diagnostic.event; throw new Error(String(exhaustive)); }
    }
  }
  async function copyDiagnostics(): Promise<void> {
    try {
      await navigator.clipboard.writeText(diagnosticText.value); diagnosticFeedback.value = await ensureStrings.stableDiffusionCppBrowser__logs_copied();
    } catch {
      diagnosticFeedback.value = await ensureStrings.stableDiffusionCppBrowser__logs_copy_failed();
    }
  }
  function saveDiagnostics(): void {
    const filename = `naidan-image-diagnostics-${nanoid()}.jsonl`;
    const url = URL.createObjectURL(new Blob([diagnosticText.value], { type: 'text/plain;charset=utf-8' }));
    try {
      const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }
  const finalGallery = createImageGallery<{ parameters: Parameters, modelVersion: string, uniformOutput: boolean, elapsedMs: number, request: ImageGenerationRecord['request'], image: ImageGenerationExportImage }>({ initialLimit: 20, maxBytes: 256 * 1024 ** 2 });
  const liveGallery = createImageGallery<Omit<PreviewFrame, 'png'> & { elapsedMs: number }>({ initialLimit: 1, maxBytes: 64 * 1024 ** 2 });
  const snapshotGallery = createImageGallery<Omit<PreviewFrame, 'png'> & { elapsedMs: number, request: ImageGenerationRecord['request'] }>({ initialLimit: 16, maxBytes: 64 * 1024 ** 2 });
  let disposed = false;
  let client: ReturnType<typeof createImageClient> | undefined;
  let generateStartedAt = 0;
  const now = (): number => globalThis.performance?.now() ?? Date.now();
  const busy = computed(() => controller.value !== undefined);
  const formDisabled = computed(() => preferenceRestoring.value || busy.value || benchmarkActive.value || historyActions.busy.value || historySaving.status.value === 'saving' || configuration.kind === 'unavailable');
  const library = useImageLibrary({ downloadsBlocked: () => configuration.kind === 'unavailable', blocked: () => formDisabled.value, dependencies: undefined,
    onSelection({ family, turbo }) {
      // Preserve established selection-time helpers for recognized models. The
      // Turbo bit now requires header metadata or reviewed receipt evidence.
      // The explicit preset action remains the only full-parameter reset.
      switch (family) {
      case 'z-image':
        if (turbo) {
          parameters.value.guidance = 1; parameters.value.steps = 8;
        }
        break;
      case 'qwen-image-2.1':
        parameters.value.guidance = 6;
        if (!parameters.value.modelArguments) parameters.value.modelArguments = 'qwen_image_2_1_prefix_cache=false';
        break;
      case 'sd-checkpoint': case 'flux1': case 'flux2-klein-4b': case 'anima': case 'krea2': case 'ernie-image': case 'unknown': break;
      default: { const exhaustive: never = family; throw new Error(String(exhaustive)); }
      }
    },
  });
  const recommendation = computed(() => recommendationForSelection({ model: library.main.value ? library.selectedFacts.value : manualFacts.value }));
  // Adapters and input images belong to the selected base model; do not carry
  // them silently to another model with a different conditioning contract.
  watch([library.main, layout, () => files.value.model, () => files.value.diffusion], () => {
    restoredModels = undefined;
    if (preferenceFilesMissing && !preferenceRestoring.value && (library.selectedFacts.value || files.value.model || files.value.diffusion)) clearHistoryMissingFiles();
    form.loras.value = [];
    form.imageInputs.value = emptyImageInputs();
  }, { flush: 'sync' });
  async function inspectManualFiles(): Promise<void> {
    if (formDisabled.value || disposed) return;
    manualInspection?.abort(); manualFacts.value = undefined; manualInspectionState.value = 'idle';
    const slot = (() => {
      switch (layout.value) {
      case 'checkpoint': return 'model' as const;
      case 'components': return 'diffusion' as const;
      default: { const exhaustive: never = layout.value; throw new Error(String(exhaustive)); }
      }
    })();
    const file = files.value[slot]; if (!file) return;
    const controller = new AbortController(); manualInspection = controller; manualInspectionState.value = 'scanning';
    try {
      const next = await inspectImageInventory({ signal: controller.signal, onProgress() {},
        repositories: [{ id: 'manual', name: 'manual', files: [{ path: file.name, file }] }] });
      if (!disposed && manualInspection === controller && !controller.signal.aborted) {
        const candidate = next.candidates.find(item => item.roles.includes(slot) && !item.issue);
        manualFacts.value = candidate ? { family: candidate.family, variant: candidate.variant, evidence: candidate.evidence } : undefined;
        manualInspectionState.value = 'idle';
      }
    } catch {
      if (!disposed && manualInspection === controller && !controller.signal.aborted) manualInspectionState.value = 'failed';
    } finally {
      if (manualInspection === controller) manualInspection = undefined;
    }
  }
  function applyRecommendedSettings(): void {
    const preset = recommendation.value;
    if (!preset || formDisabled.value || library.importing.value) return;
    // Resolution belongs to the composition the user chose. Applying a model
    // preset changes sampling settings without resizing that composition.
    const { width: _width, height: _height, ...settings } = preset.parameters;
    parameters.value = { ...parameters.value, ...settings };
    preview.value = { ...preview.value, ...preset.preview };
  }
  function randomSeed(): string {
    return String(Math.max(1, crypto.getRandomValues(new Uint32Array(1))[0] ?? 1));
  }
  function randomizeSeed(): void {
    if (formDisabled.value || disposed) return;
    parameters.value.seed = randomSeed();
    seedMode.value = 'fixed';
  }
  const artifact = computed(() => {
    switch (configuration.kind) {
    case 'available': return configuration.artifacts.find(item => item.profile === profile.value);
    case 'unavailable': return undefined;
    default: { const exhaustive: never = configuration; throw new Error(String(exhaustive)); }
    }
  });
  const unavailable = computed(() => {
    switch (configuration.kind) {
    case 'unavailable': {
      switch (configuration.reason) {
      case 'standalone': return lazyStrings.stableDiffusionCppBrowser__hosted_build_required();
      case 'not-installed': return lazyStrings.stableDiffusionCppBrowser__artifact_not_installed();
      default: { const exhaustive: never = configuration.reason; throw new Error(String(exhaustive)); }
      }
    }
    case 'available':
      if (!globalThis.isSecureContext || !('gpu' in navigator) || typeof DecompressionStream === 'undefined' || typeof OffscreenCanvas === 'undefined') return lazyStrings.stableDiffusionCppBrowser__webgpu_required();
      if (profile.value.endsWith('jspi') && !supportsJspi()) return lazyStrings.stableDiffusionCppBrowser__jspi_unavailable();
      if (profile.value === 'webgpu-wasm64-jspi' && !supportsMemory64()) return lazyStrings.stableDiffusionCppBrowser__memory64_unavailable();
      return undefined;
    default: { const exhaustive: never = configuration; throw new Error(String(exhaustive)); }
    }
  });
  // Availability is not inferred from a lazily loaded translated string.
  const supported = computed(() => artifact.value !== undefined && globalThis.isSecureContext && 'gpu' in navigator && typeof DecompressionStream !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && (!profile.value.endsWith('jspi') || supportsJspi()) && (profile.value !== 'webgpu-wasm64-jspi' || supportsMemory64()));
  function chooseFile({ slot, event }: { slot: ModelSlot, event: Event }): void {
    if (formDisabled.value || library.importing.value || !(event.target instanceof HTMLInputElement)) return;
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
    if (formDisabled.value || library.importing.value || disposed) return;
    library.useManualFiles();
    restoredModels = undefined;
    manualFacts.value = undefined;
    manualInspection?.abort(); manualInspection = undefined; manualInspectionState.value = 'idle';
    files.value = {};
  }
  function releaseFor({ reason }: { reason: ImageReleaseReason }): void {
    client?.release({ reason }); modelResident.value = false;
  }
  function acquireBenchmark(): boolean {
    if (disposed || benchmarkActive.value || busy.value || formDisabled.value || !supported.value || library.importing.value || library.scanState.value === 'scanning') return false;
    benchmarkActive.value = true;
    manualInspection?.abort(); manualInspection = undefined; manualInspectionState.value = 'idle';
    library.cancelScan();
    releaseModel();
    return true;
  }
  function releaseBenchmark(): void {
    benchmarkActive.value = false;
  }
  function releaseModel(): void {
    releaseFor({ reason: 'explicit-release' });
  }
  function removeResult({ resultId }: { resultId: number }): void {
    finalGallery.remove({ id: resultId }); results.value = finalGallery.entries();
    prunePendingHistory();
  }
  function clearResults(): void {
    finalGallery.clear(); results.value = [];
    prunePendingHistory();
  }
  function prunePendingHistory(): void {
    const retained = new Set(finalGallery.entries().map(entry => entry.id));
    for (const id of pendingSaves.keys()) if (!retained.has(id)) pendingSaves.delete(id);
    for (const id of savedHistoryIds.value.keys()) if (!retained.has(id)) savedHistoryIds.value.delete(id);
    historySaving.pendingCount.value = pendingSaves.size;
    clearDiscardedHistoryStatus();
  }
  function clearDiscardedHistoryStatus(): void {
    if (historySaving.status.value !== 'failed' && historySaving.status.value !== 'saved') return;
    const stillRetained = [...pendingSaves.values()].some(saving => saving.record.id === activeHistoryId)
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
    for (const [resultId, historyId] of savedHistoryIds.value) if (historyId === id) savedHistoryIds.value.delete(resultId);
    clearDiscardedHistoryStatus();
  }
  function removePreview({ previewId }: { previewId: number }): void {
    snapshotGallery.remove({ id: previewId }); previewSnapshots.value = snapshotGallery.entries();
  }
  function clearPreviews(): void {
    liveGallery.clear(); snapshotGallery.clear(); livePreview.value = undefined; previewSnapshots.value = [];
  }
  watch(maxResults, value => {
    finalGallery.setLimit({ value }); results.value = finalGallery.entries();
    prunePendingHistory();
  });
  watch(maxPreviews, value => {
    snapshotGallery.setLimit({ value }); previewSnapshots.value = snapshotGallery.entries();
  });
  let lastValidPreview = { ...preview.value };
  watch(preview, settings => {
    const parsed = previewSettingsSchema.safeParse(settings);
    previewError.value = parsed.success ? '' : 'invalid';
    if (parsed.success) {
      lastValidPreview = parsed.data;
      if (busy.value) client?.updatePreview({ settings: parsed.data });
    } else if (!settings.enabled && busy.value) {
      // Turning capture OFF must work even while an interval input is empty.
      client?.updatePreview({ settings: { ...lastValidPreview, enabled: false } });
    }
  }, { deep: true, flush: 'sync' });
  watch(retainModel, value => {
    if (!value && !busy.value) releaseFor({ reason: 'retention-disabled' });
  });
  // IDs stay stable across a local refresh. File content/publication identity is
  // checked again by the client at the next explicit generation.
  watch(() => JSON.stringify([library.main.value, library.components.value.map(item => item.selected), profile.value,
    weightResidency.value, gpuBudgetMiB.value, parameters.value.flashAttention, parameters.value.conditioningCacheSize,
    parameters.value.modelArguments, parameters.value.bf16WeightType, debug.value]), () => {
    if (!busy.value) releaseFor({ reason: 'view-settings-changed' });
  });
  watch(files, () => {
    if (!busy.value) releaseFor({ reason: 'view-settings-changed' });
  });
  async function retryHistorySave(): Promise<void> {
    if (!pendingSaves.size || historySaveRunning || !historySaving.supported.value || disposed) return;
    historySaveRunning = true;
    historyActions.error.value = '';
    const revision = storageRevision.value;
    let currentStatus = historySaving.status.value;
    let currentError = historySaving.error.value;
    historySaving.status.value = 'saving';
    try {
      for (const [resultId, saving] of pendingSaves) {
        if (disposed || currentStorageType() !== 'opfs') break;
        try {
          await storageService.saveImageGeneration(saving);
          if (pendingSaves.get(resultId) !== saving) continue;
          pendingSaves.delete(resultId);
          savedHistoryIds.value.set(resultId, saving.record.id);
          if (saving.record.id === activeHistoryId) {
            currentStatus = 'saved'; currentError = '';
          }
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          if (saving.record.id === activeHistoryId) {
            currentStatus = 'failed'; currentError = message;
          } else historyActions.error.value = message;
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
  async function reuseHistory({ record }: { record: ImageGenerationRecord }): Promise<void> {
    if (formDisabled.value || library.importing.value || disposed) return;
    historyActions.busy.value = true;
    historyActions.error.value = '';
    const revision = storageRevision.value;
    try {
      await library.prepareHistoryFiles();
      if (disposed || revision !== storageRevision.value) return;
      const restored = await prepareImageHistoryReuse({ record, findFile: library.findHistoryFile, getImage: history.getImage });
      if (disposed || revision !== storageRevision.value) return;
      // All reads/validation finish before changing the editor. Missing weights
      // are an explicit re-selection state, never a fallback to another model.
      historyActions.busy.value = false;
      library.useManualFiles();
      layout.value = restored.models.some(model => model.slot === 'diffusion') ? 'components' : 'checkpoint';
      files.value = Object.fromEntries(restored.models.map(model => [model.slot, model.file]));
      parameters.value = restored.parameters;
      seedMode.value = 'fixed';
      preview.value = restored.preview;
      profile.value = record.request.runtime.profile;
      weightResidency.value = record.request.runtime.weightResidency;
      gpuBudgetMiB.value = record.request.runtime.gpuBudgetMiB ?? '';
      form.loras.value = restored.loras;
      form.imageInputs.value = restored.imageInputs;
      restoredModels = restored.models.length ? restored.models : undefined;
      preferenceFilesMissing = false;
      historyActions.missingFiles.value = restored.missing;
      historyActions.missingInactiveFiles.value = restored.missingInactive;
      invalid.value = false;
      failure.value = '';
      manualFacts.value = undefined;
    } catch (cause) {
      if (!disposed && revision === storageRevision.value) historyActions.error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      historyActions.busy.value = false;
    }
  }
  async function useHistoryImage({ binaryObjectId, role }: { binaryObjectId: BinaryObjectId, role: 'initial' | 'reference' }): Promise<void> {
    if (formDisabled.value || library.importing.value || disposed) return;
    historyActions.error.value = '';
    historyActions.busy.value = true;
    const revision = storageRevision.value;
    try {
      const blob = await history.getImage({ binaryObjectId });
      if (disposed || revision !== storageRevision.value) return;
      if (!blob) throw new Error('The saved image is missing');
      const file = new File([blob], 'history-image.png', { type: blob.type });
      switch (role) {
      case 'initial': form.imageInputs.value = { ...form.imageInputs.value, initImage: file }; break;
      case 'reference': form.imageInputs.value = { ...form.imageInputs.value, referenceImages: [...form.imageInputs.value.referenceImages, file] }; break;
      default: { const exhaustive: never = role; throw new Error(String(exhaustive)); }
      }
    } catch (cause) {
      if (!disposed && revision === storageRevision.value) historyActions.error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      historyActions.busy.value = false;
    }
  }
  async function downloadHistory({ binaryObjectId, record, format, includeMetadata }: { binaryObjectId: BinaryObjectId, record: ImageGenerationRecord, format: ImageDownloadFormat, includeMetadata: boolean }): Promise<ImageDownloadResult> {
    if (disposed) return { status: 'cancelled' };
    try {
      const frame = record.previews.find(frame => frame.binaryObjectId === binaryObjectId);
      const output: ImageGenerationExportImage = (() => {
        if (record.result.binaryObjectId === binaryObjectId) return { kind: 'final', width: record.result.width, height: record.result.height };
        if (frame) return { kind: 'preview', width: frame.width, height: frame.height, step: frame.step, steps: frame.steps, mode: frame.mode };
        throw new Error('This image does not belong to the selected generation');
      })();
      const image = await history.getImage({ binaryObjectId });
      if (!image) throw new Error('The saved image is missing');
      const blob = await imageGenerationDownloadBlob({ png: image, request: record.request, image: output, format, includeMetadata });
      if (disposed) return { status: 'cancelled' };
      downloadImageBlob({ blob, filename: `naidan-generated-image.${format}` });
      return { status: 'downloaded' };
    } catch (cause) {
      return downloadFailed({ cause });
    }
  }
  async function downloadResult({ resultId, format, includeMetadata }: { resultId: number, format: ImageDownloadFormat, includeMetadata: boolean }): Promise<ImageDownloadResult> {
    if (disposed) return { status: 'cancelled' };
    try {
      const result = finalGallery.entries().find(result => result.id === resultId);
      const image = finalGallery.getBlob({ id: resultId });
      if (!result || !image) throw new Error('The generated image is no longer available');
      const blob = await imageGenerationDownloadBlob({ png: image, request: result.request, image: result.image, format, includeMetadata });
      if (disposed) return { status: 'cancelled' };
      downloadImageBlob({ blob, filename: `naidan-generated-image.${format}` });
      return { status: 'downloaded' };
    } catch (cause) {
      return downloadFailed({ cause });
    }
  }
  async function downloadPreview({ previewId, format, includeMetadata }: { previewId: number, format: ImageDownloadFormat, includeMetadata: boolean }): Promise<ImageDownloadResult> {
    if (disposed) return { status: 'cancelled' };
    try {
      const preview = snapshotGallery.entries().find(preview => preview.id === previewId);
      const png = snapshotGallery.getBlob({ id: previewId });
      if (!preview || !png) throw new Error('The preview image is no longer available');
      const image: ImageGenerationExportImage = { kind: 'preview', width: preview.width, height: preview.height, step: preview.step, steps: preview.steps, mode: preview.mode };
      const blob = await imageGenerationDownloadBlob({ png, request: preview.request, image, format, includeMetadata });
      if (disposed) return { status: 'cancelled' };
      downloadImageBlob({ blob, filename: `naidan-image-preview.${format}` });
      return { status: 'downloaded' };
    } catch (cause) {
      return downloadFailed({ cause });
    }
  }
  function downloadFailed({ cause }: { cause: unknown }): ImageDownloadResult {
    if (disposed) return { status: 'cancelled' };
    const message = cause instanceof Error ? cause.message : String(cause);
    // Each download menu owns its outcome. Do not clear or replace an unrelated
    // history/reuse error, or leave download errors visible on another pane.
    return { status: 'failed', message };
  }
  async function generate(): Promise<void> {
    if (!supported.value || !artifact.value || formDisabled.value || historyActions.missingFiles.value.length || library.importing.value || disposed) return;
    historySaving.status.value = 'idle';
    historySaving.error.value = '';
    activeHistoryId = undefined;
    invalid.value = false; failure.value = ''; cancelled.value = false; stopping.value = false;
    const selectedSlots: ModelSlot[] = (() => {
      switch (layout.value) {
      case 'checkpoint': return ['model'];
      case 'components': return ['diffusion', 'vae', 'clipL', 'clipG', 't5', 'lm'];
      default: { const exhaustive: never = layout.value; throw new Error(String(exhaustive)); }
      }
    })();
    const manualModels = selectedSlots.flatMap(slot => {
      const file = files.value[slot]; return file === undefined ? [] : [{ slot, file }];
    });
    const models = library.main.value ? library.selectedModels() : restoredModels ?? manualModels;
    if (!models) {
      invalid.value = true; return;
    }
    // Lab random mode resolves in the browser before the immutable request is
    // captured. Diagnostics keeps its separate seed/protocol unchanged.
    const seed = (() => {
      switch (seedMode.value) {
      case 'random': return randomSeed();
      case 'fixed': return parameters.value.seed;
      default: { const exhaustive: never = seedMode.value; throw new Error(String(exhaustive)); }
      }
    })();
    const requestedParameters = { ...parameters.value, seed };
    if (requestedParameters.seed === '-1') {
      invalid.value = true; return;
    }
    const parsed = requestSchema.safeParse({ debug: debug.value, artifact: artifact.value, baseUrl: new URL(import.meta.env.BASE_URL, window.location.href).href, models, loras: imageLoraRequests({ selections: form.loras.value }), imageInputs: form.imageInputs.value, parameters: requestedParameters, preview: preview.value, weightResidency: weightResidency.value, gpuBudgetMiB: gpuBudgetMiB.value === '' ? undefined : gpuBudgetMiB.value });
    if (!parsed.success) {
      invalid.value = true; return;
    }
    parameters.value.seed = parsed.data.parameters.seed;
    const sourceCommit = (() => {
      switch (configuration.kind) {
      case 'available': return configuration.sourceCommit;
      case 'unavailable': return '';
      default: { const exhaustive: never = configuration; throw new Error(String(exhaustive)); }
      }
    })();
    // Preserve disabled selections in history without making their files part
    // of request validation, Worker transport or native model loading.
    const snapshot = snapshotImageGeneration({ request: { ...parsed.data, loras: imageLoraHistorySelections({ selections: form.loras.value }) }, sourceCommit, locateFile: library.historyFileLocation, createdAt: Date.now() });
    activeHistoryId = snapshot.id;
    const saveThisGeneration = historySaving.enabled.value && historySaving.supported.value;
    const runPreviewIds = new Set<number>();
    diagnosticBuffer.clear(); diagnosticText.value = ''; diagnosticStatus.value = ''; diagnosticFeedback.value = '';
    liveGallery.clear(); livePreview.value = undefined;
    manualInspection?.abort(); manualInspection = undefined; manualInspectionState.value = 'idle';
    generateStartedAt = now();
    const runDimensions = { width: parsed.data.parameters.width, height: parsed.data.parameters.height };
    form.latestRun.value = { ...runDimensions, status: 'running' };
    const operation = new AbortController(); controller.value = operation;
    progress.value = { phase: 'runtime', step: 0, steps: 0 };
    let finalImageReceived = false;
    try {
      client ??= createImageClient({ onReleased: () => {
        modelResident.value = false;
      } });
      const result = await client.generate({ request: parsed.data, signal: operation.signal, onDiagnostic: recordDiagnostic, onProgress({ event }) {
        if (!disposed && !operation.signal.aborted) {
          progress.value = event;
          switch (event.phase) {
          case 'model': modelResident.value = false; break;
          case 'runtime': case 'sampling': case 'decoding': case 'encoding': break;
          default: { const exhaustive: never = event.phase; throw new Error(String(exhaustive)); }
          }
        }
      }, onPreview({ frame }) {
        if (disposed || operation.signal.aborted || stopping.value || !preview.value.enabled) return;
        const { png, ...metadata } = frame;
        const entry = { ...metadata, elapsedMs: Math.max(0, now() - generateStartedAt) };
        liveGallery.add({ blob: png, width: frame.width, height: frame.height, metadata: entry });
        livePreview.value = liveGallery.entries()[0];
        if (keepPreviews.value) {
          // Keep only serializable settings, not the run's model/input Files.
          const saved = snapshotGallery.add({ blob: png, width: frame.width, height: frame.height, metadata: { ...entry, request: snapshot.request } });
          runPreviewIds.add(saved.id);
          previewSnapshots.value = snapshotGallery.entries();
        }
      } });
      if (disposed) return;
      if (operation.signal.aborted) {
        cancelled.value = true;
        form.latestRun.value = { ...runDimensions, status: 'cancelled' };
        return;
      }
      // Inference stop controls cannot interrupt the subsequent OPFS save.
      // Keep the operation busy until saving settles, but end its progress now.
      progress.value = undefined; stopping.value = false;
      if ('cancelled' in result) {
        form.latestRun.value = { ...runDimensions, status: 'cancelled' };
        cancelled.value = true; modelResident.value = result.modelResident;
        if (!retainModel.value) releaseFor({ reason: 'retention-disabled' });
        return;
      }
      finalImageReceived = true;
      form.latestRun.value = { ...runDimensions, status: 'succeeded' };
      const finalEntry = finalGallery.add({ blob: result.png, width: result.width, height: result.height,
        metadata: { parameters: parametersSchema.parse(parsed.data.parameters), modelVersion: result.modelVersion, uniformOutput: result.uniformOutput ?? false, elapsedMs: Math.max(0, now() - generateStartedAt), request: snapshot.request, image: { kind: 'final', width: result.width, height: result.height } } });
      results.value = finalGallery.entries();
      prunePendingHistory();
      modelResident.value = true;
      if (!retainModel.value) releaseFor({ reason: 'retention-disabled' });
      if (saveThisGeneration && historySaving.supported.value) {
        const previews: PreviewFrame[] = snapshotGallery.entries().flatMap(entry => {
          if (!runPreviewIds.has(entry.id)) return [];
          const png = snapshotGallery.getBlob({ id: entry.id });
          const { id: _id, url: _url, elapsedMs: _elapsedMs, request: _request, ...frame } = entry;
          return png ? [{ ...frame, png }] : [];
        });
        pendingSaves.set(finalEntry.id, finishImageGenerationSnapshot({ snapshot, result, previews, elapsedMs: Math.max(0, now() - generateStartedAt) }));
        historySaving.pendingCount.value = pendingSaves.size;
        await retryHistorySave();
      }
    } catch (error) {
      releaseFor({ reason: 'failed' });
      if (!disposed) {
        if (operation.signal.aborted) {
          cancelled.value = true;
          if (!finalImageReceived) form.latestRun.value = { ...runDimensions, status: 'cancelled' };
        } else {
          failure.value = (error instanceof Error ? error.message : String(error)).slice(-32768);
          if (!finalImageReceived) form.latestRun.value = { ...runDimensions, status: 'failed', failure: failure.value };
        }
      }
    } finally {
      if (!disposed) {
        controller.value = undefined; progress.value = undefined; stopping.value = false;
      }
    }
  }
  function cancel(): void {
    if (!busy.value || !progress.value || stopping.value) return;
    stopping.value = true; client?.cancel();
  }
  function forceCancel(): void {
    if (!busy.value || !progress.value) return;
    controller.value?.abort();
  }
  const { settings, initialized, updateExperimental } = useSettings();
  const { addErrorEvent } = useGlobalEvents();
  useImagePreferences({ settings, initialized, updateExperimental, form, seedMode, historyEnabled: historySaving.enabled, library, restoring: preferenceRestoring,
    restored({ missing, missingInactive }) {
      preferenceFilesMissing = missing.length > 0 || missingInactive.length > 0;
      historyActions.missingFiles.value = missing; historyActions.missingInactiveFiles.value = missingInactive;
    },
    failed({ error }) {
      const message = error instanceof Error ? error.message : String(error);
      // Settings failures use the shared error event surface; they must not
      // leave an unrelated history action in an error state after retry.
      addErrorEvent({ source: 'browser-image-generation-settings', message });
    },
  });
  const refreshLocalModels = (): void => {
    if (!preferenceRestoring.value) void library.refresh();
  };
  onMounted(() => {
    refreshLocalModels(); window.addEventListener('focus', refreshLocalModels);
  });
  onUnmounted(() => {
    window.removeEventListener('focus', refreshLocalModels);
    disposed = true; manualInspection?.abort(); controller.value?.abort(); client?.dispose();
    unsubscribeStorage();
    void history.dispose();
    pendingSaves.clear();
    savedHistoryIds.value.clear();
    modelResident.value = false; finalGallery.clear(); clearPreviews();
  });
  return { ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}), ...form, seedMode, randomizeSeed, history, historySaving, historyActions, reuseHistory, useHistoryImage, savedHistoryId, downloadHistory, downloadResult, downloadPreview, clearHistoryMissingFiles, acquireBenchmark, releaseBenchmark, library, busy, supported, formDisabled, unavailable, recommendation, manualInspectionState, inspectManualFiles, applyRecommendedSettings, chooseFile, resetFiles, removeResult, clearResults, removePreview, clearPreviews, releaseModel, generate, cancel, forceCancel, copyDiagnostics, saveDiagnostics };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
