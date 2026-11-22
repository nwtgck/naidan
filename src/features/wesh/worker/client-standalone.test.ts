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
  return Object.assign(new EventTarget(), { terminate: vi.fn() }) as unknown as Worker;
}

function createRemote() {
  return {
    init: vi.fn<IWeshWorker['init']>().mockResolvedValue(undefined),
    preloadNextCommand: vi.fn().mockResolvedValue({ status: 'done' }),
    execute: vi.fn<IWeshWorker['execute']>().mockResolvedValue({ exitCode: 0 }),
    getShellState: vi.fn().mockResolvedValue({ cwd: '/', env: {} }),
    interrupt: vi.fn<IWeshWorker['interrupt']>().mockResolvedValue(true),
    isInterruptWaitingForFilePublication: vi.fn<IWeshWorker['isInterruptWaitingForFilePublication']>().mockResolvedValue(false),
    listCommands: vi.fn(),
    listDirectory: vi.fn(),
    dispose: vi.fn(),
    [Comlink.createEndpoint]: vi.fn(),
    [Comlink.releaseProxy]: vi.fn<() => unknown>(),
  };
}

const reference = { volumeId: toVolumeId({ raw: 'managed' }) };

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('standalone Wesh Worker client lifecycle', () => {
  it.each(['with managed grants', 'without managed grants'] as const)('releases the session when initialization fails %s', async mode => {
    const initializationError = new Error('init failed');
    const worker = createWorkerMock();
    const grant = {
      root: { id: 'root', kind: 'directory', name: 'Documents' },
      access: { request: vi.fn() },
      dispose: vi.fn(async () => {}),
    };
    const managed = mode === 'with managed grants';
    createManagedVolumeAccessMock.mockResolvedValueOnce(grant);
    const remote = createRemote();
    remote.init.mockRejectedValueOnce(initializationError);
    createStandaloneWorkerMock.mockResolvedValueOnce(worker);
    vi.mocked(wrapWorkerRemote).mockReturnValueOnce(remote);

    const client = createFileProtocolCompatibleWeshWorkerClient({
      rootHandle: 'readonly',
      mounts: managed ? [{ type: 'managed_directory', path: '/documents', reference, readOnly: true }] : [],
      user: 'user',
      initialEnv: {},
    });
    await expect(client.getShellState()).rejects.toBe(initializationError);

    expect(remote.init.mock.calls[0]).toHaveLength(managed ? 3 : 2);
    expect(grant.dispose).toHaveBeenCalledTimes(managed ? 1 : 0);
    expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('revokes managed access on runtime failure and keeps final disposal idempotent', async () => {
    const worker = createWorkerMock();
    const grant = {
      root: { id: 'root', kind: 'directory', name: 'Documents' },
      access: { request: vi.fn() },
      dispose: vi.fn(async () => {}),
    };
    createManagedVolumeAccessMock.mockResolvedValueOnce(grant);
    const remote = createRemote();
    createStandaloneWorkerMock.mockResolvedValueOnce(worker);
    vi.mocked(wrapWorkerRemote).mockReturnValueOnce(remote);
    const client = createFileProtocolCompatibleWeshWorkerClient({
      rootHandle: 'readonly',
      mounts: [{ type: 'managed_directory', path: '/documents', reference, readOnly: false }],
      user: 'user',
      initialEnv: {},
    });

    await client.getShellState();
    expect(createManagedVolumeAccessMock).toHaveBeenCalledWith({ reference, readOnly: false });
    const access = remote.init.mock.calls[0]?.[2];
    expect(await access!.getRoot({ path: '/documents' })).toEqual(grant.root);
    worker.dispatchEvent(new Event('error'));
    await expect(access!.getRoot({ path: '/documents' })).rejects.toMatchObject({ name: 'InvalidStateError' });

    await client.dispose();
    await client.dispose();
    expect(grant.dispose).toHaveBeenCalledOnce();
    expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('revokes managed admission and stops despite pending cleanup and replacement startup', async () => {
    vi.useFakeTimers();
    const worker = createWorkerMock();
    const remote = createRemote();
    const cleanup = Promise.withResolvers<void>();
    const grant = {
      root: { id: 'root', kind: 'directory', name: 'Documents' },
      access: { request: vi.fn() },
      dispose: vi.fn(() => cleanup.promise),
    };
    remote.execute.mockReturnValueOnce(new Promise(() => {}));
    remote.interrupt.mockReturnValueOnce(new Promise(() => {}));
    remote[Comlink.releaseProxy].mockImplementation(() => new Promise(() => {}));
    createManagedVolumeAccessMock.mockResolvedValue(grant);
    createStandaloneWorkerMock
      .mockResolvedValueOnce(worker)
      .mockReturnValueOnce(new Promise(() => {}));
    vi.mocked(wrapWorkerRemote).mockReturnValueOnce(remote);

    const client = createFileProtocolCompatibleWeshWorkerClient({
      rootHandle: 'readonly',
      mounts: [{ type: 'managed_directory', path: '/documents', reference, readOnly: false }],
      user: 'user',
      initialEnv: {},
    });
    const first = client.startExecution({ request: { script: 'sleep 60' } });
    await vi.advanceTimersByTimeAsync(0);
    const access = remote.init.mock.calls[0]?.[2];
    expect(await access!.getRoot({ path: '/documents' })).toEqual(grant.root);
    let postTerminationRequest: ReturnType<NonNullable<typeof access>['getRoot']> | undefined;
    vi.mocked(worker.terminate).mockImplementation(() => {
      postTerminationRequest = access!.getRoot({ path: '/documents' });
      void postTerminationRequest.catch(() => undefined);
    });

    first.cancel();
    await vi.advanceTimersByTimeAsync(150);
    await expect(first.completion).resolves.toEqual({ status: 'terminated' });
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(postTerminationRequest).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(grant.dispose).toHaveBeenCalledOnce();
    expect(createStandaloneWorkerMock).toHaveBeenCalledOnce();

    const replacement = client.startExecution({ request: { script: 'pwd' } });
    await vi.advanceTimersByTimeAsync(0);
    const signal = createStandaloneWorkerMock.mock.calls[1]?.[0].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    await client.dispose();
    expect(signal.aborted).toBe(true);
    await expect(replacement.completion).resolves.toEqual({ status: 'terminated' });
    cleanup.resolve();
  });

  it('does not allocate a Worker after cancellation overtakes managed grant preparation', async () => {
    vi.useFakeTimers();
    const grant = {
      root: { id: 'root', kind: 'directory', name: 'Documents' },
      access: { request: vi.fn() },
      dispose: vi.fn(async () => {}),
    };
    const preparing = Promise.withResolvers<typeof grant>();
    createManagedVolumeAccessMock.mockReturnValueOnce(preparing.promise);
    const client = createFileProtocolCompatibleWeshWorkerClient({
      rootHandle: 'readonly',
      mounts: [{ type: 'managed_directory', path: '/documents', reference, readOnly: true }],
      user: 'user',
      initialEnv: {},
    });

    const execution = client.startExecution({ request: { script: 'pwd' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(createManagedVolumeAccessMock).toHaveBeenCalledOnce();
    execution.cancel();
    await vi.advanceTimersByTimeAsync(150);
    await expect(execution.completion).resolves.toEqual({ status: 'terminated' });
    preparing.resolve(grant);
    await vi.advanceTimersByTimeAsync(0);
    expect(grant.dispose).toHaveBeenCalledOnce();
    expect(createStandaloneWorkerMock).not.toHaveBeenCalled();
    await client.dispose();
  });

  it('reports failed lazy replacement to its own execution', async () => {
    vi.useFakeTimers();
    const replacementError = new Error('replacement failed');
    const firstWorker = createWorkerMock();
    const firstRemote = createRemote();
    firstRemote.execute.mockReturnValueOnce(new Promise(() => {}));
    createStandaloneWorkerMock
      .mockResolvedValueOnce(firstWorker)
      .mockRejectedValueOnce(replacementError);
    vi.mocked(wrapWorkerRemote).mockReturnValue(firstRemote);

    const client = createFileProtocolCompatibleWeshWorkerClient({ rootHandle: 'readonly', mounts: [], user: 'user', initialEnv: {} });
    await using _client = { [Symbol.asyncDispose]: () => client.dispose() };
    const first = client.startExecution({ request: { script: 'sleep 60' } });
    await vi.advanceTimersByTimeAsync(0);
    first.cancel();
    await vi.advanceTimersByTimeAsync(150);
    await expect(first.completion).resolves.toEqual({ status: 'terminated' });
    expect(firstRemote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(firstWorker.terminate).toHaveBeenCalledOnce();

    const second = client.startExecution({ request: { script: 'pwd' } });
    await expect(second.completion).rejects.toBe(replacementError);
  });
});
