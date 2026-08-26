import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Comlink from 'comlink';

const { createStandaloneWorkerMock } = vi.hoisted(() => ({
  createStandaloneWorkerMock: vi.fn(),
}));

vi.mock('virtual:file-protocol-standalone/worker/file-explorer', () => ({
  createStandaloneWorker: createStandaloneWorkerMock,
}));

vi.mock('comlink', async (importOriginal) => {
  const original = await importOriginal<typeof import('comlink')>();
  return {
    ...original,
    wrap: vi.fn(),
  };
});

import { createFileExplorerWorkerClient } from './client-standalone';
import type { IFileExplorerWorker } from './types';

function createWorkerMock(): Worker {
  return {
    terminate: vi.fn(),
  } as unknown as Worker;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('standalone File Explorer Worker client lifecycle', () => {
  it('releases and terminates a Worker when prepareSession fails', async () => {
    const preparationError = new Error('prepare failed');
    const worker = createWorkerMock();
    const remote = {
      prepareSession: vi.fn().mockRejectedValue(preparationError),
      [Comlink.releaseProxy]: vi.fn().mockResolvedValue(undefined),
    } as unknown as Comlink.Remote<IFileExplorerWorker>;
    createStandaloneWorkerMock.mockResolvedValue(worker);
    vi.mocked(Comlink.wrap).mockReturnValue(remote);

    await expect(createFileExplorerWorkerClient({
      root: {
        kind: 'opfs-root',
        rootName: 'root',
      },
    })).rejects.toBe(preparationError);

    expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
