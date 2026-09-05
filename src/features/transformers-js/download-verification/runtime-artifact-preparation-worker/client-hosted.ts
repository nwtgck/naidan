import { workerProxy, wrapWorkerRemote } from '@/utils/worker-transport';
import { disposeDedicatedWorkerBestEffort } from '@/features/transformers-js/download-verification/dedicated-worker-cleanup';
import type {
  ITransformersJsWorker,
  ProgressInfo,
  TransformersJsProgressCallback,
  TransformersJsRuntimeArtifactPreparationResult,
} from '@/features/transformers-js/types';

export interface DownloadVerificationRuntimeArtifactPreparationWorkerClient {
  prepareModelRuntimeArtifacts({ modelId, revision, progressCallback }: {
    modelId: string;
    revision: string;
    progressCallback: TransformersJsProgressCallback;
  }): Promise<TransformersJsRuntimeArtifactPreparationResult>;
  dispose(): Promise<void>;
}

export function createDownloadVerificationRuntimeArtifactPreparationWorkerClient(): DownloadVerificationRuntimeArtifactPreparationWorkerClient {
  if (typeof Worker === 'undefined') {
    return {
      async prepareModelRuntimeArtifacts() {
        throw new Error('Download Verification runtime artifact preparation requires a browser Worker');
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
    async prepareModelRuntimeArtifacts({ modelId, revision, progressCallback }) {
      return await remote.prepareModelRuntimeArtifacts(
        modelId,
        revision,
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
