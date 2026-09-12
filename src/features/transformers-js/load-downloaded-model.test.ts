import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createWorkerClient: vi.fn(),
  createScannerClient: vi.fn(),
  loadDownloadedModel: vi.fn(),
  downloadModel: vi.fn(),
  prefetchUrls: vi.fn(),
}));

vi.mock('@/features/transformers-js/worker/client', () => ({
  createTransformersJsWorkerClient: mocks.createWorkerClient,
}));

vi.mock('@/features/transformers-js/scanner/worker/client', () => ({
  createTransformersJsScannerWorkerClient: mocks.createScannerClient,
}));

function missingModelsRoot() {
  return {
    getDirectoryHandle: vi.fn().mockRejectedValue(new DOMException('missing', 'NotFoundError')),
  };
}

describe('loadDownloadedModel download boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.loadDownloadedModel.mockResolvedValue({ device: 'webgpu' });
    mocks.createWorkerClient.mockReturnValue({
      loadDownloadedModel: mocks.loadDownloadedModel,
      downloadModel: mocks.downloadModel,
      prefetchUrls: mocks.prefetchUrls,
      dispose: vi.fn(),
    });
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn().mockResolvedValue(missingModelsRoot()) },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('delegates cache-only loading to the Worker without host scanning, prefetch, or download', async () => {
    const { transformersJsService } = await import('./index-hosted');

    await transformersJsService.loadDownloadedModel({ modelId: 'org/not-downloaded' });

    expect(mocks.loadDownloadedModel).toHaveBeenCalledExactlyOnceWith({
      modelId: 'org/not-downloaded',
      revisionSelection: { kind: 'discover-cached' },
      progressCallback: expect.any(Function),
    });
    expect(mocks.createScannerClient).not.toHaveBeenCalled();
    expect(mocks.prefetchUrls).not.toHaveBeenCalled();
    expect(mocks.downloadModel).not.toHaveBeenCalled();
  });

  it('propagates the Worker missing-cache error without network, storage writes, or download fallback', async () => {
    const missing = new DOMException('Model is not downloaded', 'NotFoundError');
    mocks.loadDownloadedModel.mockRejectedValueOnce(missing);
    const root = missingModelsRoot();
    const getDirectory = vi.fn().mockResolvedValue(root);
    const fetch = vi.fn().mockRejectedValue(new Error('Unexpected Load network access'));
    vi.stubGlobal('navigator', { storage: { getDirectory } });
    vi.stubGlobal('fetch', fetch);
    const { transformersJsService } = await import('./index-hosted');

    await expect(transformersJsService.loadDownloadedModel({ modelId: 'org/not-downloaded' })).rejects.toBe(missing);

    expect(mocks.loadDownloadedModel).toHaveBeenCalledExactlyOnceWith({
      modelId: 'org/not-downloaded',
      revisionSelection: { kind: 'discover-cached' },
      progressCallback: expect.any(Function),
    });
    expect(transformersJsService.getState()).toMatchObject({ status: 'error', error: 'NotFoundError: Model is not downloaded', activeModelId: undefined });
    expect(getDirectory).not.toHaveBeenCalled();
    expect(root.getDirectoryHandle).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.createScannerClient).not.toHaveBeenCalled();
    expect(mocks.prefetchUrls).not.toHaveBeenCalled();
    expect(mocks.downloadModel).not.toHaveBeenCalled();
  });
});
