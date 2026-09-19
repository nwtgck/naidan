import { describe, expect, it, vi } from 'vitest';
import { completeDownloadVerificationRuntimeEvidence } from '@/features/transformers-js/download-verification/logic/complete-download-verification-runtime-evidence';
import type { DownloadVerificationEvidenceInput } from '@/features/transformers-js/download-verification/evidence/types';
import type { DownloadTimingCallback } from '@/features/transformers-js/download-timing';

const safetyMocks = vi.hoisted(() => ({
  runProductionDownloadPreparation: vi.fn(),
}));

vi.mock('@/features/transformers-js/download-verification/logic/run-production-download-preparation', () => ({
  runProductionDownloadPreparation: safetyMocks.runProductionDownloadPreparation,
}));

const REVISION = '1'.repeat(40);

function evidence(): DownloadVerificationEvidenceInput {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    mode: 'probe-only',
    run: {
      modelId: 'org/model',
      normalizedModelId: 'org/model',
      requestedRevision: 'main',
      resolvedRevision: REVISION,
      repositoryFileCount: 0,
      repositoryFiles: [],
      transportObservations: [],
      skippedModelArtifactCount: 0,
      bytesConsumed: 0,
      maximumBytes: 1024,
      startedAt: '2026-09-04T00:00:00.000Z',
      finishedAt: '2026-09-04T00:00:01.000Z',
    },
    modelArtifactObservations: [],
    modelArtifactObservationError: undefined,
    cacheBefore: undefined,
    cacheInspectionError: undefined,
  };
}

function inventory() {
  return { modelId: 'org/model', normalizedModelId: 'org/model', revisions: [] };
}

function acceptedReuse(args: {
  revision?: string,
  loadRevision?: string | undefined,
}) {
  const revision = args.revision ?? REVISION;
  const loadRevision = Object.prototype.hasOwnProperty.call(args, 'loadRevision')
    ? args.loadRevision
    : REVISION;
  return {
    reused: true as const,
    loadRevision,
    acceptance: {
      status: 'accepted' as const,
      selectedRevision: {
        revision,
        loaderRevisionOption: loadRevision,
        source: revision === 'main' ? 'legacy-main' as const : 'current-resolved-revision' as const,
      },
      attempts: [{
        candidate: {
          revision,
          loaderRevisionOption: loadRevision,
          source: revision === 'main' ? 'legacy-main' as const : 'current-resolved-revision' as const,
        },
        acceptance: {
          modelId: 'org/model',
          repositoryResolvedRevision: REVISION,
          cacheRevision: revision,
          loaderRevisionOption: loadRevision ?? null,
          status: 'accepted' as const,
          selectedDevice: 'webgpu' as const,
          selectedDtype: 'q4' as const,
          observationMethod: 'production-cache-only-revision-runtime-preparation' as const,
          error: undefined,
        },
      }],
      error: undefined,
    },
  };
}

