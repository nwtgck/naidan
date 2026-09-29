import { createDisabledImageLibrary } from './library-standalone';
import { computed, ref } from 'vue';
import { lazyStrings } from '@/strings';
import { createImageForm } from './form';
import type { ImageGenerationView } from './use-image-generation-types';

/** UI-only facade: no configuration load, Wasm probes, files, workers or requests. */
export function useImageGeneration(): ImageGenerationView {
  const form = createImageForm({ profile: 'webgpu-wasm32-asyncify' });
  return {
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
    ...form,
    library: createDisabledImageLibrary(),
    busy: computed(() => false),
    supported: computed(() => false),
    formDisabled: computed(() => true),
    unavailable: computed(() => lazyStrings.stableDiffusionCppBrowser__hosted_build_required()),
    recommendation: computed(() => undefined),
    manualInspectionState: ref('idle'), async inspectManualFiles() {},
    applyRecommendedSettings() {},
    chooseFile() {},
    resetFiles() {},
    removeResult() {},
    async generate() {},
    cancel() {}, forceCancel() {}, releaseModel() {}, clearResults() {}, removePreview() {}, clearPreviews() {}, async copyDiagnostics() {}, saveDiagnostics() {},
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
