import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Comlink from 'comlink';

const { createStandaloneWorkerMock } = vi.hoisted(() => ({
  createStandaloneWorkerMock: vi.fn(),
}));

vi.mock('virtual:file-protocol-standalone/worker/wesh', () => ({
  createStandaloneWorker: createStandaloneWorkerMock,
}));

vi.mock('comlink', async (importOriginal) => {
  const original = await importOriginal<typeof import('comlink')>();
  return {
    ...original,
    wrap: vi.fn(),
  };
});

import { createFileProtocolCompatibleWeshWorkerClient } from './client-standalone';
import type { IWeshWorker, WeshWorkerExecutionSummary } from './types';

function createWorkerMock(): Worker {
  return {
    terminate: vi.fn(),
  } as unknown as Worker;
}

function createRemote({
  init,
  startExecution,
  awaitExecution,
  dispose,
}: {
  init?: () => Promise<void>,
  startExecution?: () => Promise<{ executionId: string }>,
  awaitExecution?: () => Promise<WeshWorkerExecutionSummary>,
  dispose?: () => Promise<void>,
}): Comlink.Remote<IWeshWorker> {
  return {
    init: vi.fn(init ?? (async () => undefined)),
    startExecution: vi.fn(startExecution ?? (async () => ({ executionId: 'remote-exec-1' }))),
    awaitExecution: vi.fn(awaitExecution ?? (async () => ({ exitCode: 0 }))),
    interruptExecution: vi.fn().mockResolvedValue(true),
    disposeExecution: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn(),
    getShellState: vi.fn(),
    listCommands: vi.fn(),
    listDirectory: vi.fn(),
    interrupt: vi.fn().mockResolvedValue(true),
    dispose: vi.fn(dispose ?? (async () => undefined)),
    [Comlink.releaseProxy]: vi.fn().mockResolvedValue(undefined),
  } as unknown as Comlink.Remote<IWeshWorker>;
}

async function createClient() {
  return await createFileProtocolCompatibleWeshWorkerClient({
    rootHandle: 'readonly',
    mounts: [],
    user: 'user',
    initialEnv: {},
    initialCwd: undefined,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  createStandaloneWorkerMock.mockReset();
  vi.mocked(Comlink.wrap).mockReset();
});

describe('standalone Wesh Worker client lifecycle', () => {
  it('releases and terminates a Worker when remote initialization fails', async () => {
    const initializationError = new Error('init failed');
    const worker = createWorkerMock();
    const remote = createRemote({
      init: async () => {
        throw initializationError;
      },
    });
    createStandaloneWorkerMock.mockResolvedValue(worker);
    vi.mocked(Comlink.wrap).mockReturnValue(remote);

    await expect(createClient()).rejects.toBe(initializationError);

    expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('force-completes and terminates a cancelled runtime whose execution never settles', async () => {
    vi.useFakeTimers();
    const firstWorker = createWorkerMock();
    const replacementWorker = createWorkerMock();
    const firstRemote = createRemote({
      awaitExecution: () => new Promise(() => undefined),
    });
    const replacementRemote = createRemote({});
    createStandaloneWorkerMock
      .mockResolvedValueOnce(firstWorker)
      .mockResolvedValueOnce(replacementWorker);
    vi.mocked(Comlink.wrap)
      .mockReturnValueOnce(firstRemote)
      .mockReturnValueOnce(replacementRemote);

    const client = await createClient();
    const started = await client.startExecution({ request: { script: 'sleep forever' } });
    const completion = client.awaitExecution({ request: { executionId: started.executionId } });
    const cancellation = client.cancelExecution({ request: { executionId: started.executionId } });

    await vi.advanceTimersByTimeAsync(150);
    await expect(cancellation).resolves.toBe(true);
    await expect(completion).resolves.toEqual({ exitCode: 130 });
    expect(firstRemote.awaitExecution).toHaveBeenCalledWith({
      request: { executionId: 'remote-exec-1' },
    });
    expect(firstWorker.terminate).toHaveBeenCalledOnce();

    await client.dispose();
    expect(replacementRemote.dispose).toHaveBeenCalledOnce();
    expect(replacementWorker.terminate).toHaveBeenCalledOnce();
  });

  it('terminates the stalled Worker when cancellation replacement creation fails', async () => {
    vi.useFakeTimers();
    const replacementError = new Error('replacement failed');
    const firstWorker = createWorkerMock();
    const firstRemote = createRemote({
      awaitExecution: () => new Promise(() => undefined),
    });
    createStandaloneWorkerMock
      .mockResolvedValueOnce(firstWorker)
      .mockRejectedValueOnce(replacementError);
    vi.mocked(Comlink.wrap).mockReturnValue(firstRemote);

    const client = await createClient();
    const started = await client.startExecution({ request: { script: 'sleep forever' } });
    const cancellation = client.cancelExecution({ request: { executionId: started.executionId } });
    const rejection = expect(cancellation).rejects.toBe(replacementError);

    await vi.advanceTimersByTimeAsync(150);
    await rejection;
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
  });

  it('force-terminates the active runtime when standalone graceful disposal stalls', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const worker = createWorkerMock();
    const remote = createRemote({
      dispose: () => new Promise(() => undefined),
    });
    createStandaloneWorkerMock.mockResolvedValue(worker);
    vi.mocked(Comlink.wrap).mockReturnValue(remote);

    const client = await createClient();
    const disposal = client.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(disposal).resolves.toBeUndefined();

    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'Standalone Wesh Worker did not dispose in time and was terminated',
    );
  });
});
