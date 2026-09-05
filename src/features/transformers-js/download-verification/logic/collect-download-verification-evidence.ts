import type { DownloadVerificationProbeEvidenceInput } from '@/features/transformers-js/download-verification/evidence/types';
import { inspectDownloadVerificationCachedRevisions } from '@/features/transformers-js/download-verification/logic/inspect-cached-revisions';
import { observeProductionModelArtifactRequests } from '@/features/transformers-js/download-verification/logic/observe-production-model-artifact-requests';
import { runBrowserDownloadVerification } from '@/features/transformers-js/download-verification/logic/run-browser-download-verification';
import type { DownloadVerificationResolvedRepository } from '@/features/transformers-js/download-verification/types';

export async function collectDownloadVerificationEvidence({
  modelId,
  runId,
  signal,
  resolvedRepository,
  browserFetch = fetch,
  storageRoot,
  getStorageRoot = async () => navigator.storage.getDirectory(),
  runBrowserVerification = runBrowserDownloadVerification,
  inspectCachedRevisions = inspectDownloadVerificationCachedRevisions,
  observeModelArtifactRequests = observeProductionModelArtifactRequests,
}: {
  modelId: string;
  runId: string;
  signal?: AbortSignal;
  resolvedRepository?: DownloadVerificationResolvedRepository;
  browserFetch?: typeof fetch;
  storageRoot?: FileSystemDirectoryHandle;
  getStorageRoot?: () => Promise<FileSystemDirectoryHandle>;
  runBrowserVerification?: typeof runBrowserDownloadVerification;
  inspectCachedRevisions?: typeof inspectDownloadVerificationCachedRevisions;
  observeModelArtifactRequests?: typeof observeProductionModelArtifactRequests;
}): Promise<DownloadVerificationProbeEvidenceInput> {
  const run = await runBrowserVerification({
    modelId,
    resolvedRepository,
    browserFetch,
    signal,
  });

  let cacheBefore: DownloadVerificationProbeEvidenceInput['cacheBefore'];
  let cacheInspectionError: string | undefined;
  try {
    cacheBefore = await inspectCachedRevisions({
      modelId: run.normalizedModelId,
      storageRoot: storageRoot ?? await getStorageRoot(),
    });
  } catch (error) {
    signal?.throwIfAborted();
    cacheInspectionError = error instanceof Error ? error.message : String(error);
  }

  let modelArtifactObservations: DownloadVerificationProbeEvidenceInput['modelArtifactObservations'] = [];
  let modelArtifactObservationError: string | undefined;
  try {
    modelArtifactObservations = await observeModelArtifactRequests({
      modelId: run.normalizedModelId,
      revision: run.resolvedRevision,
      signal,
    });
  } catch (error) {
    signal?.throwIfAborted();
    modelArtifactObservationError = error instanceof Error ? error.message : String(error);
  }

  return {
    schemaVersion: 1,
    runId,
    mode: 'probe-only',
    run,
    modelArtifactObservations,
    modelArtifactObservationError,
    cacheBefore,
    cacheInspectionError,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
