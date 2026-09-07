import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  release: vi.fn(),
  wrap: vi.fn(),
  terminate: vi.fn(),
  workerUrls: [] as URL[],
}));

vi.mock('@/utils/worker-transport', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/worker-transport')>(),
  releaseWorkerRemote: mocks.release,
  wrapWorkerRemote: mocks.wrap,
}));

class MockWorker {
  constructor(url: URL) {
    mocks.workerUrls.push(url);
  }

  terminate = mocks.terminate;
}

vi.stubGlobal('Worker', MockWorker);

describe('Download Verification dedicated Worker clients', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workerUrls.length = 0;
    mocks.wrap.mockReturnValue({});
    mocks.release.mockReturnValue(new Promise<never>(() => undefined));
  });

  it('terminates every dedicated Worker without waiting for a hung remote release', async () => {
    const { createDownloadVerificationModelArtifactRequestWorkerClient } = await import(
      './model-artifact-request-worker/client-hosted'
    );
    const { createDownloadVerificationRuntimeArtifactPreparationWorkerClient } = await import(
      './runtime-artifact-preparation-worker/client-hosted'
    );
    const { createDownloadVerificationCandidateAcceptanceWorkerClient } = await import(
      './candidate-acceptance-worker/client-hosted'
    );
    const { createTransformersJsDownloadWorkerClient } = await import(
      './download-worker/client-hosted'
    );

    const clients = [
      createDownloadVerificationModelArtifactRequestWorkerClient(),
      createDownloadVerificationRuntimeArtifactPreparationWorkerClient(),
      createDownloadVerificationCandidateAcceptanceWorkerClient(),
      createTransformersJsDownloadWorkerClient(),
    ];

    for (const client of clients) {
      await expect(client.dispose()).resolves.toBeUndefined();
      await expect(client.dispose()).resolves.toBeUndefined();
    }

    expect(mocks.release).toHaveBeenCalledTimes(4);
    expect(mocks.terminate).toHaveBeenCalledTimes(4);
    expect(mocks.workerUrls.map(url => url.pathname)).toEqual([
      expect.stringMatching(/\/model-artifact-request-worker\/entry\.ts$/u),
      expect.stringMatching(/\/download-worker\/entry\.ts$/u),
      expect.stringMatching(/\/worker\/bootstrap\.ts$/u),
      expect.stringMatching(/\/download-worker\/entry\.ts$/u),
    ]);
  });
});
