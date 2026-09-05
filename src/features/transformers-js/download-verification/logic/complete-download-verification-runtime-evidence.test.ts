import { describe, expect, it, vi } from 'vitest';
import { completeDownloadVerificationRuntimeEvidence } from '@/features/transformers-js/download-verification/logic/complete-download-verification-runtime-evidence';
import type { DownloadVerificationEvidenceInput } from '@/features/transformers-js/download-verification/evidence/types';

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

describe('completeDownloadVerificationRuntimeEvidence', () => {
  it('reuses an accepted Production cache without running download preparation', async () => {
    const runPreparation = vi.fn();
    const result = await completeDownloadVerificationRuntimeEvidence({
      evidence: evidence(),
      storageRoot: {} as FileSystemDirectoryHandle,
      reuseRevision: vi.fn(async () => ({
        reused: true as const,
        loadRevision: REVISION,
        acceptance: {
          status: 'accepted' as const,
          selectedRevision: { revision: REVISION, loaderRevisionOption: REVISION, source: 'current-resolved-revision' as const },
          attempts: [{
            candidate: { revision: REVISION, loaderRevisionOption: REVISION, source: 'current-resolved-revision' as const },
            acceptance: {
              modelId: 'org/model',
              repositoryResolvedRevision: REVISION,
              cacheRevision: REVISION,
              loaderRevisionOption: REVISION,
              status: 'accepted' as const,
              selectedDevice: 'webgpu' as const,
              selectedDtype: 'q4' as const,
              observationMethod: 'production-cache-only-revision-runtime-preparation' as const,
              error: undefined,
            },
          }],
          error: undefined,
        },
      })),
      runPreparation,
      inspectCachedRevisions: vi.fn(async () => inventory()),
    });

    expect(result.mode).toBe('runtime-complete');
    expect(result.runtimeCompletion).toMatchObject({
      status: 'accepted',
      source: 'reused-production-cache',
      cacheRevision: REVISION,
      loaderRevisionOption: REVISION,
      selectedCandidate: { device: 'webgpu', dtype: 'q4' },
    });
    expect(runPreparation).not.toHaveBeenCalled();
  });

  it('reuses Production-accepted legacy main without claiming exact frozen-revision identity', async () => {
    const runPreparation = vi.fn();
    const result = await completeDownloadVerificationRuntimeEvidence({
      evidence: evidence(),
      storageRoot: {} as FileSystemDirectoryHandle,
      reuseRevision: vi.fn(async () => ({
        reused: true as const,
        loadRevision: undefined,
        acceptance: {
          status: 'accepted' as const,
          selectedRevision: { revision: 'main', loaderRevisionOption: undefined, source: 'legacy-main' as const },
          attempts: [{
            candidate: { revision: 'main', loaderRevisionOption: undefined, source: 'legacy-main' as const },
            acceptance: {
              modelId: 'org/model',
              repositoryResolvedRevision: REVISION,
              cacheRevision: 'main',
              loaderRevisionOption: null,
              status: 'accepted' as const,
              selectedDevice: 'webgpu' as const,
              selectedDtype: 'q4' as const,
              observationMethod: 'production-cache-only-revision-runtime-preparation' as const,
              error: undefined,
            },
          }],
          error: undefined,
        },
      })),
      runPreparation,
      inspectCachedRevisions: vi.fn(async () => inventory()),
    });

    expect(result.runtimeCompletion).toMatchObject({
      status: 'accepted',
      source: 'reused-production-cache',
      cacheRevision: 'main',
      loaderRevisionOption: null,
      selectedCandidate: { device: 'webgpu', dtype: 'q4' },
    });
    expect(runPreparation).not.toHaveBeenCalled();
  });

  it('prepares the frozen exact revision when MSI disallows a mismatched legacy main reuse', async () => {
    const runPreparation = vi.fn(async () => ({
      status: 'accepted' as const,
      failureStage: undefined,
      runtimeArtifacts: {
        modelId: 'org/model', revision: REVISION, status: 'prepared' as const, processor: 'tokenizer' as const,
        modelType: 'test', observationMethod: 'transformers-runtime-artifact-preparation' as const, error: undefined,
      },
      candidates: {
        status: 'accepted' as const,
        selectedCandidate: { device: 'webgpu' as const, dtype: 'q4' as const },
        attempts: [],
        error: undefined,
      },
    }));
    const result = await completeDownloadVerificationRuntimeEvidence({
      evidence: evidence(),
      storageRoot: {} as FileSystemDirectoryHandle,
      allowLegacyMainReuse: false,
      reuseRevision: vi.fn(async () => ({
        reused: true as const,
        loadRevision: undefined,
        acceptance: {
          status: 'accepted' as const,
          selectedRevision: { revision: 'main', loaderRevisionOption: undefined, source: 'legacy-main' as const },
          attempts: [],
          error: undefined,
        },
      })),
      runPreparation,
      inspectCachedRevisions: vi.fn(async () => inventory()),
    });

    expect(runPreparation).toHaveBeenCalledTimes(1);
    expect(result.runtimeCompletion).toMatchObject({
      status: 'accepted',
      source: 'production-download-preparation',
      cacheRevision: REVISION,
      loaderRevisionOption: REVISION,
    });
  });

  it('prepares the frozen exact revision once when no reusable cache exists', async () => {
    const runPreparation = vi.fn(async () => ({
      status: 'accepted' as const,
      failureStage: undefined,
      runtimeArtifacts: {
        modelId: 'org/model', revision: REVISION, status: 'prepared' as const, processor: 'tokenizer' as const,
        modelType: 'test', observationMethod: 'transformers-runtime-artifact-preparation' as const, error: undefined,
      },
      candidates: {
        status: 'accepted' as const,
        selectedCandidate: { device: 'webgpu' as const, dtype: 'q4' as const },
        attempts: [],
        error: undefined,
      },
    }));
    const result = await completeDownloadVerificationRuntimeEvidence({
      evidence: evidence(),
      storageRoot: {} as FileSystemDirectoryHandle,
      reuseRevision: vi.fn(async () => ({ reused: false as const, acceptance: undefined })),
      runPreparation,
      inspectCachedRevisions: vi.fn(async () => inventory()),
    });

    expect(runPreparation).toHaveBeenCalledTimes(1);
    expect(runPreparation).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'org/model', revision: REVISION }));
    expect(result.runtimeCompletion).toMatchObject({
      status: 'accepted',
      source: 'production-download-preparation',
      cacheRevision: REVISION,
      loaderRevisionOption: REVISION,
      selectedCandidate: { device: 'webgpu', dtype: 'q4' },
    });
  });

  it('does not run expensive preparation when cache reuse fails closed', async () => {
    const runPreparation = vi.fn();
    const result = await completeDownloadVerificationRuntimeEvidence({
      evidence: evidence(),
      storageRoot: {} as FileSystemDirectoryHandle,
      reuseRevision: vi.fn(async () => {
        throw new Error('CachedRevisionRuntimeRejected: bad cache');
      }),
      runPreparation,
      inspectCachedRevisions: vi.fn(async () => inventory()),
    });

    expect(runPreparation).not.toHaveBeenCalled();
    expect(result.runtimeCompletion).toMatchObject({
      status: 'failed',
      source: 'cache-reuse-failed',
      error: { message: 'CachedRevisionRuntimeRejected: bad cache' },
    });
  });

  it('preserves exhausted preparation as runtime-complete evidence', async () => {
    const result = await completeDownloadVerificationRuntimeEvidence({
      evidence: evidence(),
      storageRoot: {} as FileSystemDirectoryHandle,
      reuseRevision: vi.fn(async () => ({ reused: false as const, acceptance: undefined })),
      runPreparation: vi.fn(async () => ({
        status: 'exhausted' as const,
        failureStage: undefined,
        runtimeArtifacts: {
          modelId: 'org/model', revision: REVISION, status: 'prepared' as const, processor: 'tokenizer' as const,
          modelType: 'test', observationMethod: 'transformers-runtime-artifact-preparation' as const, error: undefined,
        },
        candidates: { status: 'exhausted' as const, selectedCandidate: undefined, attempts: [], error: undefined },
      })),
      inspectCachedRevisions: vi.fn(async () => inventory()),
    });

    expect(result.runtimeCompletion).toMatchObject({
      status: 'exhausted',
      source: 'production-download-preparation',
      error: { name: 'ProductionDownloadPreparationExhausted' },
    });
  });
});
