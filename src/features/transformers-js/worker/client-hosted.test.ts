import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProductionRuntimeStartupFixture, installProductionRuntimeStartupPlatform } from '@/features/transformers-js/runtime/fixtures/production-runtime-startup-fixture';

const mocks = vi.hoisted(() => ({
  release: vi.fn(),
  wrap: vi.fn(),
  terminate: vi.fn(),
  workerConstructor: vi.fn(),
}));

vi.mock('@/utils/worker-transport', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/worker-transport')>(),
  releaseWorkerRemote: mocks.release,
  wrapWorkerRemote: mocks.wrap,
}));

class MockWorker extends EventTarget {
  static latest: MockWorker;
  constructor(url: URL, options: WorkerOptions) {
    super();
    mocks.workerConstructor(url, options);
    MockWorker.latest = this;
  }

  terminate = mocks.terminate;
  readonly startup = createProductionRuntimeStartupFixture({ emitFromWorker: ({ message }) => this.dispatchEvent(new MessageEvent('message', { data: message })) });
  postMessage(message: unknown) {
    this.startup.acceptHostMessage({ message });
  }
  async publishReady() {
    this.startup.start(); await this.startup.ready;
  }
}

vi.stubGlobal('Worker', MockWorker);

describe('Transformers.js Worker client cleanup', () => {
  beforeEach(() => {
    installProductionRuntimeStartupPlatform({ origin: 'http://localhost' });
    vi.clearAllMocks();
    mocks.wrap.mockReturnValue({});
  });

  it('terminates without waiting for a hung remote release', async () => {
    mocks.release.mockReturnValue(new Promise<never>(() => undefined));
    const { createTransformersJsWorkerClient } = await import('./client-hosted');
    const client = createTransformersJsWorkerClient();
    await MockWorker.latest.publishReady();

    await expect(client.dispose()).resolves.toBeUndefined();

    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.terminate).toHaveBeenCalledOnce();
  });

  it('starts through the offline bootstrap instead of evaluating the runtime entry directly', async () => {
    const { createTransformersJsWorkerClient } = await import('./client-hosted');
    const client = createTransformersJsWorkerClient();

    expect(mocks.workerConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: expect.stringMatching(/\/worker\/bootstrap\.ts$/u) }),
      { type: 'module' },
    );
    await client.dispose();
  });

  it('still terminates when remote release throws synchronously', async () => {
    mocks.release.mockImplementation(() => {
      throw new Error('release failed');
    });
    const { createTransformersJsWorkerClient } = await import('./client-hosted');
    const client = createTransformersJsWorkerClient();
    await MockWorker.latest.publishReady();

    await expect(client.dispose()).resolves.toBeUndefined();

    expect(mocks.terminate).toHaveBeenCalledOnce();
  });
});
