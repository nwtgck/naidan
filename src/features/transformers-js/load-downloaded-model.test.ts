import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('does not scan, prefetch, or download when the requested model is absent from OPFS', async () => {
    const { transformersJsService } = await import('./index-hosted');

    await transformersJsService.loadDownloadedModel({ modelId: 'org/not-downloaded' });

    expect(mocks.loadDownloadedModel).toHaveBeenCalledWith({
      modelId: 'org/not-downloaded',
      progressCallback: expect.any(Function),
    });
    expect(mocks.createScannerClient).not.toHaveBeenCalled();
    expect(mocks.prefetchUrls).not.toHaveBeenCalled();
    expect(mocks.downloadModel).not.toHaveBeenCalled();
  });
});
