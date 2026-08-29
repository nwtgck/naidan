import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Comlink from 'comlink';
import { wrapWorkerRemote } from '@/utils/worker-transport';

const { createStandaloneWorkerMock } = vi.hoisted(() => ({
  createStandaloneWorkerMock: vi.fn(),
}));

vi.mock('virtual:file-protocol-standalone/worker/global-search', () => ({
  createStandaloneWorker: createStandaloneWorkerMock,
}));

vi.mock('@/utils/worker-transport', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/utils/worker-transport')>();
  return {
    ...original,
    wrapWorkerRemote: vi.fn(),
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
    vi.mocked(wrapWorkerRemote).mockReturnValue(remote);

    await expect(createGlobalSearchWorkerClient({
      storageType: 'opfs',
    })).rejects.toBe(configurationError);

    expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
