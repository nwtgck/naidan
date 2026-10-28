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

vi.mock('virtual:file-protocol-standalone/worker/wesh', () => ({
  createStandaloneWorker: createStandaloneWorkerMock,
}));

vi.mock('@/utils/worker-transport', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/utils/worker-transport')>();
  return {
    ...original,
    wrapWorkerRemote: vi.fn(),
  };
});

import { createFileProtocolCompatibleWeshWorkerClient } from './client-standalone';
import type { IWeshWorker } from './types';

function createWorkerMock(): Worker {
  return Object.assign(new EventTarget(), {
    terminate: vi.fn(),
  }) as unknown as Worker;
}

function createRemote({
  init,
  awaitExecution,
}: {
  init: () => Promise<void>,
  awaitExecution: () => Promise<{ exitCode: number }>,
}): Comlink.Remote<IWeshWorker> {
  return {
    init: vi.fn(init),
    preloadNextCommand: vi.fn().mockResolvedValue({ status: 'done' }),
    startExecution: vi.fn(),
    awaitExecution: vi.fn(awaitExecution),
    interruptExecution: vi.fn().mockResolvedValue(true),
    disposeExecution: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn(),
    getShellState: vi.fn(),
    listCommands: vi.fn(),
    listDirectory: vi.fn(),
    interrupt: vi.fn().mockResolvedValue(true),
    dispose: vi.fn().mockResolvedValue(undefined),
    [Comlink.releaseProxy]: vi.fn().mockResolvedValue(undefined),
  } as unknown as Comlink.Remote<IWeshWorker>;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('standalone Wesh Worker client lifecycle', () => {
  it('releases managed grants and the standalone session when initialization fails', async () => {
    const initializationError = new Error('managed init failed');
    const worker = createWorkerMock();
    const grant = {
      root: { id: 'root', kind: 'directory', name: 'Documents' },
      access: { request: vi.fn() },
      dispose: vi.fn(async () => {}),
    };
    createManagedVolumeAccessMock.mockResolvedValueOnce(grant);
    const remote = createRemote({
      init: async () => {
        throw initializationError;
      },
      awaitExecution: async () => ({ exitCode: 0 }),
    });
    createStandaloneWorkerMock.mockResolvedValueOnce(worker);
    vi.mocked(wrapWorkerRemote).mockReturnValueOnce(remote);

    await expect(createFileProtocolCompatibleWeshWorkerClient({
      rootHandle: 'readonly',
      mounts: [{ type: 'managed_directory', path: '/documents', reference: { volumeId: toVolumeId({ raw: 'managed' }) }, readOnly: true }],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    })).rejects.toBe(initializationError);

    expect(vi.mocked(remote.init).mock.calls[0]).toHaveLength(3);
    expect(grant.dispose).toHaveBeenCalledOnce();
    expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('revokes managed access on runtime failure and keeps final disposal idempotent', async () => {
    const worker = createWorkerMock();
    const reference = { volumeId: toVolumeId({ raw: 'managed' }) };
    const grant = {
      root: { id: 'root', kind: 'directory', name: 'Documents' },
      access: { request: vi.fn() },
      dispose: vi.fn(async () => {}),
    };
    createManagedVolumeAccessMock.mockResolvedValueOnce(grant);
    const remote = createRemote({ init: async () => {}, awaitExecution: async () => ({ exitCode: 0 }) });
    createStandaloneWorkerMock.mockResolvedValueOnce(worker);
    vi.mocked(wrapWorkerRemote).mockReturnValueOnce(remote);
    const client = await createFileProtocolCompatibleWeshWorkerClient({
      rootHandle: 'readonly',
      mounts: [{ type: 'managed_directory', path: '/documents', reference, readOnly: false }],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    });
    {
      await using _cleanup = {
        async [Symbol.asyncDispose]() {
          await client.dispose();
        },
      };
      expect(createManagedVolumeAccessMock).toHaveBeenCalledWith({ reference, readOnly: false });
      const access = vi.mocked(remote.init).mock.calls[0]?.[2];
      expect(await access!.getRoot({ path: '/documents' })).toEqual(grant.root);
      worker.dispatchEvent(new Event('error'));
      await expect(access!.getRoot({ path: '/documents' })).rejects.toMatchObject({ name: 'InvalidStateError' });
    }
    expect(grant.dispose).toHaveBeenCalledOnce();
    expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('releases and terminates a Worker when remote initialization fails', async () => {
    const initializationError = new Error('init failed');
    const worker = createWorkerMock();
    const remote = createRemote({
      init: async () => {
        throw initializationError;
      },
      awaitExecution: async () => ({ exitCode: 0 }),
    });
    createStandaloneWorkerMock.mockResolvedValue(worker);
    vi.mocked(wrapWorkerRemote).mockReturnValue(remote);

    await expect(createFileProtocolCompatibleWeshWorkerClient({
      rootHandle: 'readonly',
      mounts: [],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    })).rejects.toBe(initializationError);

    expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('replaces and terminates a Worker whose cancelled execution never settles', async () => {
    vi.useFakeTimers();
    const firstWorker = createWorkerMock();
    const replacementWorker = createWorkerMock();
    const firstRemote = createRemote({
      init: async () => undefined,
      awaitExecution: () => new Promise(() => undefined),
    });
    const replacementRemote = createRemote({
      init: async () => undefined,
      awaitExecution: async () => ({ exitCode: 0 }),
    });
    createStandaloneWorkerMock
      .mockResolvedValueOnce(firstWorker)
      .mockResolvedValueOnce(replacementWorker);
    vi.mocked(wrapWorkerRemote)
      .mockReturnValueOnce(firstRemote)
      .mockReturnValueOnce(replacementRemote);

    const client = await createFileProtocolCompatibleWeshWorkerClient({
      rootHandle: 'readonly',
      mounts: [],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    });

    const cancellation = client.cancelExecution({ request: { executionId: 'exec-1' } });
    await vi.advanceTimersByTimeAsync(150);
    await expect(cancellation).resolves.toBe(true);
    await Promise.resolve();

    expect(firstRemote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(firstWorker.terminate).toHaveBeenCalledOnce();

    await client.dispose();
    expect(replacementRemote.dispose).toHaveBeenCalledOnce();
    expect(replacementRemote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(replacementWorker.terminate).toHaveBeenCalledOnce();
  });

  it('terminates the stalled Worker when cancellation replacement creation fails', async () => {
    vi.useFakeTimers();
    const replacementError = new Error('replacement failed');
    const firstWorker = createWorkerMock();
    const firstRemote = createRemote({
      init: async () => undefined,
      awaitExecution: () => new Promise(() => undefined),
    });
    createStandaloneWorkerMock
      .mockResolvedValueOnce(firstWorker)
      .mockRejectedValueOnce(replacementError);
    vi.mocked(wrapWorkerRemote).mockReturnValue(firstRemote);

    const client = await createFileProtocolCompatibleWeshWorkerClient({
      rootHandle: 'readonly',
      mounts: [],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    });

    const cancellation = client.cancelExecution({ request: { executionId: 'exec-1' } });
    const rejection = expect(cancellation).rejects.toBe(replacementError);
    await vi.advanceTimersByTimeAsync(150);
    await rejection;
    await Promise.resolve();

    expect(firstRemote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
  });
});
