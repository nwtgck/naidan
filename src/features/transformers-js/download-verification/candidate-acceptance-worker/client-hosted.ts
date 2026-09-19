import { workerProxy } from '@/utils/worker-transport';
import { createProductionWorkerSession, ProductionWorkerLifecycleError } from '@/features/transformers-js/worker/production-worker-session';
import { DownloadAcceptanceWorkerRetirementError, type DownloadAcceptanceVerificationOutcome } from './retirement-error';
import type {
  ProductionModelLoadAcceptanceResult,
  ProgressInfo,
  TransformersJsProductionInvestigationCandidate,
  TransformersJsProgressCallback,
} from '@/features/transformers-js/types';

export interface DownloadVerificationCandidateAcceptanceWorkerClient {
  verifyDownloadedModelCandidate({ modelId, loadRevision, candidate, progressCallback }: {
    modelId: string;
    loadRevision: string | undefined;
    candidate: TransformersJsProductionInvestigationCandidate;
    progressCallback: TransformersJsProgressCallback;
  }): Promise<ProductionModelLoadAcceptanceResult>;
  verifyDownloadedModelRevision({ modelId, loadRevision, progressCallback }: {
    modelId: string;
    loadRevision: string | undefined;
    progressCallback: TransformersJsProgressCallback;
  }): Promise<ProductionModelLoadAcceptanceResult>;
  dispose(): Promise<void>;
}

export function createDownloadVerificationCandidateAcceptanceWorkerClient({ operationSignal }: {
  // Diagnostic context only: this client does not cancel Download I/O.
  operationSignal: AbortSignal | undefined;
}): DownloadVerificationCandidateAcceptanceWorkerClient {
  if (typeof Worker === 'undefined') {
    return {
      async verifyDownloadedModelCandidate() {
        throw new ProductionWorkerLifecycleError({ reason: 'initialization-failed', message: 'Download Verification candidate acceptance requires a browser Worker' });
      },
      async verifyDownloadedModelRevision() {
        throw new ProductionWorkerLifecycleError({ reason: 'initialization-failed', message: 'Download Verification revision acceptance requires a browser Worker' });
      },
      async dispose() {
      },
    };
  }

  const worker = new Worker(
    new URL('../../worker/bootstrap.ts', import.meta.url),
    { type: 'module' },
  );
  const session = createProductionWorkerSession({ worker, startupTimeoutMs: undefined });
  let verificationOutcome: DownloadAcceptanceVerificationOutcome = { status: 'not-settled' };
  let retirementError: DownloadAcceptanceWorkerRetirementError | undefined;
  let verificationOrdinal = 0;

  async function verify({ operation }: { operation: () => Promise<ProductionModelLoadAcceptanceResult> }): Promise<ProductionModelLoadAcceptanceResult> {
    const ordinal = ++verificationOrdinal;
    verificationOutcome = { status: 'not-settled' };
    try {
      const result = await operation();
      if (ordinal === verificationOrdinal) verificationOutcome = { status: 'fulfilled', device: result.device, dtype: result.dtype };
      return result;
    } catch (error) {
      if (ordinal === verificationOrdinal) verificationOutcome = { status: 'rejected', error };
      throw error;
    }
  }

  return {
    async verifyDownloadedModelCandidate({ modelId, loadRevision, candidate, progressCallback }) {
      return await verify({ operation: () => session.run({ operation: ({ remote }) => remote.verifyDownloadedModelCandidate(
        modelId,
        loadRevision,
        candidate,
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink callback is a positional remote boundary.
        workerProxy({ value: (info: ProgressInfo) => {
          if (session.isActive()) return progressCallback({ info });
        } }),
      ) }) });
    },
    async verifyDownloadedModelRevision({ modelId, loadRevision, progressCallback }) {
      return await verify({ operation: () => session.run({ operation: ({ remote }) => remote.verifyDownloadedModelRevision(
        modelId,
        loadRevision,
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink callback is a positional remote boundary.
        workerProxy({ value: (info: ProgressInfo) => {
          if (session.isActive()) return progressCallback({ info });
        } }),
      ) }) });
    },
    async dispose() {
      if (retirementError !== undefined) throw retirementError;
      try {
        session.dispose();
      } catch (cause) {
        // Remote release is advisory inside the session. A rejection here
        // means physical retirement is unknown, including throw undefined/null.
        retirementError = new DownloadAcceptanceWorkerRetirementError({ cause, verificationOutcome,
          interruption: operationSignal?.aborted ? { reason: operationSignal.reason } : undefined,
        });
        throw retirementError;
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
