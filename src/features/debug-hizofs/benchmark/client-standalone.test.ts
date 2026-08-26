import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Comlink from 'comlink';

const { createStandaloneWorkerMock } = vi.hoisted(() => ({
  createStandaloneWorkerMock: vi.fn(),
}));

vi.mock('virtual:file-protocol-standalone/worker/hizofs-benchmark', () => ({
  createStandaloneWorker: createStandaloneWorkerMock,
}));

vi.mock('comlink', async (importOriginal) => {
  const original = await importOriginal<typeof import('comlink')>();
  return {
    ...original,
    wrap: vi.fn(),
  };
});

import { createHizoFSBenchmarkWorkerClient } from './client-standalone';
import type { IHizoFSBenchmarkWorker } from './worker-client';

afterEach(() => {
  vi.restoreAllMocks();
  createStandaloneWorkerMock.mockReset();
  vi.mocked(Comlink.wrap).mockReset();
});

describe('standalone HizoFS benchmark Worker client', () => {
  it('uses the dedicated standalone Worker session and terminates it once on disposal', async () => {
    const worker = { terminate: vi.fn() } as unknown as Worker;
    const remote = {
      cancelCurrentOperation: vi.fn(),
      cleanBenchmarkData: vi.fn(),
      runBenchmark: vi.fn(),
      [Comlink.releaseProxy]: vi.fn().mockResolvedValue(undefined),
    } as unknown as Comlink.Remote<IHizoFSBenchmarkWorker>;
    createStandaloneWorkerMock.mockResolvedValue(worker);
    vi.mocked(Comlink.wrap).mockReturnValue(remote);

    const client = await createHizoFSBenchmarkWorkerClient();
    await client.dispose();

    expect(createStandaloneWorkerMock).toHaveBeenCalledOnce();
    expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
