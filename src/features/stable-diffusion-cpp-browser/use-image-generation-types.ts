import type { ComputedRef } from 'vue';
import type { createImageForm } from './form';
import type { ModelSlot } from './types';

export type ImageGenerationView = ReturnType<typeof createImageForm> & {
  busy: ComputedRef<boolean>;
  supported: ComputedRef<boolean>;
  formDisabled: ComputedRef<boolean>;
  unavailable: ComputedRef<string | undefined>;
  chooseFile({ slot, event }: { slot: ModelSlot, event: Event }): void;
  resetFiles(): void;
  removeResult({ resultId }: { resultId: number }): void;
  generate(): Promise<void>;
  cancel(): void;
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
