import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  release: vi.fn(),
  wrap: vi.fn(),
  terminate: vi.fn(),
}));

vi.mock('@/utils/worker-transport', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/worker-transport')>(),
  releaseWorkerRemote: mocks.release,
  wrapWorkerRemote: mocks.wrap,
}));

class MockWorker {
  terminate = mocks.terminate;
}

vi.stubGlobal('Worker', MockWorker);

describe('Download Verification dedicated Worker clients', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    const clients = [
      createDownloadVerificationModelArtifactRequestWorkerClient(),
      createDownloadVerificationRuntimeArtifactPreparationWorkerClient(),
      createDownloadVerificationCandidateAcceptanceWorkerClient(),
    ];

    for (const client of clients) {
      await expect(client.dispose()).resolves.toBeUndefined();
      await expect(client.dispose()).resolves.toBeUndefined();
    }

    expect(mocks.release).toHaveBeenCalledTimes(3);
    expect(mocks.terminate).toHaveBeenCalledTimes(3);
  });
});
