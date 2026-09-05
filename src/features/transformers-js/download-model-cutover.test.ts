import { beforeEach, describe, expect, it, vi } from 'vitest';

const SHA = '0123456789abcdef0123456789abcdef01234567';

const mocks = vi.hoisted(() => ({
  createWorkerClient: vi.fn(),
  workerLoadDownloadedModel: vi.fn(),
  legacyWorkerDownloadModel: vi.fn(),
  resolveRevision: vi.fn(),
  runPreparation: vi.fn(),
  acceptCachedRevisions: vi.fn(),
  inspectCachedRevisions: vi.fn(),
  planCachedRevisions: vi.fn(),
}));

vi.mock('@/features/transformers-js/worker/client', () => ({
  createTransformersJsWorkerClient: mocks.createWorkerClient,
}));
vi.mock('@/features/transformers-js/download-verification/logic/resolve-public-hugging-face-revision', () => ({
  resolvePublicHuggingFaceRevision: mocks.resolveRevision,
}));
vi.mock('@/features/transformers-js/download-verification/logic/run-production-download-preparation', () => ({
  runProductionDownloadPreparation: mocks.runPreparation,
}));
vi.mock('@/features/transformers-js/download-verification/logic/run-cached-revision-acceptance-orchestration', () => ({
  acceptReusableDownloadedProductionRevisionsForDownload: mocks.acceptCachedRevisions,
}));
vi.mock('@/features/transformers-js/download-verification/logic/inspect-cached-revisions', () => ({
  inspectDownloadVerificationCachedRevisions: mocks.inspectCachedRevisions,
  planDownloadVerificationCachedRevisionLoadCandidates: mocks.planCachedRevisions,
}));

function storageRoot() {
  return {} as FileSystemDirectoryHandle;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.workerLoadDownloadedModel.mockResolvedValue({ device: 'webgpu' });
  mocks.createWorkerClient.mockReturnValue({
    loadDownloadedModel: mocks.workerLoadDownloadedModel,
    downloadModel: mocks.legacyWorkerDownloadModel,
    prefetchUrls: vi.fn(),
    unloadModel: vi.fn(),
    interrupt: vi.fn(),
    resetCache: vi.fn(),
    generateText: vi.fn(),
    dispose: vi.fn(),
  });
  mocks.resolveRevision.mockResolvedValue({
    normalizedModelId: 'org/model',
    requestedRevision: 'main',
    resolvedRevision: SHA,
  });
  mocks.runPreparation.mockResolvedValue({
    status: 'accepted',
    failureStage: undefined,
    runtimeArtifacts: { status: 'prepared' },
    candidates: { status: 'accepted', selectedCandidate: { device: 'webgpu', dtype: 'q4' }, attempts: [], error: undefined },
  });
  mocks.acceptCachedRevisions.mockResolvedValue({
    status: 'unavailable',
    selectedRevision: undefined,
    attempts: [],
    error: undefined,
  });
  mocks.inspectCachedRevisions.mockResolvedValue({
    modelId: 'org/model',
    normalizedModelId: 'org/model',
    revisions: [{ revision: SHA, kind: 'immutable-sha', status: 'committed-file-set' }],
  });
  mocks.planCachedRevisions.mockReturnValue([]);
  vi.stubGlobal('navigator', {
    storage: { getDirectory: vi.fn().mockResolvedValue(storageRoot()) },
  });
});

