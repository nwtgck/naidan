import { acceptDownloadedProductionCandidate } from '@/features/transformers-js/download-verification/logic/accept-downloaded-production-candidate';
import { prepareProductionModelCandidate } from '@/features/transformers-js/download-verification/logic/prepare-production-model-candidate';
import { prepareProductionRuntimeArtifacts } from '@/features/transformers-js/download-verification/logic/prepare-production-runtime-artifacts';
import { runCandidateDownloadOrchestration } from '@/features/transformers-js/download-verification/logic/run-candidate-download-orchestration';
import type {
  DownloadVerificationCandidateOrchestrationResult,
  DownloadVerificationRuntimeArtifactPreparationObservation,
} from '@/features/transformers-js/download-verification/types';
import type { TransformersJsProgressCallback } from '@/features/transformers-js/types';

export type DownloadVerificationProductionDownloadPreparationRun =
  | {
      status: 'failed';
      failureStage: 'runtime-artifacts';
      runtimeArtifacts: DownloadVerificationRuntimeArtifactPreparationObservation;
      candidates: undefined;
    }
  | {
      status: DownloadVerificationCandidateOrchestrationResult['status'];
      failureStage: 'candidate-orchestration' | undefined;
      runtimeArtifacts: DownloadVerificationRuntimeArtifactPreparationObservation;
      candidates: DownloadVerificationCandidateOrchestrationResult;
    };

export async function runProductionDownloadPreparation({ modelId, revision, progressCallback = () => undefined, signal }: {
  modelId: string;
  revision: string;
  progressCallback?: TransformersJsProgressCallback;
  signal?: AbortSignal;
}): Promise<DownloadVerificationProductionDownloadPreparationRun> {
  const runtimeArtifacts = await prepareProductionRuntimeArtifacts({ modelId, revision, progressCallback, signal });
  switch (runtimeArtifacts.status) {
  case 'failed':
    return {
      status: 'failed',
      failureStage: 'runtime-artifacts',
      runtimeArtifacts,
      candidates: undefined,
    };
  case 'prepared':
    break;
  default: {
    const _ex: never = runtimeArtifacts;
    throw new Error(`Unhandled runtime artifact preparation status: ${String(_ex)}`);
  }
  }

  const candidates = await runCandidateDownloadOrchestration({
    prepareCandidate: async ({ candidate }) => await prepareProductionModelCandidate({
      modelId,
      revision,
      candidate,
      progressCallback,
      signal,
    }),
    acceptCandidate: async ({ candidate }) => await acceptDownloadedProductionCandidate({
      modelId,
      resolvedRevision: revision,
      loadRevision: revision,
      candidate,
      progressCallback,
      signal,
    }),
    signal,
  });
  const failureStage = (() => {
    switch (candidates.status) {
    case 'failed':
      return 'candidate-orchestration' as const;
    case 'accepted':
    case 'exhausted':
      return undefined;
    default: {
      const _ex: never = candidates.status;
      throw new Error(`Unhandled candidate orchestration status: ${_ex}`);
    }
    }
  })();
  return {
    status: candidates.status,
    failureStage,
    runtimeArtifacts,
    candidates,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
