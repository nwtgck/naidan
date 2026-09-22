// @vitest-environment node
import * as Comlink from 'comlink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wrapWorkerRemote } from '@/utils/worker-transport';
import type { WorkerBlobReadHost } from '@/utils/worker-blob-context';
import type { IWeshWorker, WeshWorkerClient } from './types';
import { createFileProtocolCompatibleWeshWorkerClient as createHosted } from './client-hosted';
import { createFileProtocolCompatibleWeshWorkerClient as createStandalone } from './client-standalone';

const { createStandaloneWorker, register, beginForegroundWork } = vi.hoisted(() => ({
  createStandaloneWorker: vi.fn(),
  register: vi.fn(() => ({ dispose: vi.fn() })),
  beginForegroundWork: vi.fn(() => ({ dispose: vi.fn() })),
}));
vi.mock('virtual:file-protocol-standalone/worker/wesh', () => ({ createStandaloneWorker }));
vi.mock('@/utils/worker-transport', async original => ({ ...await original<typeof import('@/utils/worker-transport')>(), wrapWorkerRemote: vi.fn() }));
vi.mock('@/logic/background-work-coordinator', () => ({ backgroundWorkCoordinator: { register, beginForegroundWork } }));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    for (const dispose of cleanup.splice(0).reverse()) await dispose().catch(() => undefined);
  } finally {
    vi.restoreAllMocks(); vi.clearAllMocks(); createStandaloneWorker.mockReset(); vi.mocked(wrapWorkerRemote).mockReset(); vi.useRealTimers(); vi.unstubAllGlobals();
  }
});

function createRemote({ initialize, completion }: { initialize: Promise<void>, completion: Promise<{ exitCode: number }> }) {
  return {
    init: vi.fn(() => initialize), dispose: vi.fn(async (): Promise<void> => undefined),
    execute: vi.fn(async () => ({ exitCode: 0 })), startExecution: vi.fn(async () => ({ executionId: 'exec-1' })),
    awaitExecution: vi.fn(() => completion), interruptExecution: vi.fn(async () => true),
    disposeExecution: vi.fn(async () => undefined), preloadNextCommand: vi.fn(async () => ({ status: 'done' as const })),
    getShellState: vi.fn(async () => ({ cwd: '/', env: {} })), listCommands: vi.fn(async () => []),
    listDirectory: vi.fn(async () => []), interrupt: vi.fn(async () => true),
    [Comlink.releaseProxy]: vi.fn(async () => undefined),
  };
}
function install({ remotes }: { remotes: ReturnType<typeof createRemote>[] }) {
  const workers = remotes.map(() => ({ terminate: vi.fn() }));
  const pending = workers.slice();
  vi.stubGlobal('Worker', class WorkerMock {
    constructor() {
      return pending.shift()!;
    }
  });
  for (let index = 0; index < remotes.length; index++) {
    vi.mocked(wrapWorkerRemote).mockReturnValueOnce(remotes[index]! as unknown as Comlink.Remote<IWeshWorker>);
    createStandaloneWorker.mockResolvedValueOnce(workers[index]!);
  }
  return workers;
}
function getHost({ remote }: { remote: ReturnType<typeof createRemote> }): WorkerBlobReadHost {
  const arguments_ = vi.mocked(remote.init).mock.calls[0] as unknown as Parameters<IWeshWorker['init']>;
  return arguments_[2]!;
}
function readHost({ host }: { host: WorkerBlobReadHost }) {
  return host.read({ blob: new Blob(['abc']), offset: 1, length: 1 });
}
const request = { rootHandle: 'readonly' as const, mounts: [], user: 'user', initialEnv: {}, initialCwd: undefined };

