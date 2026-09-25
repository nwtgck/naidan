import { createImageDiagnosticBuffer, type ImageDiagnostic } from './diagnostics';
import { computed, onMounted, onUnmounted, shallowRef } from 'vue';
import { lazyStrings, ensureStrings } from '@/strings';
import rawConfiguration from 'virtual:stable-diffusion-cpp-browser/config';
import { configurationSchema, parametersSchema, requestSchema, type ModelSlot } from './types';
import { createImageClient } from '@/features/stable-diffusion-cpp-browser/worker/client';
import { initialProfile, supportsJspi, supportsMemory64 } from './capabilities';
import { useImageLibrary } from './use-image-library';
import { createImageForm } from './form';
import type { ImageGenerationView } from './use-image-generation-types';

/** Hosted policy and lifecycle. The standalone facade never imports this module. */
export function useImageGeneration(): ImageGenerationView {
  const configuration = configurationSchema.parse(rawConfiguration);
  const form = createImageForm({ profile: initialProfile() });
  const { debug, diagnosticText, diagnosticStatus, diagnosticFeedback, profile, layout, files, parameters, weightResidency, gpuBudgetMiB, progress, failure, invalid, cancelled, results } = form;
  const controller = shallowRef<AbortController>();
  const diagnosticBuffer = createImageDiagnosticBuffer();
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
    const url = URL.createObjectURL(new Blob([diagnosticText.value], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'naidan-image-diagnostics.jsonl'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  let nextId = 0;
  let disposed = false;
  let client: ReturnType<typeof createImageClient> | undefined;
  const busy = computed(() => controller.value !== undefined);
  const formDisabled = computed(() => busy.value || configuration.kind === 'unavailable');
  const library = useImageLibrary({ blocked: () => formDisabled.value, dependencies: undefined,
    onSelection({ family, turbo }) {
      // Application recommendations, not core defaults or model compatibility claims.
      switch (family) {
      case 'z-image':
        parameters.value.guidance = turbo ? 1 : 5;
        if (turbo) parameters.value.steps = 8;
        break;
      case 'qwen-image-2.1':
        parameters.value.guidance = 6;
        if (!parameters.value.modelArguments) parameters.value.modelArguments = 'qwen_image_2_1_prefix_cache=false';
        break;
      case 'sd-checkpoint': case 'flux1': case 'unknown': break;
      default: { const exhaustive: never = family; throw new Error(String(exhaustive)); }
      }
    },
  });
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
    if (formDisabled.value || library.importing.value || library.downloading.value || !(event.target instanceof HTMLInputElement)) return;
    library.useManualFiles();
    const file = event.target.files?.[0];
    files.value = { ...files.value, [slot]: file };
  }
  function resetFiles(): void {
    if (formDisabled.value || library.importing.value || library.downloading.value || disposed) return;
    library.useManualFiles();
    files.value = {};
  }
  function removeResult({ resultId }: { resultId: number }): void {
    const result = results.value.find(item => item.id === resultId);
    if (result) URL.revokeObjectURL(result.url);
    results.value = results.value.filter(item => item.id !== resultId);
  }
  async function generate(): Promise<void> {
    if (!supported.value || !artifact.value || busy.value || library.importing.value || library.downloading.value || disposed) return;
    invalid.value = false; failure.value = ''; cancelled.value = false;
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
    const models = library.main.value ? library.selectedModels() : manualModels;
    if (!models) {
      invalid.value = true; return;
    }
    const parsed = requestSchema.safeParse({ debug: debug.value, artifact: artifact.value, baseUrl: new URL(import.meta.env.BASE_URL, window.location.href).href, models, parameters: parameters.value, weightResidency: weightResidency.value, gpuBudgetMiB: gpuBudgetMiB.value === '' ? undefined : gpuBudgetMiB.value });
    if (!parsed.success) {
      invalid.value = true; return;
    }
    diagnosticBuffer.clear(); diagnosticText.value = ''; diagnosticStatus.value = ''; diagnosticFeedback.value = '';
    const operation = new AbortController(); controller.value = operation;
    progress.value = { phase: 'runtime', step: 0, steps: 0 };
    try {
      client = createImageClient();
      const result = await client.generate({ request: parsed.data, signal: operation.signal, onDiagnostic: recordDiagnostic, onProgress({ event }) {
        if (!disposed && !operation.signal.aborted) progress.value = event;
      } });
      if (disposed || operation.signal.aborted) return;
      const image = { url: URL.createObjectURL(result.png), parameters: parametersSchema.parse(parsed.data.parameters), modelVersion: result.modelVersion, id: ++nextId };
      results.value = [image, ...results.value];
      while (results.value.length > 4) {
        const last = results.value.at(-1); if (last) removeResult({ resultId: last.id });
      }
    } catch (error) {
      if (!disposed) {
        if (operation.signal.aborted) cancelled.value = true;
        else failure.value = (error instanceof Error ? error.message : String(error)).slice(-32768);
      }
    } finally {
      client?.dispose(); client = undefined;
      if (!disposed) {
        controller.value = undefined; progress.value = undefined;
      }
    }
  }
  function cancel(): void {
    controller.value?.abort();
  }
  const refreshLocalModels = (): void => {
    void library.refresh();
  };
  onMounted(() => {
    refreshLocalModels(); window.addEventListener('focus', refreshLocalModels);
  });
  onUnmounted(() => {
    window.removeEventListener('focus', refreshLocalModels);
    disposed = true; controller.value?.abort(); client?.dispose();
    for (const result of results.value) URL.revokeObjectURL(result.url);
  });
  return { ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}), ...form, library, busy, supported, formDisabled, unavailable, chooseFile, resetFiles, removeResult, generate, cancel, copyDiagnostics, saveDiagnostics };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
