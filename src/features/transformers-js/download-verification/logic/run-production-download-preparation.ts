import { acceptDownloadedProductionCandidate } from '@/features/transformers-js/download-verification/logic/accept-downloaded-production-candidate';
import { prepareProductionModelCandidate } from '@/features/transformers-js/download-verification/logic/prepare-production-model-candidate';
import { prepareProductionRuntimeArtifacts } from '@/features/transformers-js/download-verification/logic/prepare-production-runtime-artifacts';
import { runCandidateDownloadOrchestration } from '@/features/transformers-js/download-verification/logic/run-candidate-download-orchestration';
import type {
  DownloadVerificationCandidateOrchestrationResult,
  DownloadVerificationRuntimeArtifactPreparationObservation,
} from '@/features/transformers-js/download-verification/types';
import type { TransformersJsProductionInvestigationCandidate, TransformersJsProgressCallback } from '@/features/transformers-js/types';
import { TRANSFORMERS_JS_PRODUCTION_LOAD_CANDIDATES } from '@/features/transformers-js/production-load-candidates';
import { observeDownloadSafely, publishDownloadProgress, type DownloadProgressCallback } from '@/features/transformers-js/download-progress';

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

function candidateKey({ candidate }: { candidate: TransformersJsProductionInvestigationCandidate }): string {
  return `${candidate.device}/${candidate.dtype}`;
}

export async function runProductionDownloadPreparation({
  modelId,
  revision,
  progressCallback = () => undefined,
  signal,
  candidateOrder,
  onDownloadProgress,
}: {
  modelId: string;
  revision: string;
  progressCallback?: TransformersJsProgressCallback;
  signal?: AbortSignal;
  candidateOrder?: readonly TransformersJsProductionInvestigationCandidate[];
  onDownloadProgress?: DownloadProgressCallback;
}): Promise<DownloadVerificationProductionDownloadPreparationRun> {
  const safeProgress: TransformersJsProgressCallback = ({ info }) => observeDownloadSafely({ observe: () => progressCallback({ info }) });
  const runtimeArtifacts = await prepareProductionRuntimeArtifacts({ modelId, revision, progressCallback: safeProgress, signal });
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

  publishDownloadProgress({ callback: onDownloadProgress, event: { kind: 'metadata', stage: 'complete' } });
  const order = candidateOrder ?? TRANSFORMERS_JS_PRODUCTION_LOAD_CANDIDATES;
  let attemptIndex = -1;
  const candidates = await runCandidateDownloadOrchestration({
    prepareCandidate: async ({ candidate }) => {
      const index = ++attemptIndex;
      publishDownloadProgress({ callback: onDownloadProgress, event: { kind: 'candidate', candidate, index, count: order.length } });
      const key = candidateKey({ candidate });
      const plan = runtimeArtifacts.resourcePlansByCandidate[key];
      if (plan === undefined) return { status: 'failed', error: { name: 'MissingProductionResourcePlan', message: `No resource plan was returned for ${key}` }, prefetch: undefined };
      switch (plan.status) {
      case 'planning-failed': return { status: 'planning-failed', error: plan.error, prefetch: undefined };
      case 'ready': return await prepareProductionModelCandidate({ modelId, revision, candidate, progressCallback: ({ info }) => {
        safeProgress({ info });
        publishDownloadProgress({ callback: onDownloadProgress, event: { kind: 'file', index, info } });
      }, signal, requiredModelPaths: plan.paths, onPlan: ({ paths }) => publishDownloadProgress({ callback: onDownloadProgress, event: { kind: 'plan', index, paths } }) });
      default: {
        const unexpected: never = plan;
        throw new Error(`Unhandled resource plan: ${String(unexpected)}`);
      }
      }
    },
    acceptCandidate: async ({ candidate }) => {
      publishDownloadProgress({ callback: onDownloadProgress, event: { kind: 'acceptance', index: attemptIndex } });
      return await acceptDownloadedProductionCandidate({
        modelId,
        resolvedRevision: revision,
        loadRevision: revision,
        candidate,
        progressCallback: safeProgress,
        signal,
      });
    },
    signal,
    candidates: order,
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
