import type { ProgressInfo, TransformersJsProductionInvestigationCandidate } from '@/features/transformers-js/types';

// Internal observation callback, converted by MSI to its recorded event format.
// No cache manifest is persisted and no observation controls candidate policy.
export type RuntimeAcceptanceProgressCallback = ({ progress }: { progress: {
  phase: 'cache-inventory' | 'revision-acceptance' | 'candidate-acceptance' | 'runtime' | 'cache-after';
  revision: string | undefined;
  candidate: TransformersJsProductionInvestigationCandidate | undefined;
  info: ProgressInfo | undefined;
} }) => void;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
