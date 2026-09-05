import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptPlannedDownloadedProductionRevisions,
  acceptReusableDownloadedProductionRevisionsForDownload,
  runCachedRevisionAcceptanceOrchestration,
} from '@/features/transformers-js/download-verification/logic/run-cached-revision-acceptance-orchestration';
import { acceptDownloadedProductionRevision } from '@/features/transformers-js/download-verification/logic/accept-downloaded-production-revision';
import type {
  DownloadVerificationCachedRevision,
  DownloadVerificationCachedRevisionInventory,
  DownloadVerificationCachedRevisionLoadCandidate,
} from '@/features/transformers-js/download-verification/logic/inspect-cached-revisions';
import type { DownloadVerificationRevisionAcceptanceObservation } from '@/features/transformers-js/download-verification/types';

vi.mock('@/features/transformers-js/download-verification/logic/accept-downloaded-production-revision', () => ({
  acceptDownloadedProductionRevision: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

const CURRENT = '1'.repeat(40);
const STALE = '2'.repeat(40);

function revision({
  revision: revisionValue,
  kind,
  lastModified,
}: {
  revision: string;
  kind: DownloadVerificationCachedRevision['kind'];
  lastModified: number;
}): DownloadVerificationCachedRevision {
  return {
    revision: revisionValue,
    kind,
    totalBytes: 100,
    fileCount: 2,
    completionMarkerCount: 2,
    incompleteFileCount: 0,
    zeroByteFileCount: 0,
    weightFileCount: 1,
    lastModified,
    status: 'committed-file-set',
  };
}

function inventory(revisions: DownloadVerificationCachedRevision[]): DownloadVerificationCachedRevisionInventory {
  return {
    modelId: 'org/model',
    normalizedModelId: 'org/model',
    revisions,
  };
}

function observation({
  candidate,
  repositoryResolvedRevision,
  status,
  message,
  errorName = 'Error',
}: {
  candidate: DownloadVerificationCachedRevisionLoadCandidate;
  repositoryResolvedRevision: string | undefined;
  status: DownloadVerificationRevisionAcceptanceObservation['status'];
  message?: string;
  errorName?: string;
}): DownloadVerificationRevisionAcceptanceObservation {
  return {
    modelId: 'org/model',
    repositoryResolvedRevision: repositoryResolvedRevision ?? null,
    cacheRevision: candidate.revision,
    loaderRevisionOption: candidate.loaderRevisionOption ?? null,
    status,
    selectedDevice: status === 'accepted' ? 'webgpu' : undefined,
    selectedDtype: status === 'accepted' ? 'q4' : undefined,
    observationMethod: 'production-cache-only-revision-runtime-preparation',
    error: message === undefined ? undefined : { name: errorName, message },
  };
}

describe('runCachedRevisionAcceptanceOrchestration', () => {
  it('accepts the current immutable revision before considering legacy main', async () => {
    const cached = inventory([
      revision({ revision: 'main', kind: 'legacy-main', lastModified: 10 }),
      revision({ revision: CURRENT, kind: 'immutable-sha', lastModified: 20 }),
    ]);
    const acceptRevision = vi.fn(async ({ candidate }: { candidate: DownloadVerificationCachedRevisionLoadCandidate }) => (
      observation({ candidate, repositoryResolvedRevision: CURRENT, status: 'accepted' })
    ));

    const result = await runCachedRevisionAcceptanceOrchestration({
      inventory: cached,
      resolvedRevision: CURRENT,
      acceptRevision,
    });

    expect(result.status).toBe('accepted');
    expect(result.selectedRevision).toEqual({
      revision: CURRENT,
      loaderRevisionOption: CURRENT,
      source: 'current-resolved-revision',
    });
    expect(acceptRevision).toHaveBeenCalledTimes(1);
  });

  it('falls back from a runtime-rejected current SHA to the legacy main cache', async () => {
    const cached = inventory([
      revision({ revision: 'main', kind: 'legacy-main', lastModified: 10 }),
      revision({ revision: CURRENT, kind: 'immutable-sha', lastModified: 20 }),
    ]);
    const acceptRevision = vi.fn(async ({ candidate }: { candidate: DownloadVerificationCachedRevisionLoadCandidate }) => (
      observation({
        candidate,
        repositoryResolvedRevision: CURRENT,
        status: candidate.revision === CURRENT ? 'rejected' : 'accepted',
        message: candidate.revision === CURRENT ? 'runtime rejected every candidate' : undefined,
      })
    ));

    const result = await runCachedRevisionAcceptanceOrchestration({
      inventory: cached,
      resolvedRevision: CURRENT,
      acceptRevision,
    });

    expect(result.status).toBe('accepted');
    expect(result.selectedRevision?.source).toBe('legacy-main');
    expect(result.attempts.map(attempt => attempt.candidate.revision)).toEqual([CURRENT, 'main']);
  });

  it('stops on current-revision cache verification failure instead of hiding it behind legacy main', async () => {
    const cached = inventory([
      revision({ revision: 'main', kind: 'legacy-main', lastModified: 10 }),
      revision({ revision: CURRENT, kind: 'immutable-sha', lastModified: 20 }),
    ]);
    const acceptRevision = vi.fn(async ({ candidate }: { candidate: DownloadVerificationCachedRevisionLoadCandidate }) => (
      observation({ candidate, repositoryResolvedRevision: CURRENT, status: 'failed', message: 'required cache artifact is missing' })
    ));

    const result = await runCachedRevisionAcceptanceOrchestration({
      inventory: cached,
      resolvedRevision: CURRENT,
      acceptRevision,
    });

    expect(result).toMatchObject({
      status: 'failed',
      selectedRevision: undefined,
      error: { message: 'required cache artifact is missing' },
    });
    expect(acceptRevision).toHaveBeenCalledTimes(1);
  });

  it('uses legacy main and then immutable revisions deterministically when offline', async () => {
    const cached = inventory([
      revision({ revision: 'main', kind: 'legacy-main', lastModified: 5 }),
      revision({ revision: STALE, kind: 'immutable-sha', lastModified: 10 }),
      revision({ revision: CURRENT, kind: 'immutable-sha', lastModified: 20 }),
    ]);
    const acceptRevision = vi.fn(async ({ candidate }: { candidate: DownloadVerificationCachedRevisionLoadCandidate }) => (
      observation({
        candidate,
        repositoryResolvedRevision: undefined,
        status: candidate.revision === CURRENT ? 'accepted' : 'rejected',
        message: candidate.revision === CURRENT ? undefined : 'runtime rejected',
      })
    ));

    const result = await runCachedRevisionAcceptanceOrchestration({
      inventory: cached,
      resolvedRevision: undefined,
      acceptRevision,
    });

    expect(result.status).toBe('accepted');
    expect(result.selectedRevision?.revision).toBe(CURRENT);
    expect(result.attempts.map(attempt => attempt.candidate.revision)).toEqual(['main', CURRENT]);
  });

  it('returns unavailable when no committed revision candidate is eligible', async () => {
    const result = await runCachedRevisionAcceptanceOrchestration({
      inventory: inventory([]),
      resolvedRevision: CURRENT,
      acceptRevision: vi.fn(),
    });

    expect(result).toEqual({
      status: 'unavailable',
      selectedRevision: undefined,
      attempts: [],
      error: undefined,
    });
  });

  it('fails closed when the acceptance observation describes a different cache identity', async () => {
    const cached = inventory([
      revision({ revision: CURRENT, kind: 'immutable-sha', lastModified: 20 }),
    ]);

    const result = await runCachedRevisionAcceptanceOrchestration({
      inventory: cached,
      resolvedRevision: CURRENT,
      acceptRevision: vi.fn(async ({ candidate }) => ({
        ...observation({ candidate, repositoryResolvedRevision: CURRENT, status: 'accepted' }),
        cacheRevision: STALE,
      })),
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { name: 'RevisionAcceptanceIdentityMismatch' },
    });
  });


  it('lets explicit Download skip a missing current exact cache and reuse a complete legacy main cache', async () => {
    const cached = inventory([
      revision({ revision: 'main', kind: 'legacy-main', lastModified: 10 }),
      revision({ revision: CURRENT, kind: 'immutable-sha', lastModified: 20 }),
    ]);
    vi.mocked(acceptDownloadedProductionRevision).mockImplementation(async ({ cacheRevision, loadRevision }) => ({
      modelId: 'org/model',
      repositoryResolvedRevision: CURRENT,
      cacheRevision,
      loaderRevisionOption: loadRevision ?? null,
      status: cacheRevision === CURRENT ? 'failed' : 'accepted',
      selectedDevice: cacheRevision === CURRENT ? undefined : 'webgpu',
      selectedDtype: cacheRevision === CURRENT ? undefined : 'q4',
      observationMethod: 'production-cache-only-revision-runtime-preparation',
      error: cacheRevision === CURRENT
        ? { name: 'MissingDownloadedModelArtifact', message: 'required cache artifact is missing' }
        : undefined,
    }));

    const result = await acceptReusableDownloadedProductionRevisionsForDownload({
      inventory: cached,
      resolvedRevision: CURRENT,
    });

    expect(result.status).toBe('accepted');
    expect(result.selectedRevision).toMatchObject({
      revision: 'main',
      loaderRevisionOption: undefined,
      source: 'legacy-main',
    });
    expect(result.attempts.map(attempt => attempt.candidate.revision)).toEqual([CURRENT, 'main']);
    expect(acceptDownloadedProductionRevision).toHaveBeenNthCalledWith(1, expect.objectContaining({
      cacheRevision: CURRENT,
      loadRevision: CURRENT,
    }));
    expect(acceptDownloadedProductionRevision).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cacheRevision: 'main',
      loadRevision: undefined,
    }));
  });

  it('keeps explicit Download fail-closed for non-missing current-revision acceptance failures', async () => {
    const cached = inventory([
      revision({ revision: 'main', kind: 'legacy-main', lastModified: 10 }),
      revision({ revision: CURRENT, kind: 'immutable-sha', lastModified: 20 }),
    ]);
    vi.mocked(acceptDownloadedProductionRevision).mockImplementation(async ({ cacheRevision, loadRevision }) => ({
      modelId: 'org/model',
      repositoryResolvedRevision: CURRENT,
      cacheRevision,
      loaderRevisionOption: loadRevision ?? null,
      status: 'failed',
      selectedDevice: undefined,
      selectedDtype: undefined,
      observationMethod: 'production-cache-only-revision-runtime-preparation',
      error: { name: 'RevisionAcceptanceInfrastructureFailure', message: 'worker startup failed' },
    }));

    const result = await acceptReusableDownloadedProductionRevisionsForDownload({
      inventory: cached,
      resolvedRevision: CURRENT,
    });

    expect(result).toMatchObject({
      status: 'failed',
      selectedRevision: undefined,
      error: { name: 'RevisionAcceptanceInfrastructureFailure' },
    });
    expect(acceptDownloadedProductionRevision).toHaveBeenCalledTimes(1);
  });

  it('exhausts explicit Download cache reuse when every reusable revision is missing an artifact', async () => {
    const cached = inventory([
      revision({ revision: 'main', kind: 'legacy-main', lastModified: 10 }),
      revision({ revision: CURRENT, kind: 'immutable-sha', lastModified: 20 }),
    ]);
    vi.mocked(acceptDownloadedProductionRevision).mockImplementation(async ({ cacheRevision, loadRevision }) => ({
      modelId: 'org/model',
      repositoryResolvedRevision: CURRENT,
      cacheRevision,
      loaderRevisionOption: loadRevision ?? null,
      status: 'failed',
      selectedDevice: undefined,
      selectedDtype: undefined,
      observationMethod: 'production-cache-only-revision-runtime-preparation',
      error: { name: 'MissingDownloadedModelArtifact', message: `missing artifact in ${cacheRevision}` },
    }));

    const result = await acceptReusableDownloadedProductionRevisionsForDownload({
      inventory: cached,
      resolvedRevision: CURRENT,
    });

    expect(result.status).toBe('exhausted');
    expect(result.selectedRevision).toBeUndefined();
    expect(result.attempts.map(attempt => attempt.candidate.revision)).toEqual([CURRENT, 'main']);
  });

  it('skips a cached revision whose constrained candidate set is empty and forwards the next revision candidate set', async () => {
    const cached = inventory([
      revision({ revision: 'main', kind: 'legacy-main', lastModified: 10 }),
      revision({ revision: CURRENT, kind: 'immutable-sha', lastModified: 20 }),
    ]);
    const q4 = [{ device: 'webgpu' as const, dtype: 'q4' as const }];
    const acceptRevision = vi.fn(async ({ candidate }: { candidate: DownloadVerificationCachedRevisionLoadCandidate }) => (
      observation({ candidate, repositoryResolvedRevision: CURRENT, status: 'accepted' })
    ));

    const result = await runCachedRevisionAcceptanceOrchestration({
      inventory: cached,
      resolvedRevision: CURRENT,
      candidateOrderByRevision: {
        [CURRENT]: [],
        main: q4,
      },
      acceptRevision,
    });

    expect(result.status).toBe('accepted');
    expect(result.selectedRevision?.revision).toBe('main');
    expect(acceptRevision).toHaveBeenCalledTimes(1);
    expect(acceptRevision).toHaveBeenCalledWith({
      candidate: { revision: 'main', loaderRevisionOption: undefined, source: 'legacy-main' },
      candidateOrder: q4,
    });
  });

  it('forwards per-revision constrained candidates into the actual revision acceptance primitive', async () => {
    const cached = inventory([
      revision({ revision: CURRENT, kind: 'immutable-sha', lastModified: 20 }),
    ]);
    const q4 = [{ device: 'webgpu' as const, dtype: 'q4' as const }];
    vi.mocked(acceptDownloadedProductionRevision).mockResolvedValue({
      modelId: 'org/model',
      repositoryResolvedRevision: CURRENT,
      cacheRevision: CURRENT,
      loaderRevisionOption: CURRENT,
      status: 'accepted',
      selectedDevice: 'webgpu',
      selectedDtype: 'q4',
      observationMethod: 'production-cache-only-revision-runtime-preparation',
      error: undefined,
    });

    await acceptReusableDownloadedProductionRevisionsForDownload({
      inventory: cached,
      resolvedRevision: CURRENT,
      candidateOrderByRevision: { [CURRENT]: q4 },
    });

    expect(acceptDownloadedProductionRevision).toHaveBeenCalledWith(expect.objectContaining({
      cacheRevision: CURRENT,
      loadRevision: CURRENT,
      candidates: q4,
    }));
  });

  it('wires planned cache identity into the actual revision acceptance primitive', async () => {
    const cached = inventory([
      revision({ revision: 'main', kind: 'legacy-main', lastModified: 10 }),
      revision({ revision: CURRENT, kind: 'immutable-sha', lastModified: 20 }),
    ]);
    vi.mocked(acceptDownloadedProductionRevision).mockImplementation(async ({ cacheRevision, loadRevision }) => ({
      modelId: 'org/model',
      repositoryResolvedRevision: CURRENT,
      cacheRevision,
      loaderRevisionOption: loadRevision ?? null,
      status: 'accepted',
      selectedDevice: 'webgpu',
      selectedDtype: 'q4',
      observationMethod: 'production-cache-only-revision-runtime-preparation',
      error: undefined,
    }));

    const result = await acceptPlannedDownloadedProductionRevisions({
      inventory: cached,
      resolvedRevision: CURRENT,
    });

    expect(result.status).toBe('accepted');
    expect(acceptDownloadedProductionRevision).toHaveBeenCalledWith({
      modelId: 'org/model',
      repositoryResolvedRevision: CURRENT,
      cacheRevision: CURRENT,
      loadRevision: CURRENT,
      signal: undefined,
    });
  });
});
