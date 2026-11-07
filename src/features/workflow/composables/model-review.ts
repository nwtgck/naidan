import type { BrowserImageModelSelection } from '@/01-models/types';
import type { InjectionKey } from 'vue';
import type { WorkflowModelConfiguration } from '@/01-models/workflow';

/** Only explicit connection-form interactions use this hook, not JSON rendering. */
export const workflowModelReviewKey: InjectionKey<({ target }: { target: WorkflowModelConfiguration }) => void> = Symbol('workflow-model-review');

export const workflowAudioModelReviewKey: InjectionKey<({ modelId }: { modelId: string }) => void> = Symbol('workflow-audio-model-review');

export const workflowImageModelReviewKey: InjectionKey<({ selection }: { selection: BrowserImageModelSelection }) => void> = Symbol('workflow-image-model-review');

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
