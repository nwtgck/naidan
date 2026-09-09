import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProductionRuntimeStartupFixture, installProductionRuntimeStartupPlatform } from '@/features/transformers-js/runtime/fixtures/production-runtime-startup-fixture';

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

class MockWorker extends EventTarget {
  static production: MockWorker;
  private active = true;
  readonly startup = createProductionRuntimeStartupFixture({ emitFromWorker: ({ message }) => this.dispatchEvent(new MessageEvent('message', { data: message })) });
  readonly postMessage = vi.fn((message: unknown) => this.startup.acceptHostMessage({ message }));
  constructor(url: URL) {
    super();
    mocks.workerUrls.push(url);
    if (url.pathname.endsWith('/worker/bootstrap.ts')) {
      MockWorker.production = this;
      queueMicrotask(() => {
        if (this.active) this.startup.start();
      });
    }
  }

  terminate = () => {
    this.active = false; mocks.terminate();
  };
}

vi.stubGlobal('Worker', MockWorker);

describe('Download Verification dedicated Worker clients', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installProductionRuntimeStartupPlatform({ origin: 'http://localhost' });
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
    await MockWorker.production.startup.ready;

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

  it('does not send advisory release when the candidate Worker is disposed before ready', async () => {
    const { createDownloadVerificationCandidateAcceptanceWorkerClient } = await import('./candidate-acceptance-worker/client-hosted');
    const client = createDownloadVerificationCandidateAcceptanceWorkerClient();
    await client.dispose();
    await client.dispose();
    expect(mocks.wrap).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.terminate).toHaveBeenCalledOnce();
  });
});