describe('completeDownloadVerificationRuntimeEvidence', () => {
  it('retains only the current MSI acceptance timings without inventing an ordinary Download operation', async () => {
    let lateTiming: DownloadTimingCallback | undefined;
    const observation = { kind: 'acceptance' as const, version: 1 as const, route: 'revision' as const,
      revision: REVISION, clockId: '33333333-3333-4333-8333-333333333333', timingStatus: 'measured' as const,
      hostDurationMs: 23000, loadOutcome: 'accepted' as const, cleanupOutcome: 'completed' as const,
      hostSettlement: 'fulfilled' as const, attemptCount: 1 };
    const result = await completeDownloadVerificationRuntimeEvidence({
      evidence: evidence(), storageRoot: {} as FileSystemDirectoryHandle,
      reuseRevision: vi.fn(async ({ onTiming }) => {
        lateTiming = onTiming;
        onTiming?.({ observation });
        onTiming?.({ observation: { ...observation, hostDurationMs: -1 } });
        return acceptedReuse({});
      }),
      inspectCachedRevisions: vi.fn(async () => inventory()),
    });
    expect(result.runtimeCompletion?.status).toBe('accepted');
    expect(result.runtimeCompletion?.runtimeTiming).toEqual({
      format: 'msi-cache-acceptance-timing-v1', source: 'current-msi-cache-acceptance',
      runId: 'run-1', modelId: 'org/model', droppedObservations: 1, observations: [observation],
    });
    lateTiming?.({ observation: { ...observation, hostDurationMs: 90000 } });
    expect(result.runtimeCompletion?.runtimeTiming?.observations).toHaveLength(1);
    expect(safetyMocks.runProductionDownloadPreparation).not.toHaveBeenCalled();
  });
  it('reuses an accepted exact Production cache without any download preparation capability', async () => {
    const result = await completeDownloadVerificationRuntimeEvidence({
      evidence: evidence(),
      storageRoot: {} as FileSystemDirectoryHandle,
      reuseRevision: vi.fn(async () => acceptedReuse({})),
      inspectCachedRevisions: vi.fn(async () => inventory()),
    });

    expect(result.mode).toBe('runtime-complete');
    expect(result.runtimeCompletion).toMatchObject({
      status: 'accepted',
      source: 'reused-production-cache',
      cacheRevision: REVISION,
      loaderRevisionOption: REVISION,
      selectedCandidate: { device: 'webgpu', dtype: 'q4' },
      preparation: undefined,
    });
  });

  it('reuses Production-accepted legacy main only when that unverified identity is allowed', async () => {
    const result = await completeDownloadVerificationRuntimeEvidence({
      evidence: evidence(),
      storageRoot: {} as FileSystemDirectoryHandle,
      reuseRevision: vi.fn(async () => acceptedReuse({ revision: 'main', loadRevision: undefined })),
      inspectCachedRevisions: vi.fn(async () => inventory()),
    });

    expect(result.runtimeCompletion).toMatchObject({
      status: 'accepted',
      source: 'reused-production-cache',
      cacheRevision: 'main',
      loaderRevisionOption: null,
      selectedCandidate: { device: 'webgpu', dtype: 'q4' },
      preparation: undefined,
    });
  });

  it('blocks instead of downloading when an accepted legacy main cannot satisfy exact-revision policy', async () => {
    const result = await completeDownloadVerificationRuntimeEvidence({
      evidence: evidence(),
      storageRoot: {} as FileSystemDirectoryHandle,
      allowLegacyMainReuse: false,
      reuseRevision: vi.fn(async () => acceptedReuse({ revision: 'main', loadRevision: undefined })),
      inspectCachedRevisions: vi.fn(async () => inventory()),
    });

    expect(result.runtimeCompletion).toMatchObject({
      status: 'exhausted',
      source: 'cache-only-unavailable',
      cacheRevision: null,
      loaderRevisionOption: null,
      preparation: undefined,
      error: {
        name: 'ModelSupportInvestigationLocalCacheIncomplete',
      },
    });
  });

  it('passes repository-eligible local candidate constraints only to cache-only acceptance', async () => {
    const q4Candidates = [
      { device: 'webgpu' as const, dtype: 'q4' as const },
      { device: 'wasm' as const, dtype: 'q4' as const },
    ];
    const reusableByRevision = { [REVISION]: q4Candidates, main: [] };
    const reuseRevision = vi.fn(async () => ({ reused: false as const, acceptance: undefined }));

    const result = await completeDownloadVerificationRuntimeEvidence({
      evidence: evidence(),
      storageRoot: {} as FileSystemDirectoryHandle,
      reusableCandidateOrderByRevision: reusableByRevision,
      reuseRevision,
      inspectCachedRevisions: vi.fn(async () => inventory()),
    });

    expect(reuseRevision).toHaveBeenCalledWith(expect.objectContaining({
      modelId: 'org/model',
      resolvedRevision: REVISION,
      candidateOrderByRevision: reusableByRevision,
    }));
    expect(result.runtimeCompletion).toMatchObject({
      status: 'exhausted',
      source: 'cache-only-unavailable',
      preparation: undefined,
    });
  });

  it('records incomplete local cache as blocked runtime evidence instead of attempting a model download', async () => {
    safetyMocks.runProductionDownloadPreparation.mockClear();
    const result = await completeDownloadVerificationRuntimeEvidence({
      evidence: evidence(),
      storageRoot: {} as FileSystemDirectoryHandle,
      reuseRevision: vi.fn(async () => ({ reused: false as const, acceptance: undefined })),
      inspectCachedRevisions: vi.fn(async () => inventory()),
    });

    expect(result.runtimeCompletion).toMatchObject({
      status: 'exhausted',
      source: 'cache-only-unavailable',
      preparation: undefined,
      error: {
        name: 'ModelSupportInvestigationLocalCacheIncomplete',
        message: expect.stringContaining('does not download, resume, repair, or complete model weight artifacts'),
      },
    });
    expect(safetyMocks.runProductionDownloadPreparation).not.toHaveBeenCalled();
  });

  it('fails closed when cache-only acceptance itself cannot safely inspect the cache', async () => {
    const result = await completeDownloadVerificationRuntimeEvidence({
      evidence: evidence(),
      storageRoot: {} as FileSystemDirectoryHandle,
      reuseRevision: vi.fn(async () => {
        throw new Error('CachedRevisionRuntimeRejected: bad cache');
      }),
      inspectCachedRevisions: vi.fn(async () => inventory()),
    });

    expect(result.runtimeCompletion).toMatchObject({
      status: 'failed',
      source: 'cache-reuse-failed',
      preparation: undefined,
      error: { message: 'CachedRevisionRuntimeRejected: bad cache' },
    });
  });
});
