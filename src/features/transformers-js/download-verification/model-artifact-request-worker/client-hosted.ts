import type {
  DownloadVerificationModelArtifactRequestObservation,
  DownloadVerificationModelArtifactRequestWorker,
} from '@/features/transformers-js/download-verification/types';
import type { TransformersJsProductionInvestigationCandidate } from '@/features/transformers-js/types';
import { wrapWorkerRemote } from '@/utils/worker-transport';
import { disposeDedicatedWorkerBestEffort } from '@/features/transformers-js/download-verification/dedicated-worker-cleanup';

export interface DownloadVerificationModelArtifactRequestWorkerClient {
  observeModelArtifactRequests({ modelId, revision, candidate }: {
    modelId: string;
    revision: string;
    candidate: TransformersJsProductionInvestigationCandidate;
  }): Promise<DownloadVerificationModelArtifactRequestObservation>;
  dispose(): Promise<void>;
}

export function createDownloadVerificationModelArtifactRequestWorkerClient(): DownloadVerificationModelArtifactRequestWorkerClient {
  if (typeof Worker === 'undefined') {
    return {
      async observeModelArtifactRequests(): Promise<DownloadVerificationModelArtifactRequestObservation> {
        throw new Error('Transformers.js model artifact request observer is not available in this environment');
      },
      async dispose(): Promise<void> {
      },
    };
  }

  const worker = new Worker(new URL('./entry.ts', import.meta.url), { type: 'module' });
  const remote = wrapWorkerRemote<DownloadVerificationModelArtifactRequestWorker>({ endpoint: worker });
  let disposed = false;

  return {
    async observeModelArtifactRequests({ modelId, revision, candidate }): Promise<DownloadVerificationModelArtifactRequestObservation> {
      return await remote.observeModelArtifactRequests({ modelId, revision, candidate });
    },
    async dispose(): Promise<void> {
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
