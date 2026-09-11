import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProductionRuntimeStartupFixture, installProductionRuntimeStartupPlatform } from '@/features/transformers-js/runtime/fixtures/production-runtime-startup-fixture';
import type { ITransformersJsDownloadWorker } from '@/features/transformers-js/types';

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
  static latest: MockWorker;
  private active = true;
  readonly startup = createProductionRuntimeStartupFixture({ emitFromWorker: ({ message }) => this.dispatchEvent(new MessageEvent('message', { data: message })) });
  readonly postMessage = vi.fn((message: unknown) => this.startup.acceptHostMessage({ message }));
  constructor(url: URL) {
    super();
    MockWorker.latest = this;
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

  it('rejects pending metadata preparation and physically terminates on Worker startup error', async () => {
    const prepare = vi.fn(() => new Promise<never>(() => undefined));
    mocks.wrap.mockReturnValue({ prepareModelRuntimeArtifacts: prepare });
    const { createDownloadVerificationRuntimeArtifactPreparationWorkerClient } = await import('./runtime-artifact-preparation-worker/client-hosted');
    const client = createDownloadVerificationRuntimeArtifactPreparationWorkerClient();
    const failure = new Error('Metadata Worker module import failed');
    const pending = client.prepareModelRuntimeArtifacts({ modelId: 'fixture/model', revision: 'a'.repeat(40), progressCallback: vi.fn() });
    MockWorker.latest.dispatchEvent(new ErrorEvent('error', { error: failure, message: failure.message }));
    try {
      await expect(pending).rejects.toBe(failure);
      expect(mocks.terminate).toHaveBeenCalledOnce();
    } finally {
      await client.dispose();
    }
  });

  it('rejects pending artifact observation on an undecodable Worker message', async () => {
    mocks.wrap.mockReturnValue({ observeModelArtifactRequests: vi.fn(() => new Promise<never>(() => undefined)) });
    const { createDownloadVerificationModelArtifactRequestWorkerClient } = await import('./model-artifact-request-worker/client-hosted');
    const client = createDownloadVerificationModelArtifactRequestWorkerClient();
    const pending = client.observeModelArtifactRequests({ modelId: 'fixture/model', revision: 'a'.repeat(40), candidate: { device: 'webgpu', dtype: 'q4' } });
    MockWorker.latest.dispatchEvent(new MessageEvent('messageerror'));
    try {
      await expect(pending).rejects.toThrow('could not be decoded');
      expect(mocks.terminate).toHaveBeenCalledOnce();
    } finally {
      await client.dispose();
    }
  });

  it('settles pending prefetch on disposal and refuses later operations', async () => {
    const prefetch = vi.fn(() => new Promise<never>(() => undefined));
    mocks.wrap.mockReturnValue({ prefetchUrls: prefetch });
    const { createTransformersJsDownloadWorkerClient } = await import('./download-worker/client-hosted');
    const client = createTransformersJsDownloadWorkerClient();
    const pending = client.prefetchUrls({ urls: ['https://huggingface.co/fixture/model/resolve/main/onnx/model.onnx'], progressCallback: vi.fn() });
    const rejected = expect(pending).rejects.toThrow('disposed');
    await client.dispose();
    await rejected;
    await expect(client.prefetchUrls({ urls: [], progressCallback: vi.fn() })).rejects.toThrow('disposed');
    expect(prefetch).toHaveBeenCalledOnce();
    expect(mocks.terminate).toHaveBeenCalledOnce();
  });

  it('terminates the newly allocated Worker if creating its RPC proxy throws', async () => {
    const failure = new Error('Proxy construction failed');
    mocks.wrap.mockImplementation(() => {
      throw failure;
    });
    const { createTransformersJsDownloadWorkerClient } = await import('./download-worker/client-hosted');
    expect(() => createTransformersJsDownloadWorkerClient()).toThrow(failure);
    expect(mocks.terminate).toHaveBeenCalledOnce();
  });

  it('stops a retained progress proxy after fatal disposal and preserves the original failure', async () => {
    const prefetch = vi.fn<ITransformersJsDownloadWorker['prefetchUrls']>(() => new Promise<never>(() => undefined));
    mocks.wrap.mockReturnValue({ prefetchUrls: prefetch });
    const { createTransformersJsDownloadWorkerClient } = await import('./download-worker/client-hosted');
    const client = createTransformersJsDownloadWorkerClient();
    const progressCallback = vi.fn();
    const pending = client.prefetchUrls({ urls: [], progressCallback });
    const callback = prefetch.mock.calls[0]![1];
    callback({ status: 'initiate', file: 'model.onnx' });
    expect(progressCallback).toHaveBeenCalledExactlyOnceWith({ info: { status: 'initiate', file: 'model.onnx' } });
    const failure = new Error('Download Worker stopped after progress');
    MockWorker.latest.dispatchEvent(new ErrorEvent('error', { error: failure, message: failure.message }));
    await expect(pending).rejects.toBe(failure);
    await client.dispose();
    callback({ status: 'done', file: 'model.onnx' });
    await expect(client.prefetchUrls({ urls: [], progressCallback })).rejects.toBe(failure);
    MockWorker.latest.dispatchEvent(new MessageEvent('messageerror'));
    expect(progressCallback).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenCalledOnce();
    expect(mocks.terminate).toHaveBeenCalledOnce();
  });
});
