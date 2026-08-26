import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Comlink from 'comlink';

const { createStandaloneWorkerMock } = vi.hoisted(() => ({
  createStandaloneWorkerMock: vi.fn(),
}));

vi.mock('virtual:file-protocol-standalone/worker/global-search', () => ({
  createStandaloneWorker: createStandaloneWorkerMock,
}));

vi.mock('comlink', async (importOriginal) => {
  const original = await importOriginal<typeof import('comlink')>();
  return {
    ...original,
    wrap: vi.fn(),
  };
});

import { createGlobalSearchWorkerClient } from './client-standalone';
import type { IGlobalSearchWorker } from './types';

function createWorkerMock(): Worker {
  return {
    terminate: vi.fn(),
  } as unknown as Worker;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('standalone Global Search Worker client lifecycle', () => {
  it('releases and terminates a Worker when storage configuration fails', async () => {
    const configurationError = new Error('configure failed');
    const worker = createWorkerMock();
    const remote = {
      configureStorage: vi.fn().mockRejectedValue(configurationError),
      [Comlink.releaseProxy]: vi.fn().mockResolvedValue(undefined),
    } as unknown as Comlink.Remote<IGlobalSearchWorker>;
    createStandaloneWorkerMock.mockResolvedValue(worker);
    vi.mocked(Comlink.wrap).mockReturnValue(remote);

    await expect(createGlobalSearchWorkerClient({
      storageType: 'opfs',
    })).rejects.toBe(configurationError);

    expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
