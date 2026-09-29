import type { ImageLibraryView } from './library-view';
import type { Ref, ComputedRef } from 'vue';
import type { createImageForm } from './form';
import type { ModelSlot } from './types';
import type { ImageGenerationRecommendation } from './recommendations';

export type ImageGenerationView = ReturnType<typeof createImageForm> & {
  library: ImageLibraryView;
  busy: ComputedRef<boolean>;
  supported: ComputedRef<boolean>;
  formDisabled: ComputedRef<boolean>;
  unavailable: ComputedRef<string | undefined>;
  recommendation: ComputedRef<ImageGenerationRecommendation | undefined>;
  manualInspectionState: Ref<'idle' | 'scanning' | 'failed'>;
  inspectManualFiles(): Promise<void>;
  applyRecommendedSettings(): void;
  chooseFile({ slot, event }: { slot: ModelSlot, event: Event }): void;
  resetFiles(): void;
  removeResult({ resultId }: { resultId: number }): void;
  generate(): Promise<void>;
  cancel(): void;
  forceCancel(): void;
  releaseModel(): void;
  clearResults(): void;
  removePreview({ previewId }: { previewId: number }): void;
  clearPreviews(): void;
  copyDiagnostics(): Promise<void>;
  saveDiagnostics(): void;
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
