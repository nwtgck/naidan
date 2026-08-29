import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Comlink from 'comlink';
import { wrapWorkerRemote } from '@/utils/worker-transport';

const { createStandaloneWorkerMock } = vi.hoisted(() => ({
  createStandaloneWorkerMock: vi.fn(),
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
  return {
    terminate: vi.fn(),
  } as unknown as Worker;
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
