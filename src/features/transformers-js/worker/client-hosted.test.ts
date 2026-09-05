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

describe('Transformers.js Worker client cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.wrap.mockReturnValue({});
  });

  it('terminates without waiting for a hung remote release', async () => {
    mocks.release.mockReturnValue(new Promise<never>(() => undefined));
    const { createTransformersJsWorkerClient } = await import('./client-hosted');
    const client = createTransformersJsWorkerClient();

    await expect(client.dispose()).resolves.toBeUndefined();

    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.terminate).toHaveBeenCalledOnce();
  });

  it('still terminates when remote release throws synchronously', async () => {
    mocks.release.mockImplementation(() => {
      throw new Error('release failed');
    });
    const { createTransformersJsWorkerClient } = await import('./client-hosted');
    const client = createTransformersJsWorkerClient();

    await expect(client.dispose()).resolves.toBeUndefined();

    expect(mocks.terminate).toHaveBeenCalledOnce();
  });
});
