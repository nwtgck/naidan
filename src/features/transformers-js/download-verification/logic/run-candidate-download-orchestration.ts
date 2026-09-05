import type {
  DownloadVerificationCandidateAcceptanceObservation,
  DownloadVerificationCandidateOrchestrationAttempt,
  DownloadVerificationCandidateOrchestrationResult,
  DownloadVerificationCandidatePreparationObservation,
} from '@/features/transformers-js/download-verification/types';
import { TRANSFORMERS_JS_PRODUCTION_LOAD_CANDIDATES } from '@/features/transformers-js/production-load-candidates';
import type { TransformersJsProductionInvestigationCandidate } from '@/features/transformers-js/types';

export async function runCandidateDownloadOrchestration({
  prepareCandidate,
  acceptCandidate,
  candidates = TRANSFORMERS_JS_PRODUCTION_LOAD_CANDIDATES,
  signal,
}: {
  prepareCandidate: ({ candidate }: {
    candidate: TransformersJsProductionInvestigationCandidate;
  }) => Promise<DownloadVerificationCandidatePreparationObservation>;
  acceptCandidate: ({ candidate }: {
    candidate: TransformersJsProductionInvestigationCandidate;
  }) => Promise<DownloadVerificationCandidateAcceptanceObservation>;
  candidates?: readonly TransformersJsProductionInvestigationCandidate[];
  signal?: AbortSignal;
}): Promise<DownloadVerificationCandidateOrchestrationResult> {
  const attempts: DownloadVerificationCandidateOrchestrationAttempt[] = [];

  for (const candidate of candidates) {
    signal?.throwIfAborted();
    const preparation = await prepareCandidate({ candidate });
    signal?.throwIfAborted();

    switch (preparation.status) {
    case 'unavailable':
      attempts.push({ candidate, preparation, acceptance: undefined });
      continue;
    case 'failed':
      attempts.push({ candidate, preparation, acceptance: undefined });
      return {
        status: 'failed',
        selectedCandidate: undefined,
        attempts,
        error: preparation.error,
      };
    case 'ready':
      break;
    default: {
      const _ex: never = preparation;
      throw new Error(`Unhandled candidate preparation status: ${String(_ex)}`);
    }
    }

    const acceptance = await acceptCandidate({ candidate });
    attempts.push({ candidate, preparation, acceptance });
    signal?.throwIfAborted();
    switch (acceptance.status) {
    case 'accepted':
      return {
        status: 'accepted',
        selectedCandidate: candidate,
        attempts,
        error: undefined,
      };
    case 'rejected':
      continue;
    case 'failed':
      return {
        status: 'failed',
        selectedCandidate: undefined,
        attempts,
        error: acceptance.error ?? { name: 'CandidateAcceptanceFailed', message: 'Candidate acceptance failed without an error detail' },
      };
    default: {
      const _ex: never = acceptance.status;
      throw new Error(`Unhandled candidate acceptance status: ${_ex}`);
    }
    }
  }

  return {
    status: 'exhausted',
    selectedCandidate: undefined,
    attempts,
    error: undefined,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
