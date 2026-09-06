import type { DownloadVerificationEvidenceInput, DownloadVerificationRuntimeCompletionEvidence } from '@/features/transformers-js/download-verification/evidence/types';
import { inspectDownloadVerificationCachedRevisions } from '@/features/transformers-js/download-verification/logic/inspect-cached-revisions';
import { reuseDownloadedProductionRevision } from '@/features/transformers-js/download-verification/logic/reuse-downloaded-production-revision';
import type { TransformersJsProductionInvestigationCandidate } from '@/features/transformers-js/types';

function serializedError({ error }: { error: unknown }): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
}

async function inspectCacheAfter({
  modelId,
  storageRoot,
  inspectCachedRevisions,
}: {
  modelId: string;
  storageRoot: FileSystemDirectoryHandle;
  inspectCachedRevisions: typeof inspectDownloadVerificationCachedRevisions;
}): Promise<Pick<DownloadVerificationRuntimeCompletionEvidence, 'cacheAfter' | 'cacheInspectionError'>> {
  try {
    return {
      cacheAfter: await inspectCachedRevisions({ modelId, storageRoot }),
      cacheInspectionError: undefined,
    };
  } catch (error) {
    return {
      cacheAfter: undefined,
      cacheInspectionError: error instanceof Error ? error.message : String(error),
    };
  }
}

function unavailableLocalCacheError(): { name: string; message: string } {
  return {
    name: 'ModelSupportInvestigationLocalCacheIncomplete',
    message: 'No Production candidate is fully available in the downloaded-model cache. Model Support Investigation does not download, resume, repair, or complete model weight artifacts.',
  };
}

export async function completeDownloadVerificationRuntimeEvidence({
  evidence,
  signal,
  storageRoot,
  reuseRevision = reuseDownloadedProductionRevision,
  inspectCachedRevisions = inspectDownloadVerificationCachedRevisions,
  allowLegacyMainReuse = true,
  reusableCandidateOrderByRevision,
}: {
  evidence: DownloadVerificationEvidenceInput;
  signal?: AbortSignal;
  storageRoot?: FileSystemDirectoryHandle;
  reuseRevision?: typeof reuseDownloadedProductionRevision;
  inspectCachedRevisions?: typeof inspectDownloadVerificationCachedRevisions;
  allowLegacyMainReuse?: boolean;
  reusableCandidateOrderByRevision?: Readonly<Record<string, readonly TransformersJsProductionInvestigationCandidate[]>>;
}): Promise<DownloadVerificationEvidenceInput> {
  signal?.throwIfAborted();
  const resolvedStorageRoot = storageRoot ?? await navigator.storage.getDirectory();
  const modelId = evidence.run.normalizedModelId;
  const repositoryResolvedRevision = evidence.run.resolvedRevision;

  let runtimeCompletion: DownloadVerificationRuntimeCompletionEvidence;
  try {
    // Model Support Investigation is observational. It must never acquire the
    // full-artifact download capability simply to make later probes runnable.
    // This cache-only acceptance boundary is intentionally separate from the
    // explicit user model-download flow. Missing model weights or external-data
    // shards are evidence that blocks downstream runtime probes; they are not a
    // reason for MSI to download, resume, repair, or complete the model cache.
    const reuse = await reuseRevision({
      modelId,
      resolvedRevision: repositoryResolvedRevision,
      storageRoot: resolvedStorageRoot,
      ...(reusableCandidateOrderByRevision === undefined ? {} : { candidateOrderByRevision: reusableCandidateOrderByRevision }),
    });
    signal?.throwIfAborted();
    if (reuse.reused) {
      const cacheRevision = reuse.acceptance.selectedRevision?.revision ?? null;
      const revisionIdentity = reuse.loadRevision === repositoryResolvedRevision && cacheRevision === repositoryResolvedRevision
        ? 'exact-resolved-revision' as const
        : 'legacy-main-unverified' as const;
      if (revisionIdentity === 'exact-resolved-revision' || allowLegacyMainReuse) {
        const cacheObservation = await inspectCacheAfter({ modelId, storageRoot: resolvedStorageRoot, inspectCachedRevisions });
        runtimeCompletion = {
          schemaVersion: 1,
          status: 'accepted',
          source: 'reused-production-cache',
          repositoryResolvedRevision,
          cacheRevision,
          loaderRevisionOption: reuse.loadRevision ?? null,
          selectedCandidate: (() => {
            const acceptedAttempt = reuse.acceptance.attempts.find(attempt => attempt.acceptance.status === 'accepted');
            const selectedDevice = acceptedAttempt?.acceptance.selectedDevice;
            const selectedDtype = acceptedAttempt?.acceptance.selectedDtype;
            return selectedDevice === undefined || selectedDtype === undefined
              ? undefined
              : { device: selectedDevice, dtype: selectedDtype };
          })(),
          cacheReuse: reuse.acceptance,
          preparation: undefined,
          ...cacheObservation,
          error: undefined,
        };
        return { ...evidence, mode: 'runtime-complete', runtimeCompletion };
      }
    }

    const cacheObservation = await inspectCacheAfter({ modelId, storageRoot: resolvedStorageRoot, inspectCachedRevisions });
    runtimeCompletion = {
      schemaVersion: 1,
      status: 'exhausted',
      source: 'cache-only-unavailable',
      repositoryResolvedRevision,
      cacheRevision: null,
      loaderRevisionOption: null,
      selectedCandidate: undefined,
      cacheReuse: reuse.acceptance,
      preparation: undefined,
      ...cacheObservation,
      error: unavailableLocalCacheError(),
    };
  } catch (error) {
    signal?.throwIfAborted();
    const cacheObservation = await inspectCacheAfter({ modelId, storageRoot: resolvedStorageRoot, inspectCachedRevisions });
    runtimeCompletion = {
      schemaVersion: 1,
      status: 'failed',
      source: 'cache-reuse-failed',
      repositoryResolvedRevision,
      cacheRevision: null,
      loaderRevisionOption: null,
      selectedCandidate: undefined,
      cacheReuse: undefined,
      preparation: undefined,
      ...cacheObservation,
      error: serializedError({ error }),
    };
  }

  return { ...evidence, mode: 'runtime-complete', runtimeCompletion };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  unavailableLocalCacheError,
};
