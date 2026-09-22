import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Comlink from 'comlink';
import { wrapWorkerRemote } from '@/utils/worker-transport';

const { createStandaloneWorkerMock } = vi.hoisted(() => ({
  createStandaloneWorkerMock: vi.fn(),
}));

vi.mock('virtual:file-protocol-standalone/worker/file-explorer', () => ({
  createStandaloneWorker: createStandaloneWorkerMock,
}));

vi.mock('@/utils/worker-transport', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/utils/worker-transport')>();
  return {
    ...original,
    wrapWorkerRemote: vi.fn(),
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
  vi.unstubAllGlobals();
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
    vi.mocked(wrapWorkerRemote).mockReturnValue(remote);

    await expect(createFileExplorerWorkerClient({
      root: {
        kind: 'opfs-root',
        rootName: 'root',
      },
    })).rejects.toBe(preparationError);

    expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    const host = vi.mocked(remote.prepareSession).mock.calls[0]![2]!;
    await expect(host.read({ blob: new Blob(['x']), offset: 0, length: 1 })).rejects.toBe(preparationError);
  });
  it.each(['resolve', 'reject'] as const)('retains the host until cleanup has its final %s and then ends its lifetime', async outcome => {
    vi.stubGlobal('Blob', NodeBlob);
    const worker = createWorkerMock();
    const cleanup = Promise.withResolvers<void>();
    const remote = {
      prepareSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      disposeSession: vi.fn(() => cleanup.promise),
      [Comlink.releaseProxy]: vi.fn().mockResolvedValue(undefined),
    } as unknown as Comlink.Remote<IFileExplorerWorker>;
    createStandaloneWorkerMock.mockResolvedValue(worker);
    vi.mocked(wrapWorkerRemote).mockReturnValue(remote);
    const client = await createFileExplorerWorkerClient({ root: { kind: 'opfs-root', rootName: 'root' } });
    const host = vi.mocked(remote.prepareSession).mock.calls[0]![2]!;
    const request = { blob: new Blob(['abc']), offset: 1, length: 1 };
    const ending = client.dispose();
    const done = Promise.allSettled([ending]);
    await vi.waitFor(() => expect(remote.disposeSession).toHaveBeenCalledOnce());
    expect(await host.read(request)).toEqual(new Uint8Array([98]));
    expect(worker.terminate).not.toHaveBeenCalled();
    if (outcome === 'resolve') cleanup.resolve();
    else cleanup.reject(new Error('Cleanup failed'));
    expect((await done)[0]?.status).toBe(outcome === 'resolve' ? 'fulfilled' : 'rejected');
    await expect(host.read(request)).rejects.toMatchObject({ name: 'AbortError' });
    expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

});
