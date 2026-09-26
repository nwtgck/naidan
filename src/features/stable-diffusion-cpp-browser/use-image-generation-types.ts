import type { ImageLibraryView } from './library-view';
import type { ComputedRef } from 'vue';
import type { createImageForm } from './form';
import type { ModelSlot } from './types';

export type ImageGenerationView = ReturnType<typeof createImageForm> & {
  library: ImageLibraryView;
  busy: ComputedRef<boolean>;
  supported: ComputedRef<boolean>;
  formDisabled: ComputedRef<boolean>;
  unavailable: ComputedRef<string | undefined>;
  chooseFile({ slot, event }: { slot: ModelSlot, event: Event }): void;
  resetFiles(): void;
  removeResult({ resultId }: { resultId: number }): void;
  generate(): Promise<void>;
  cancel(): void;
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
