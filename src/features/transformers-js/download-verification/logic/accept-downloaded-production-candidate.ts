import { createDownloadVerificationCandidateAcceptanceWorkerClient } from '@/features/transformers-js/download-verification/candidate-acceptance-worker/client-hosted';
import { awaitWithAbort } from '@/features/transformers-js/download-verification/logic/await-with-abort';
import { sanitizeDiagnosticText } from '@/features/transformers-js/download-verification/logic/run-browser-download-verification';
import type { DownloadVerificationCandidateAcceptanceObservation } from '@/features/transformers-js/download-verification/types';
import type { TransformersJsProductionInvestigationCandidate, TransformersJsProgressCallback } from '@/features/transformers-js/types';

function acceptanceFailureStatus({ error }: { error: unknown }): 'rejected' | 'failed' {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('MUST NOT fetch model artifacts')) return 'failed';
  if (message.includes('requires a browser Worker')) return 'failed';
  return 'rejected';
}

function serializedError({ error }: { error: unknown }): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: sanitizeDiagnosticText({ value: error.message }),
    };
  }
  return {
    name: 'Error',
    message: sanitizeDiagnosticText({ value: String(error) }),
  };
}

export async function acceptDownloadedProductionCandidate({ modelId, resolvedRevision, loadRevision, candidate, progressCallback = () => undefined, signal }: {
  modelId: string;
  resolvedRevision: string;
  loadRevision?: string;
  candidate: TransformersJsProductionInvestigationCandidate;
  progressCallback?: TransformersJsProgressCallback;
  signal?: AbortSignal;
}): Promise<DownloadVerificationCandidateAcceptanceObservation> {
  signal?.throwIfAborted();
  const client = createDownloadVerificationCandidateAcceptanceWorkerClient();
  try {
    const operation = client.verifyDownloadedModelCandidate({
      modelId,
      loadRevision,
      candidate,
      progressCallback,
    });
    const result = await awaitWithAbort({ operation, signal });
    if (result.device !== candidate.device) {
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
    return {
      modelId,
      resolvedRevision,
      loaderRevisionOption: loadRevision ?? null,
      candidate,
      status: 'accepted',
      observationMethod: 'production-cache-only-runtime-preparation',
      error: undefined,
    };
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    return {
      modelId,
      resolvedRevision,
      loaderRevisionOption: loadRevision ?? null,
      candidate,
      status: acceptanceFailureStatus({ error }),
      observationMethod: 'production-cache-only-runtime-preparation',
      error: serializedError({ error }),
    };
  } finally {
    try {
      await client.dispose();
    } catch {
      // The dedicated client terminates its Worker in dispose(). A failed remote release
      // must not replace the actual observation/preparation/acceptance outcome.
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
