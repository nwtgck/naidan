import { createDisabledImageLibrary } from './library-standalone';
import { computed, ref, shallowRef } from 'vue';
import { lazyStrings } from '@/strings';
import { createImageForm } from './form';
import type { ImageGenerationView } from './use-image-generation-types';

/** UI-only facade: no configuration load, Wasm probes, files, workers or requests. */
export function useImageGeneration(): ImageGenerationView {
  const form = createImageForm({ profile: 'webgpu-wasm32-asyncify' });
  return {
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
    ...form,
    seedMode: ref('random'), randomizeSeed() {},
    history: { available: ref(false), items: shallowRef([]), total: ref(0), loading: ref(false), error: ref(''), warnings: shallowRef([]), warningCount: ref(0), selected: shallowRef(), detailLoading: ref(false), detailError: ref(''),
      setQuery() {}, async reload() {}, async loadMore() {}, async select() {}, async remove() {}, async getImage() {
        return undefined;
      }, clearSelection() {}, dispose() {} },
    historySaving: { enabled: ref(true), supported: computed(() => false), status: ref('idle'), error: ref(''), pendingCount: ref(0), async retry() {} },
    historyActions: { busy: ref(false), error: ref(''), missingFiles: ref([]), missingInactiveFiles: ref([]) },
    async reuseHistory() {}, async useHistoryImage() {},
    savedHistoryId: () => undefined,
    async downloadHistory() {
      return { status: 'cancelled' };
    },
    async downloadResult() {
      return { status: 'cancelled' };
    },
    async downloadPreview() {
      return { status: 'cancelled' };
    },
    clearHistoryMissingFiles() {},
    acquireBenchmark: () => false, releaseBenchmark() {},
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
