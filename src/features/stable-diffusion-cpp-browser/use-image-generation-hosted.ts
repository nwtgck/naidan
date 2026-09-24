import { computed, onUnmounted, shallowRef } from 'vue';
import { lazyStrings } from '@/strings';
import rawConfiguration from 'virtual:stable-diffusion-cpp-browser/config';
import { configurationSchema, parametersSchema, requestSchema, type ModelSlot } from './types';
import { createImageClient } from '@/features/stable-diffusion-cpp-browser/worker/client';
import { initialProfile, supportsJspi, supportsMemory64 } from './capabilities';
import { createImageForm } from './form';
import type { ImageGenerationView } from './use-image-generation-types';

/** Hosted policy and lifecycle. The standalone facade never imports this module. */
export function useImageGeneration(): ImageGenerationView {
  const configuration = configurationSchema.parse(rawConfiguration);
  const form = createImageForm({ profile: initialProfile() });
  const { profile, layout, files, parameters, gpuBudgetMiB, progress, failure, invalid, cancelled, results } = form;
  const controller = shallowRef<AbortController>();
  let nextId = 0;
  let disposed = false;
  let client: ReturnType<typeof createImageClient> | undefined;
  const busy = computed(() => controller.value !== undefined);
  const formDisabled = computed(() => busy.value || configuration.kind === 'unavailable');
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
    if (formDisabled.value || !(event.target instanceof HTMLInputElement)) return;
    const file = event.target.files?.[0];
    files.value = { ...files.value, [slot]: file };
  }
  function resetFiles(): void {
    files.value = {};
  }
  function removeResult({ resultId }: { resultId: number }): void {
    const result = results.value.find(item => item.id === resultId);
    if (result) URL.revokeObjectURL(result.url);
    results.value = results.value.filter(item => item.id !== resultId);
  }
  async function generate(): Promise<void> {
    if (!supported.value || !artifact.value || busy.value || disposed) return;
    invalid.value = false; failure.value = ''; cancelled.value = false;
    const selectedSlots: ModelSlot[] = (() => {
      switch (layout.value) {
      case 'checkpoint': return ['model'];
      case 'components': return ['diffusion', 'vae', 'clipL', 'clipG', 't5', 'lm'];
      default: { const exhaustive: never = layout.value; throw new Error(String(exhaustive)); }
      }
    })();
    const models = selectedSlots.flatMap(slot => {
      const file = files.value[slot]; return file === undefined ? [] : [{ slot, file }];
    });
    const parsed = requestSchema.safeParse({ artifact: artifact.value, baseUrl: new URL(import.meta.env.BASE_URL, window.location.href).href, models, parameters: parameters.value, gpuBudgetMiB: gpuBudgetMiB.value });
    if (!parsed.success) {
      invalid.value = true; return;
    }
    const operation = new AbortController(); controller.value = operation;
    progress.value = { phase: 'runtime', step: 0, steps: 0 };
    try {
      client = createImageClient();
      const result = await client.generate({ request: parsed.data, signal: operation.signal, onProgress({ event }) {
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
  onUnmounted(() => {
    disposed = true; controller.value?.abort(); client?.dispose();
    for (const result of results.value) URL.revokeObjectURL(result.url);
  });
  return { ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}), ...form, busy, supported, formDisabled, unavailable, chooseFile, resetFiles, removeResult, generate, cancel };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
