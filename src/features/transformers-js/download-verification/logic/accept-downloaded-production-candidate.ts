import { createDownloadVerificationCandidateAcceptanceWorkerClient, type DownloadVerificationCandidateAcceptanceWorkerClient } from '@/features/transformers-js/download-verification/candidate-acceptance-worker/client-hosted';
import { awaitWithAbort } from '@/features/transformers-js/download-verification/logic/await-with-abort';
import type { DownloadVerificationCandidateAcceptanceObservation } from '@/features/transformers-js/download-verification/types';
import type { TransformersJsProductionInvestigationCandidate, TransformersJsProgressCallback } from '@/features/transformers-js/types';

import { productionAcceptanceFailureStatus, serializeProductionAcceptanceError } from './production-acceptance-error';
import { readProductionLoadResultReceipt } from '@/features/transformers-js/runtime/production-load-receipt';
import { disposeWithDownloadTiming, measureDownloadAcceptance, type DownloadTimingCallback } from '@/features/transformers-js/download-timing';

export async function acceptDownloadedProductionCandidate({ modelId, resolvedRevision, loadRevision, candidate, progressCallback = () => undefined, signal, onTiming, createAcceptanceClient }: {
  modelId: string;
  resolvedRevision: string;
  loadRevision?: string;
  candidate: TransformersJsProductionInvestigationCandidate;
  progressCallback?: TransformersJsProgressCallback;
  signal?: AbortSignal;
  onTiming?: DownloadTimingCallback;
  createAcceptanceClient?: () => DownloadVerificationCandidateAcceptanceWorkerClient;
}): Promise<DownloadVerificationCandidateAcceptanceObservation> {
  return await measureDownloadAcceptance({ revision: loadRevision ?? 'main', candidate, route: 'candidate', callback: onTiming, operation: async ({ attempt, cleanup, load }) => {
    signal?.throwIfAborted();
    const client = createAcceptanceClient === undefined
      ? createDownloadVerificationCandidateAcceptanceWorkerClient({ operationSignal: signal })
      : createAcceptanceClient();
    try {
      attempt({ count: 1 });
      const operation = client.verifyDownloadedModelCandidate({
        modelId,
        loadRevision,
        candidate,
        progressCallback,
      });
      const result = await awaitWithAbort({ operation, signal });
      if (result.device !== candidate.device) {
        load({ outcome: 'rejected' });
        return {
          modelId,
          resolvedRevision,
          loaderRevisionOption: loadRevision ?? null,
          candidate,
          status: 'rejected',
          observationMethod: 'production-cache-only-runtime-preparation',
          error: {
            name: 'UnexpectedCandidateDevice',
            message: `Expected ${candidate.device}, received ${result.device}`,
          },
        };
      }
      const receipt = readProductionLoadResultReceipt({ value: result, modelId, revision: loadRevision });
      load({ outcome: 'accepted' });
      return {
        modelId,
        resolvedRevision,
        loaderRevisionOption: loadRevision ?? null,
        candidate,
        status: 'accepted',
        observationMethod: 'production-cache-only-runtime-preparation',
        error: undefined,
        receipt,
      };
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      load({ outcome: productionAcceptanceFailureStatus({ error }) });
      return {
        modelId,
        resolvedRevision,
        loaderRevisionOption: loadRevision ?? null,
        candidate,
        status: productionAcceptanceFailureStatus({ error }),
        observationMethod: 'production-cache-only-runtime-preparation',
        error: serializeProductionAcceptanceError({ error }),
      };
    } finally {
      await disposeWithDownloadTiming({ dispose: () => client.dispose(), onOutcome: cleanup });
    }
  } });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
