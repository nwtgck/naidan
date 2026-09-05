import { acceptDownloadedProductionRevision } from '@/features/transformers-js/download-verification/logic/accept-downloaded-production-revision';
import {
  planDownloadVerificationCachedRevisionLoadCandidates,
  type DownloadVerificationCachedRevisionInventory,
  type DownloadVerificationCachedRevisionLoadCandidate,
} from '@/features/transformers-js/download-verification/logic/inspect-cached-revisions';
import type { DownloadVerificationRevisionAcceptanceObservation } from '@/features/transformers-js/download-verification/types';

export interface DownloadVerificationCachedRevisionAcceptanceAttempt {
  candidate: DownloadVerificationCachedRevisionLoadCandidate;
  acceptance: DownloadVerificationRevisionAcceptanceObservation;
}

export interface DownloadVerificationCachedRevisionAcceptanceResult {
  status: 'accepted' | 'exhausted' | 'failed' | 'unavailable';
  selectedRevision: DownloadVerificationCachedRevisionLoadCandidate | undefined;
  attempts: DownloadVerificationCachedRevisionAcceptanceAttempt[];
  error: { name: string; message: string } | undefined;
}

function acceptanceIdentityError({
  modelId,
  resolvedRevision,
  candidate,
  acceptance,
}: {
  modelId: string;
  resolvedRevision: string | undefined;
  candidate: DownloadVerificationCachedRevisionLoadCandidate;
  acceptance: DownloadVerificationRevisionAcceptanceObservation;
}): { name: string; message: string } | undefined {
  const expectedResolvedRevision = resolvedRevision ?? null;
  const expectedLoaderRevision = candidate.loaderRevisionOption ?? null;
  if (
    acceptance.modelId === modelId
    && acceptance.repositoryResolvedRevision === expectedResolvedRevision
    && acceptance.cacheRevision === candidate.revision
    && acceptance.loaderRevisionOption === expectedLoaderRevision
  ) return undefined;

  return {
    name: 'RevisionAcceptanceIdentityMismatch',
    message: [
      `Expected ${modelId} cache revision ${candidate.revision}`,
      `with repository resolved revision ${expectedResolvedRevision ?? 'offline'}`,
      `and loader revision ${expectedLoaderRevision ?? 'main'}`,
      'but the acceptance observation described a different revision identity',
    ].join(' '),
  };
}

export async function runCachedRevisionAcceptanceOrchestration({
  inventory,
  resolvedRevision,
  acceptRevision,
  shouldContinueAfterFailedAcceptance = () => false,
  signal,
}: {
  inventory: DownloadVerificationCachedRevisionInventory;
  resolvedRevision: string | undefined;
  acceptRevision: ({ candidate }: {
    candidate: DownloadVerificationCachedRevisionLoadCandidate;
  }) => Promise<DownloadVerificationRevisionAcceptanceObservation>;
  shouldContinueAfterFailedAcceptance?: ({
    candidate,
    acceptance,
  }: {
    candidate: DownloadVerificationCachedRevisionLoadCandidate;
    acceptance: DownloadVerificationRevisionAcceptanceObservation;
  }) => boolean;
  signal?: AbortSignal;
}): Promise<DownloadVerificationCachedRevisionAcceptanceResult> {
  const candidates = planDownloadVerificationCachedRevisionLoadCandidates({ inventory, resolvedRevision });
  if (candidates.length === 0) {
    return {
      status: 'unavailable',
      selectedRevision: undefined,
      attempts: [],
      error: undefined,
    };
  }

  const attempts: DownloadVerificationCachedRevisionAcceptanceAttempt[] = [];
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    const acceptance = await acceptRevision({ candidate });
    signal?.throwIfAborted();
    attempts.push({ candidate, acceptance });

    const identityError = acceptanceIdentityError({
      modelId: inventory.modelId,
      resolvedRevision,
      candidate,
      acceptance,
    });
    if (identityError !== undefined) {
      return {
        status: 'failed',
        selectedRevision: undefined,
        attempts,
        error: identityError,
      };
    }

    switch (acceptance.status) {
    case 'accepted':
      return {
        status: 'accepted',
        selectedRevision: candidate,
        attempts,
        error: undefined,
      };
    case 'rejected':
      continue;
    case 'failed':
      if (shouldContinueAfterFailedAcceptance({ candidate, acceptance })) {
        continue;
      }
      return {
        status: 'failed',
        selectedRevision: undefined,
        attempts,
        error: acceptance.error ?? {
          name: 'RevisionAcceptanceFailed',
          message: `Cache-only Production acceptance failed for revision ${candidate.revision} without an error detail`,
        },
      };
    default: {
      const _ex: never = acceptance.status;
      throw new Error(`Unhandled revision acceptance status: ${_ex}`);
    }
    }
  }

  return {
    status: 'exhausted',
    selectedRevision: undefined,
    attempts,
    error: undefined,
  };
}

export async function acceptPlannedDownloadedProductionRevisions({
  inventory,
  resolvedRevision,
  signal,
}: {
  inventory: DownloadVerificationCachedRevisionInventory;
  resolvedRevision: string | undefined;
  signal?: AbortSignal;
}): Promise<DownloadVerificationCachedRevisionAcceptanceResult> {
  return await runCachedRevisionAcceptanceOrchestration({
    inventory,
    resolvedRevision,
    signal,
    acceptRevision: async ({ candidate }) => await acceptDownloadedProductionRevision({
      modelId: inventory.modelId,
      repositoryResolvedRevision: resolvedRevision,
      cacheRevision: candidate.revision,
      loadRevision: candidate.loaderRevisionOption,
      signal,
    }),
  });
}

export async function acceptReusableDownloadedProductionRevisionsForDownload({
  inventory,
  resolvedRevision,
  signal,
}: {
  inventory: DownloadVerificationCachedRevisionInventory;
  resolvedRevision: string;
  signal?: AbortSignal;
}): Promise<DownloadVerificationCachedRevisionAcceptanceResult> {
  return await runCachedRevisionAcceptanceOrchestration({
    inventory,
    resolvedRevision,
    signal,
    acceptRevision: async ({ candidate }) => await acceptDownloadedProductionRevision({
      modelId: inventory.modelId,
      repositoryResolvedRevision: resolvedRevision,
      cacheRevision: candidate.revision,
      loadRevision: candidate.loaderRevisionOption,
      signal,
    }),
    // Explicit Download is allowed to repair the current exact revision. A
    // missing artifact in one cached revision must not prevent a later, fully
    // usable legacy main revision from avoiding a multi-GB re-download. Other
    // acceptance failures remain fail-closed.
    shouldContinueAfterFailedAcceptance: ({ acceptance }) => (
      acceptance.error?.name === 'MissingDownloadedModelArtifact'
    ),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  acceptanceIdentityError,
};
