import { inspectDownloadVerificationCachedRevisions, planDownloadVerificationCachedRevisionLoadCandidates } from '@/features/transformers-js/download-verification/logic/inspect-cached-revisions';
import { acceptReusableDownloadedProductionRevisionsForDownload, type DownloadVerificationCachedRevisionAcceptanceResult } from '@/features/transformers-js/download-verification/logic/run-cached-revision-acceptance-orchestration';
import type { TransformersJsProductionInvestigationCandidate } from '@/features/transformers-js/types';

export type DownloadVerificationReusableRevisionResult =
  | {
      reused: true;
      loadRevision: string | undefined;
      acceptance: DownloadVerificationCachedRevisionAcceptanceResult;
    }
  | {
      reused: false;
      acceptance: DownloadVerificationCachedRevisionAcceptanceResult | undefined;
    };

export async function reuseDownloadedProductionRevision({
  modelId,
  resolvedRevision,
  storageRoot,
  inspectCachedRevisions = inspectDownloadVerificationCachedRevisions,
  acceptReusableRevisions = acceptReusableDownloadedProductionRevisionsForDownload,
  candidateOrderByRevision,
}: {
  modelId: string;
  resolvedRevision: string;
  storageRoot?: FileSystemDirectoryHandle;
  inspectCachedRevisions?: typeof inspectDownloadVerificationCachedRevisions;
  acceptReusableRevisions?: typeof acceptReusableDownloadedProductionRevisionsForDownload;
  candidateOrderByRevision?: Readonly<Record<string, readonly TransformersJsProductionInvestigationCandidate[]>>;
}): Promise<DownloadVerificationReusableRevisionResult> {
  const resolvedStorageRoot = storageRoot ?? await navigator.storage.getDirectory();
  let inventory: Awaited<ReturnType<typeof inspectDownloadVerificationCachedRevisions>>;
  try {
    inventory = await inspectCachedRevisions({ modelId, storageRoot: resolvedStorageRoot });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`CachedRevisionInspectionFailed: Could not safely inspect existing cached revisions before downloading (${detail})`, { cause: error });
  }

  if (planDownloadVerificationCachedRevisionLoadCandidates({ inventory, resolvedRevision }).length === 0) {
    return { reused: false, acceptance: undefined };
  }

  const reuse = await acceptReusableRevisions({ inventory, resolvedRevision, candidateOrderByRevision });
  switch (reuse.status) {
  case 'accepted':
    return {
      reused: true,
      loadRevision: reuse.selectedRevision?.loaderRevisionOption,
      acceptance: reuse,
    };
  case 'unavailable':
    return { reused: false, acceptance: reuse };
  case 'exhausted': {
    const rejectedAttempt = reuse.attempts.find(attempt => attempt.acceptance.status === 'rejected');
    if (rejectedAttempt !== undefined) {
      const detail = rejectedAttempt.acceptance.error;
      throw new Error(`${detail?.name ?? 'CachedRevisionRuntimeRejected'}: ${detail?.message ?? `Existing downloaded revision ${rejectedAttempt.candidate.revision} was rejected by the Production runtime`}`);
    }
    return { reused: false, acceptance: reuse };
  }
  case 'failed':
    throw new Error(`${reuse.error?.name ?? 'CachedRevisionAcceptanceFailed'}: ${reuse.error?.message ?? 'Existing downloaded model cache could not be verified safely'}`);
  default: {
    const _ex: never = reuse.status;
    throw new Error(`Unhandled cached revision acceptance result: ${String(_ex)}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
