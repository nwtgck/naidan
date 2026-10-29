import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Comlink from 'comlink';
import { wrapWorkerRemote } from '@/utils/worker-transport';
import { toVolumeId } from '@/01-models/ids';

const { createStandaloneWorkerMock, createManagedVolumeAccessMock } = vi.hoisted(() => ({
  createStandaloneWorkerMock: vi.fn(),
  createManagedVolumeAccessMock: vi.fn(),
}));

vi.mock('@/00-storage/service', () => ({
  storageService: { createManagedVolumeAccess: createManagedVolumeAccessMock },
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
  return Object.assign(new EventTarget(), {
    terminate: vi.fn(),
  }) as unknown as Worker;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('standalone File Explorer Worker client lifecycle', () => {
  it('releases managed grants and the standalone session when preparation fails', async () => {
    const preparationError = new Error('managed prepare failed');
    const worker = createWorkerMock();
    const grant = {
      root: { id: 'root', kind: 'directory', name: 'Documents' },
      access: { request: vi.fn() },
      dispose: vi.fn(async () => {}),
    };
    createManagedVolumeAccessMock.mockResolvedValueOnce(grant);
    const remote = {
      prepareSession: vi.fn().mockRejectedValue(preparationError),
      [Comlink.releaseProxy]: vi.fn().mockResolvedValue(undefined),
    } as unknown as Comlink.Remote<IFileExplorerWorker>;
    createStandaloneWorkerMock.mockResolvedValueOnce(worker);
    vi.mocked(wrapWorkerRemote).mockReturnValueOnce(remote);

    await expect(createFileExplorerWorkerClient({
      root: {
        kind: 'wesh-mounts',
        rootName: 'Documents',
        mounts: [{ type: 'managed_directory', path: '/documents', reference: { volumeId: toVolumeId({ raw: 'managed' }) }, readOnly: true }],
      },
    })).rejects.toBe(preparationError);

    expect(vi.mocked(remote.prepareSession).mock.calls[0]).toHaveLength(3);
    expect(grant.dispose).toHaveBeenCalledOnce();
    expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('revokes managed access on runtime failure and releases its session on disposal', async () => {
    const worker = createWorkerMock();
    const reference = { volumeId: toVolumeId({ raw: 'managed' }) };
    const grant = {
      root: { id: 'root', kind: 'directory', name: 'Documents' },
      access: { request: vi.fn() },
      dispose: vi.fn(async () => {}),
    };
    createManagedVolumeAccessMock.mockResolvedValueOnce(grant);
    const remote = {
      prepareSession: vi.fn().mockResolvedValue({ sessionId: 'session' }),
      disposeSession: vi.fn().mockResolvedValue(undefined),
      [Comlink.releaseProxy]: vi.fn().mockResolvedValue(undefined),
    } as unknown as Comlink.Remote<IFileExplorerWorker>;
    createStandaloneWorkerMock.mockResolvedValueOnce(worker);
    vi.mocked(wrapWorkerRemote).mockReturnValueOnce(remote);
    const client = await createFileExplorerWorkerClient({
      root: {
        kind: 'wesh-mounts',
        rootName: 'Documents',
        mounts: [{ type: 'managed_directory', path: '/documents', reference, readOnly: false }],
      },
    });
    {
      await using _cleanup = {
        async [Symbol.asyncDispose]() {
          await client.dispose();
        },
      };
      expect(createManagedVolumeAccessMock).toHaveBeenCalledWith({ reference, readOnly: false });
      const access = vi.mocked(remote.prepareSession).mock.calls[0]?.[2];
      expect(await access!.getRoot({ path: '/documents' })).toEqual(grant.root);
      worker.dispatchEvent(new Event('messageerror'));
      await expect(access!.getRoot({ path: '/documents' })).rejects.toMatchObject({ name: 'InvalidStateError' });
    }
    expect(grant.dispose).toHaveBeenCalledOnce();
    expect(remote.disposeSession).toHaveBeenCalledWith({ request: { sessionId: 'session' } });
    expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

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
  });
});