describe.each([
  { mode: 'hosted', createClient: createHosted },
  { mode: 'standalone', createClient: createStandalone },
])('$mode Wesh host ownership', ({ mode, createClient }) => {
  async function own(): Promise<WeshWorkerClient> {
    const client = await createClient(request); cleanup.push(() => client.dispose()); return client;
  }

  it('aborts the supplied host and releases transport when initialization fails', async () => {
    const pending = Promise.withResolvers<void>();
    const remote = createRemote({ initialize: pending.promise, completion: Promise.resolve({ exitCode: 0 }) });
    const [worker] = install({ remotes: [remote] });
    const creating = createClient(request);
    const error = new Error('Initialization failed');
    const rejected = expect(creating).rejects.toBe(error);
    await vi.waitFor(() => expect(remote.init).toHaveBeenCalledOnce());
    const host = getHost({ remote });
    expect(await readHost({ host })).toEqual(new Uint8Array([98]));
    pending.reject(error); await rejected;
    await expect(readHost({ host })).rejects.toBe(error);
    expect(worker!.terminate).toHaveBeenCalledOnce(); expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
  });

  it('shares disposal and stops host reads before delayed logical cleanup finishes', async () => {
    const remote = createRemote({ initialize: Promise.resolve(), completion: Promise.resolve({ exitCode: 0 }) });
    const [worker] = install({ remotes: [remote] }); const client = await own();
    const pending = Promise.withResolvers<void>(); remote.dispose.mockReturnValue(pending.promise);
    const host = getHost({ remote });
    const first = client.dispose(); const second = client.dispose(); expect(first).toBe(second);
    await expect(readHost({ host })).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker!.terminate).not.toHaveBeenCalled(); expect(remote[Comlink.releaseProxy]).not.toHaveBeenCalled();
    pending.resolve(); await first;
    expect(remote.dispose).toHaveBeenCalledOnce(); expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce(); expect(worker!.terminate).toHaveBeenCalledOnce();
    await expect(client.execute({ request: { script: 'echo forbidden' } })).rejects.toThrow('disposed');
  });

  it('creates one replacement for concurrent cancellations and never reuses its old host', async () => {
    vi.useFakeTimers();
    const executing = Promise.withResolvers<{ exitCode: number }>();
    const old = createRemote({ initialize: Promise.resolve(), completion: executing.promise });
    const next = createRemote({ initialize: Promise.resolve(), completion: Promise.resolve({ exitCode: 0 }) });
    const workers = install({ remotes: [old, next] }); const client = await own();
    const first = client.cancelExecution({ request: { executionId: 'exec-1' } });
    const second = client.cancelExecution({ request: { executionId: 'exec-1' } });
    await vi.advanceTimersByTimeAsync(151);
    expect(await first).toBe(true); expect(await second).toBe(true);
    expect(next.init).toHaveBeenCalledOnce(); expect(wrapWorkerRemote).toHaveBeenCalledTimes(2);
    const oldHost = getHost({ remote: old }); const newHost = getHost({ remote: next });
    expect(newHost).not.toBe(oldHost);
    await expect(readHost({ host: oldHost })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await readHost({ host: newHost })).toEqual(new Uint8Array([98]));
    // Hosted clients preserve pending awaitExecution responses; standalone already
    // uses bounded termination for an unresponsive runtime. Do not conflate these.
    switch (mode) {
    case 'hosted': expect(workers[0]!.terminate).not.toHaveBeenCalled(); break;
    case 'standalone': expect(workers[0]!.terminate).toHaveBeenCalledOnce(); break;
    default: throw new Error(`Unexpected test mode ${mode}`);
    }
    executing.resolve({ exitCode: 130 }); await vi.advanceTimersByTimeAsync(1);
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(await client.execute({ request: { script: 'echo new' } })).toEqual({ exitCode: 0 });
  });

  it('destroys a replacement whose init finishes after client disposal, without registering new preload work', async () => {
    vi.useFakeTimers();
    const initializing = Promise.withResolvers<void>();
    const old = createRemote({ initialize: Promise.resolve(), completion: new Promise(() => undefined) });
    const next = createRemote({ initialize: initializing.promise, completion: Promise.resolve({ exitCode: 0 }) });
    const workers = install({ remotes: [old, next] }); const client = await own();
    const cancellation = client.cancelExecution({ request: { executionId: 'exec-1' } });
    await vi.advanceTimersByTimeAsync(151); expect(next.init).toHaveBeenCalledOnce();
    const disposal = client.dispose();
    initializing.resolve(); await cancellation; await disposal;
    expect(register).toHaveBeenCalledOnce();
    expect(workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
    await expect(readHost({ host: getHost({ remote: next }) })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(client.startExecution({ request: { script: 'echo stale' } })).rejects.toThrow('disposed');
  });

  it('releases both runtime hosts when replacement initialization fails', async () => {
    vi.useFakeTimers();
    const initializing = Promise.withResolvers<void>();
    const old = createRemote({ initialize: Promise.resolve(), completion: new Promise(() => undefined) });
    const next = createRemote({ initialize: initializing.promise, completion: Promise.resolve({ exitCode: 0 }) });
    const workers = install({ remotes: [old, next] }); const client = await own();
    const error = new Error('Replacement init failed');
    const cancellation = client.cancelExecution({ request: { executionId: 'exec-1' } });
    const rejected = expect(cancellation).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(151);
    initializing.reject(error); await rejected;
    expect(workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
    await expect(readHost({ host: getHost({ remote: old }) })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(readHost({ host: getHost({ remote: next }) })).rejects.toBe(error);
    await client.dispose();
    expect(workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
  });
});
