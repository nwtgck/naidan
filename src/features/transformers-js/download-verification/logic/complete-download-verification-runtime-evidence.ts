import type { DownloadVerificationEvidenceInput, DownloadVerificationRuntimeCompletionEvidence } from '@/features/transformers-js/download-verification/evidence/types';
import { inspectDownloadVerificationCachedRevisions } from '@/features/transformers-js/download-verification/logic/inspect-cached-revisions';
import { reuseDownloadedProductionRevision } from '@/features/transformers-js/download-verification/logic/reuse-downloaded-production-revision';
import { runProductionDownloadPreparation } from '@/features/transformers-js/download-verification/logic/run-production-download-preparation';
import type { TransformersJsProgressCallback } from '@/features/transformers-js/types';

function serializedError({ error }: { error: unknown }): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
}


function runtimePreparationError({ preparation }: {
  preparation: Awaited<ReturnType<typeof runProductionDownloadPreparation>>;
}): { name: string; message: string } | undefined {
  switch (preparation.status) {
  case 'accepted':
    return undefined;
  case 'exhausted':
    return {
      name: 'ProductionDownloadPreparationExhausted',
      message: 'No Production candidate was accepted after runtime-complete preparation',
    };
  case 'failed':
    switch (preparation.failureStage) {
    case 'runtime-artifacts':
      return preparation.runtimeArtifacts.error ?? {
        name: 'RuntimeArtifactPreparationFailed',
        message: 'Production runtime artifact preparation failed without an error detail',
      };
    case 'candidate-orchestration':
      return preparation.candidates?.error ?? {
        name: 'CandidateOrchestrationFailed',
        message: 'Production candidate orchestration failed without an error detail',
      };
    case undefined:
      return {
        name: 'ProductionDownloadPreparationFailed',
        message: 'Production download preparation failed without identifying a failure stage',
      };
    default: {
      const _ex: never = preparation;
      throw new Error(`Unhandled Production download preparation failure variant: ${String(_ex)}`);
    }
    }
  default: {
    const _ex: never = preparation;
    throw new Error(`Unhandled runtime-complete preparation result: ${String(_ex)}`);
  }
  }
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

export async function completeDownloadVerificationRuntimeEvidence({
  evidence,
  progressCallback = () => undefined,
  signal,
  storageRoot,
  reuseRevision = reuseDownloadedProductionRevision,
  runPreparation = runProductionDownloadPreparation,
  inspectCachedRevisions = inspectDownloadVerificationCachedRevisions,
  allowLegacyMainReuse = true,
}: {
  evidence: DownloadVerificationEvidenceInput;
  progressCallback?: TransformersJsProgressCallback;
  signal?: AbortSignal;
  storageRoot?: FileSystemDirectoryHandle;
  reuseRevision?: typeof reuseDownloadedProductionRevision;
  runPreparation?: typeof runProductionDownloadPreparation;
  inspectCachedRevisions?: typeof inspectDownloadVerificationCachedRevisions;
  allowLegacyMainReuse?: boolean;
}): Promise<DownloadVerificationEvidenceInput> {
  signal?.throwIfAborted();
  const resolvedStorageRoot = storageRoot ?? await navigator.storage.getDirectory();
  const modelId = evidence.run.normalizedModelId;
  const repositoryResolvedRevision = evidence.run.resolvedRevision;

  let runtimeCompletion: DownloadVerificationRuntimeCompletionEvidence;
  try {
    const reuse = await reuseRevision({ modelId, resolvedRevision: repositoryResolvedRevision, storageRoot: resolvedStorageRoot });
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

    const preparation = await runPreparation({
      modelId,
      revision: repositoryResolvedRevision,
      progressCallback,
      signal,
    });
    signal?.throwIfAborted();
    const cacheObservation = await inspectCacheAfter({ modelId, storageRoot: resolvedStorageRoot, inspectCachedRevisions });
    switch (preparation.status) {
    case 'accepted':
      runtimeCompletion = {
        schemaVersion: 1,
        status: 'accepted',
        source: 'production-download-preparation',
        repositoryResolvedRevision,
        cacheRevision: repositoryResolvedRevision,
        loaderRevisionOption: repositoryResolvedRevision,
        selectedCandidate: preparation.candidates.selectedCandidate,
        cacheReuse: reuse.acceptance,
        preparation,
        ...cacheObservation,
        error: undefined,
      };
      break;
    case 'failed':
    case 'exhausted':
      runtimeCompletion = {
        schemaVersion: 1,
        status: preparation.status,
        source: 'production-download-preparation',
        repositoryResolvedRevision,
        cacheRevision: repositoryResolvedRevision,
        loaderRevisionOption: repositoryResolvedRevision,
        selectedCandidate: undefined,
        cacheReuse: reuse.acceptance,
        preparation,
        ...cacheObservation,
        error: runtimePreparationError({ preparation }),
      };
      break;
    default: {
      const _ex: never = preparation;
      throw new Error(`Unhandled runtime-complete preparation result: ${String(_ex)}`);
    }
    }
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
};
