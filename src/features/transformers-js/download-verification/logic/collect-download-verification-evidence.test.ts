import { describe, expect, it, vi } from 'vitest';
import { collectDownloadVerificationEvidence } from '@/features/transformers-js/download-verification/logic/collect-download-verification-evidence';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function run() {
  return {
    modelId: 'org/model',
    normalizedModelId: 'org/model',
    requestedRevision: 'main' as const,
    resolvedRevision: SHA,
    repositoryFileCount: 1,
    repositoryFiles: [{
      path: 'onnx/model_q4.onnx',
      size: 10,
      blobId: undefined,
      lfsOid: undefined,
      lfsSha256: undefined,
      lfsSize: undefined,
    }],
    transportObservations: [],
    skippedModelArtifactCount: 0,
    bytesConsumed: 0,
    maximumBytes: 1024,
    startedAt: '2026-09-04T00:00:00.000Z',
    finishedAt: '2026-09-04T00:00:01.000Z',
  };
}

describe('collectDownloadVerificationEvidence', () => {
  it('collects repository, cache, and actual artifact-request observations under one run id', async () => {
    const runBrowserVerification = vi.fn(async () => run());
    const inspectCachedRevisions = vi.fn(async () => ({ modelId: 'org/model', normalizedModelId: 'org/model', revisions: [] }));
    const observeModelArtifactRequests = vi.fn(async () => []);
    const storageRoot = {} as FileSystemDirectoryHandle;

    const result = await collectDownloadVerificationEvidence({
      modelId: 'org/model',
      runId: 'run-1',
      resolvedRepository: {
        modelId: 'org/model',
        normalizedModelId: 'org/model',
        requestedRevision: 'main',
        resolvedRevision: SHA,
        repositoryFiles: run().repositoryFiles,
      },
      storageRoot,
      runBrowserVerification,
      inspectCachedRevisions,
      observeModelArtifactRequests,
    });

    expect(result.runId).toBe('run-1');
    expect(result.run.resolvedRevision).toBe(SHA);
    expect(runBrowserVerification).toHaveBeenCalledWith(expect.objectContaining({
      resolvedRepository: expect.objectContaining({ resolvedRevision: SHA }),
    }));
    expect(inspectCachedRevisions).toHaveBeenCalledWith({ modelId: 'org/model', storageRoot });
    expect(observeModelArtifactRequests).toHaveBeenCalledWith({
      modelId: 'org/model',
      revision: SHA,
      signal: undefined,
    });
  });

  it('preserves non-fatal cache and observation failures as evidence', async () => {
    const result = await collectDownloadVerificationEvidence({
      modelId: 'org/model',
      runId: 'run-2',
      storageRoot: {} as FileSystemDirectoryHandle,
      runBrowserVerification: vi.fn(async () => run()),
      inspectCachedRevisions: vi.fn(async () => {
        throw new Error('opfs unavailable');
      }),
      observeModelArtifactRequests: vi.fn(async () => {
        throw new Error('observer unavailable');
      }),
    });

    expect(result.cacheBefore).toBeUndefined();
    expect(result.cacheInspectionError).toBe('opfs unavailable');
    expect(result.modelArtifactObservations).toEqual([]);
    expect(result.modelArtifactObservationError).toBe('observer unavailable');
  });
});