describe('user-facing Transformers.js download cutover', () => {
  it('downloads through Production preparation and immediately loads the same accepted exact revision', async () => {
    const { transformersJsService } = await import('./index-hosted');

    await transformersJsService.downloadModel({ modelId: 'org/model' });
    await transformersJsService.loadDownloadedModel({ modelId: 'org/model' });

    expect(mocks.resolveRevision).toHaveBeenCalledTimes(1);
    expect(mocks.resolveRevision).toHaveBeenCalledWith({ modelId: 'org/model' });
    expect(mocks.runPreparation).toHaveBeenCalledWith({
      modelId: 'org/model',
      revision: SHA,
      progressCallback: expect.any(Function),
    });
    expect(mocks.legacyWorkerDownloadModel).not.toHaveBeenCalled();
    expect(mocks.inspectCachedRevisions).toHaveBeenCalledTimes(1);
    expect(mocks.planCachedRevisions).toHaveBeenCalledWith(expect.objectContaining({ resolvedRevision: SHA }));
    expect(mocks.acceptCachedRevisions).not.toHaveBeenCalled();
    expect(mocks.workerLoadDownloadedModel).toHaveBeenCalledWith({
      modelId: 'org/model',
      revision: SHA,
      progressCallback: expect.any(Function),
    });
  });

  it('selects the current exact cached revision after a fresh module load', async () => {
    mocks.planCachedRevisions.mockReturnValue([{
      revision: SHA,
      loaderRevisionOption: SHA,
      source: 'current-resolved-revision',
    }]);
    const { transformersJsService } = await import('./index-hosted');

    await transformersJsService.loadDownloadedModel({ modelId: 'org/model' });

    expect(mocks.inspectCachedRevisions).toHaveBeenCalledWith({
      modelId: 'org/model',
      storageRoot: expect.any(Object),
    });
    expect(mocks.resolveRevision).toHaveBeenCalledWith({ modelId: 'org/model' });
    expect(mocks.planCachedRevisions).toHaveBeenCalledWith(expect.objectContaining({
      resolvedRevision: SHA,
    }));
    expect(mocks.workerLoadDownloadedModel).toHaveBeenCalledWith({
      modelId: 'org/model',
      revision: SHA,
      progressCallback: expect.any(Function),
    });
  });

  it('reuses an accepted legacy main cache without downloading the model again', async () => {
    mocks.planCachedRevisions.mockReturnValue([{
      revision: 'main',
      loaderRevisionOption: undefined,
      source: 'legacy-main',
    }]);
    mocks.acceptCachedRevisions.mockResolvedValue({
      status: 'accepted',
      selectedRevision: {
        revision: 'main',
        loaderRevisionOption: undefined,
        source: 'legacy-main',
      },
      attempts: [],
      error: undefined,
    });
    const { transformersJsService } = await import('./index-hosted');

    await transformersJsService.downloadModel({ modelId: 'org/model' });
    await transformersJsService.loadDownloadedModel({ modelId: 'org/model' });

    expect(mocks.acceptCachedRevisions).toHaveBeenCalledWith(expect.objectContaining({
      resolvedRevision: SHA,
    }));
    expect(mocks.runPreparation).not.toHaveBeenCalled();
    expect(mocks.workerLoadDownloadedModel).toHaveBeenCalledWith({
      modelId: 'org/model',
      revision: undefined,
      progressCallback: expect.any(Function),
    });
  });

  it('reuses the current exact cached revision without model prefetch', async () => {
    mocks.planCachedRevisions.mockReturnValue([{
      revision: SHA,
      loaderRevisionOption: SHA,
      source: 'current-resolved-revision',
    }]);
    mocks.acceptCachedRevisions.mockResolvedValue({
      status: 'accepted',
      selectedRevision: {
        revision: SHA,
        loaderRevisionOption: SHA,
        source: 'current-resolved-revision',
      },
      attempts: [],
      error: undefined,
    });
    const { transformersJsService } = await import('./index-hosted');

    await transformersJsService.downloadModel({ modelId: 'org/model' });
    await transformersJsService.loadDownloadedModel({ modelId: 'org/model' });

    expect(mocks.runPreparation).not.toHaveBeenCalled();
    expect(mocks.workerLoadDownloadedModel).toHaveBeenCalledWith({
      modelId: 'org/model',
      revision: SHA,
      progressCallback: expect.any(Function),
    });
  });

  it('repairs an existing committed cache when Production acceptance exposes a missing artifact', async () => {
    mocks.planCachedRevisions.mockReturnValue([{
      revision: 'main',
      loaderRevisionOption: undefined,
      source: 'legacy-main',
    }]);
    mocks.acceptCachedRevisions.mockResolvedValue({
      status: 'exhausted',
      selectedRevision: undefined,
      attempts: [],
      error: undefined,
    });
    const { transformersJsService } = await import('./index-hosted');

    await transformersJsService.downloadModel({ modelId: 'org/model' });

    expect(mocks.runPreparation).toHaveBeenCalledWith({
      modelId: 'org/model',
      revision: SHA,
      progressCallback: expect.any(Function),
    });
  });

  it('fails before costly model preparation when cached-revision verification fails for an infrastructure reason', async () => {
    mocks.planCachedRevisions.mockReturnValue([{
      revision: 'main',
      loaderRevisionOption: undefined,
      source: 'legacy-main',
    }]);
    mocks.acceptCachedRevisions.mockResolvedValue({
      status: 'failed',
      selectedRevision: undefined,
      attempts: [],
      error: {
        name: 'RevisionAcceptanceIdentityMismatch',
        message: 'cache identity mismatch',
      },
    });
    const { transformersJsService } = await import('./index-hosted');

    await expect(transformersJsService.downloadModel({ modelId: 'org/model' }))
      .rejects.toThrow('RevisionAcceptanceIdentityMismatch: cache identity mismatch');
    expect(mocks.runPreparation).not.toHaveBeenCalled();
  });


  it('fails before costly model preparation when cached revision inventory cannot be inspected safely', async () => {
    mocks.inspectCachedRevisions.mockRejectedValue(new Error('OPFS inventory unavailable'));
    const { transformersJsService } = await import('./index-hosted');

    await expect(transformersJsService.downloadModel({ modelId: 'org/model' }))
      .rejects.toThrow('CachedRevisionInspectionFailed');
    expect(mocks.acceptCachedRevisions).not.toHaveBeenCalled();
    expect(mocks.runPreparation).not.toHaveBeenCalled();
    expect(mocks.legacyWorkerDownloadModel).not.toHaveBeenCalled();
  });

  it('does not report download success when no Production candidate is accepted', async () => {
    mocks.runPreparation.mockResolvedValue({
      status: 'exhausted',
      failureStage: undefined,
      runtimeArtifacts: { status: 'prepared' },
      candidates: { status: 'exhausted', selectedCandidate: undefined, attempts: [], error: undefined },
    });
    const { transformersJsService } = await import('./index-hosted');

    await expect(transformersJsService.downloadModel({ modelId: 'org/model' }))
      .rejects.toThrow('No Production model candidate could be downloaded and accepted');
    expect(transformersJsService.getState().status).toBe('error');
    expect(mocks.legacyWorkerDownloadModel).not.toHaveBeenCalled();
  });
});
