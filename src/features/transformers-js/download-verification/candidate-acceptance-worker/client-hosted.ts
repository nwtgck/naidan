import { workerProxy, wrapWorkerRemote } from '@/utils/worker-transport';
import { disposeDedicatedWorkerBestEffort } from '@/features/transformers-js/download-verification/dedicated-worker-cleanup';
import type {
  ITransformersJsWorker,
  ModelLoadResult,
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
  }): Promise<ModelLoadResult>;
  verifyDownloadedModelRevision({ modelId, loadRevision, progressCallback }: {
    modelId: string;
    loadRevision: string | undefined;
    progressCallback: TransformersJsProgressCallback;
  }): Promise<ModelLoadResult>;
  dispose(): Promise<void>;
}

export function createDownloadVerificationCandidateAcceptanceWorkerClient(): DownloadVerificationCandidateAcceptanceWorkerClient {
  if (typeof Worker === 'undefined') {
    return {
      async verifyDownloadedModelCandidate() {
        throw new Error('Download Verification candidate acceptance requires a browser Worker');
      },
      async verifyDownloadedModelRevision() {
        throw new Error('Download Verification revision acceptance requires a browser Worker');
      },
      async dispose() {
      },
    };
  }

  const worker = new Worker(
    new URL('../../worker/entry.ts', import.meta.url),
    { type: 'module' },
  );
  const remote = wrapWorkerRemote<ITransformersJsWorker>({ endpoint: worker });
  let disposed = false;

  return {
    async verifyDownloadedModelCandidate({ modelId, loadRevision, candidate, progressCallback }) {
      return await remote.verifyDownloadedModelCandidate(
        modelId,
        loadRevision,
        candidate,
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink callback is a positional remote boundary.
        workerProxy({ value: (info: ProgressInfo) => progressCallback({ info }) }),
      );
    },
    async verifyDownloadedModelRevision({ modelId, loadRevision, progressCallback }) {
      return await remote.verifyDownloadedModelRevision(
        modelId,
        loadRevision,
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink callback is a positional remote boundary.
        workerProxy({ value: (info: ProgressInfo) => progressCallback({ info }) }),
      );
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      disposeDedicatedWorkerBestEffort({ remote, worker });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
