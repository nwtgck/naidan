import { createDownloadVerificationModelArtifactRequestWorkerClient } from '@/features/transformers-js/download-verification/model-artifact-request-worker/client-hosted';
import { awaitWithAbort } from '@/features/transformers-js/download-verification/logic/await-with-abort';
import type { DownloadVerificationModelArtifactRequestObservation } from '@/features/transformers-js/download-verification/types';
import { TRANSFORMERS_JS_PRODUCTION_LOAD_CANDIDATES } from '@/features/transformers-js/production-load-candidates';
import type { TransformersJsProductionInvestigationCandidate } from '@/features/transformers-js/types';

export async function observeProductionModelArtifactCandidateRequests({
  modelId,
  revision,
  candidate,
  signal,
}: {
  modelId: string,
  revision: string,
  candidate: TransformersJsProductionInvestigationCandidate,
  signal?: AbortSignal,
}): Promise<DownloadVerificationModelArtifactRequestObservation> {
  signal?.throwIfAborted();
  const client = createDownloadVerificationModelArtifactRequestWorkerClient();
  try {
    const observation = client.observeModelArtifactRequests({ modelId, revision, candidate });
    return await awaitWithAbort({ operation: observation, signal });
  } finally {
    try {
      await client.dispose();
    } catch {
      // The dedicated client terminates its Worker in dispose(). A failed remote release
      // must not replace the actual observation/preparation/acceptance outcome.
    }
  }
}

export async function observeProductionModelArtifactRequests({
  modelId,
  revision,
  signal,
}: {
  modelId: string,
  revision: string,
  signal?: AbortSignal,
}): Promise<DownloadVerificationModelArtifactRequestObservation[]> {
  const observations: DownloadVerificationModelArtifactRequestObservation[] = [];
  for (const candidate of TRANSFORMERS_JS_PRODUCTION_LOAD_CANDIDATES) {
    signal?.throwIfAborted();
    observations.push(await observeProductionModelArtifactCandidateRequests({
      modelId,
      revision,
      candidate,
      signal,
    }));
  }
  return observations;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  PRODUCTION_CANDIDATES: TRANSFORMERS_JS_PRODUCTION_LOAD_CANDIDATES,
};
