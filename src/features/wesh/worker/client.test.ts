import { installHandleCloneProbe } from '@/utils/worker-capability-probe.test-support';
import { toChatGroupId, toChatId } from '@/01-models/ids';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Comlink from 'comlink';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { createFileProtocolCompatibleWeshWorkerClient } from './client';
import { createWeshWorker } from './impl';
import type { IWeshWorker, WeshWorkerRemoteExecutionEvent } from './types';

vi.mock('comlink', () => ({
  wrap: vi.fn(),
  proxy: <T>(value: T) => value,
  transfer: <T>(value: T) => value,
  releaseProxy: Symbol('releaseProxy'),
  createEndpoint: Symbol('createEndpoint'),
}));

function remoteMock() {
  return {
    init: vi.fn<IWeshWorker['init']>().mockResolvedValue(undefined),
    preloadNextCommand: vi.fn().mockResolvedValue({ status: 'done' }),
    execute: vi.fn<IWeshWorker['execute']>().mockResolvedValue({ exitCode: 0 }),
    interrupt: vi.fn<IWeshWorker['interrupt']>().mockResolvedValue(true),
    isInterruptWaitingForFilePublication: vi.fn<IWeshWorker['isInterruptWaitingForFilePublication']>().mockResolvedValue(false),
    getShellState: vi.fn().mockResolvedValue({ cwd: '/', env: {} }),
    listCommands: vi.fn(),
    listDirectory: vi.fn(),
    dispose: vi.fn(),
    [Comlink.createEndpoint]: vi.fn(),
    [Comlink.releaseProxy]: vi.fn(),
  };
}

function installHostedWorkers({ remotes }: { remotes: ReturnType<typeof remoteMock>[] }) {
  const workers = remotes.map(() => Object.assign(new EventTarget(), { terminate: vi.fn() }));
  let next = 0;
  vi.stubGlobal('Worker', class WorkerMock {
    constructor() {
      return workers[next++]!;
    }
  });
  for (const remote of remotes) {
    vi.mocked(Comlink.wrap).mockReturnValueOnce(remote);
  }
  return workers;
}

describe('createFileProtocolCompatibleWeshWorkerClient', () => {
  let capabilityProbe: ReturnType<typeof installHandleCloneProbe>;
  let cloneable = true;

  afterEach(() => {
    capabilityProbe[Symbol.dispose]();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    cloneable = true;
    capabilityProbe = installHandleCloneProbe({ mode: () => cloneable ? 'supported' : 'unsupported' });
    vi.mocked(Comlink.wrap).mockReset();
  });

  it('initializes the remote, executes a command, and disposes the worker', async () => {
    const remote = remoteMock();
    const [worker] = installHostedWorkers({ remotes: [remote] });
    const client = createFileProtocolCompatibleWeshWorkerClient({ rootHandle: 'readonly', mounts: [], user: 'user', initialEnv: {} });
    expect(remote.init).not.toHaveBeenCalled();

    const execution = client.startExecution({ request: { script: 'echo ok' } });
    await expect(execution.completion).resolves.toEqual({ status: 'exited', exitCode: 0 });
    execution.cancel();
    await client.dispose();

    expect(remote.init).toHaveBeenCalledOnce();
    expect(remote.execute).toHaveBeenCalledWith({ script: 'echo ok' }, undefined);
    expect(remote.interrupt).not.toHaveBeenCalled();
    expect(remote.isInterruptWaitingForFilePublication).not.toHaveBeenCalled();
    expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(worker?.terminate).toHaveBeenCalledOnce();
  });

  it('selects OPFS locators before initializing a Worker when handles cannot be cloned', async () => {
    cloneable = false;
    const remote = remoteMock();
    const [worker] = installHostedWorkers({ remotes: [remote] });
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: '' });
    const terminalRoot = await opfsRoot.getDirectoryHandle('terminal', { create: true });
    const globalRoot = await terminalRoot.getDirectoryHandle('global', { create: true });
    vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn().mockResolvedValue(opfsRoot) } });

    const client = createFileProtocolCompatibleWeshWorkerClient({
      rootHandle: globalRoot as unknown as FileSystemDirectoryHandle,
      mounts: [],
      user: 'user',
      initialEnv: {},
    });
    await client.getShellState();

    expect(Comlink.wrap).toHaveBeenCalledOnce();
    expect(remote.init).toHaveBeenCalledWith({
      rootHandle: {
        kind: 'opfs-directory',
        pathSegments: ['terminal', 'global'],
      },
      mounts: [],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    }, undefined);

    await client.dispose();
    expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(worker?.terminate).toHaveBeenCalledOnce();
  });

  it('keeps the Worker when a cooperative interrupt settles its execution without an RPC acknowledgement', async () => {
    vi.useFakeTimers();
    const remote = remoteMock();
    const pending = Promise.withResolvers<{ exitCode: number }>();
    remote.execute.mockReturnValueOnce(pending.promise);
    remote.interrupt.mockReturnValueOnce(new Promise(() => {}));
    const [worker] = installHostedWorkers({ remotes: [remote] });

    const client = createFileProtocolCompatibleWeshWorkerClient({ rootHandle: 'readonly', mounts: [], user: 'user', initialEnv: {} });
    await using _client = { [Symbol.asyncDispose]: () => client.dispose() };
    const execution = client.startExecution({ request: { script: 'sleep 10' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(remote.execute).toHaveBeenCalledOnce();

    execution.cancel();
    await vi.advanceTimersByTimeAsync(149);
    expect(remote.interrupt).toHaveBeenCalledOnce();
    expect(worker?.terminate).not.toHaveBeenCalled();
    pending.resolve({ exitCode: 130 });
    await expect(execution.completion).resolves.toEqual({ status: 'exited', exitCode: 130 });
    const next = client.startExecution({ request: { script: 'echo next' } });
    await expect(next.completion).resolves.toEqual({ status: 'exited', exitCode: 0 });
    await vi.advanceTimersByTimeAsync(1);
    expect(Comlink.wrap).toHaveBeenCalledOnce();
    expect(worker?.terminate).not.toHaveBeenCalled();
  });

  it('terminates despite pending RPCs and an output acknowledgement without touching the next execution', async () => {
    vi.useFakeTimers();
    const remote = remoteMock();
    const replacement = remoteMock();
    const pending = Promise.withResolvers<{ exitCode: number }>();
    const later = Promise.withResolvers<{ exitCode: number, shellState: { cwd: string, env: Record<string, string> } }>();
    const acknowledgement = Promise.withResolvers<void>();
    remote.execute.mockReturnValueOnce(pending.promise);
    remote.interrupt.mockReturnValueOnce(new Promise(() => {}));
    replacement.execute.mockReturnValueOnce(later.promise);
    const [worker, nextWorker] = installHostedWorkers({ remotes: [remote, replacement] });

    const client = createFileProtocolCompatibleWeshWorkerClient({ rootHandle: 'readonly', mounts: [], user: 'user', initialEnv: {} });
    await using _client = { [Symbol.asyncDispose]: () => client.dispose() };
    const oldEvent = vi.fn(() => acknowledgement.promise);
    const first = client.startExecution({ request: { script: 'sleep 10', includeShellState: true }, onEvent: oldEvent });
    await vi.advanceTimersByTimeAsync(0);
    const stale = remote.execute.mock.calls[0]?.[1];
    const pendingAcknowledgement = stale?.({ type: 'stdout', buffer: new TextEncoder().encode('before stop').buffer });
    expect(oldEvent).toHaveBeenCalledOnce();
    expect(() => client.startExecution({ request: { script: 'overlap' } })).toThrow('foreground execution');
    first.cancel();
    first.cancel();
    await vi.advanceTimersByTimeAsync(150);
    await expect(first.completion).resolves.toEqual({ status: 'terminated' });
    expect(worker?.terminate).toHaveBeenCalledOnce();
    expect(remote.interrupt).toHaveBeenCalledOnce();
    expect(remote.execute).toHaveBeenCalledOnce();
    expect(Comlink.wrap).toHaveBeenCalledOnce();

    const second = client.startExecution({ request: { script: 'echo replacement', includeShellState: true } });
    await vi.advanceTimersByTimeAsync(0);
    const event: WeshWorkerRemoteExecutionEvent = { type: 'exit', exitCode: 130 };
    await stale?.(event);
    acknowledgement.resolve();
    await pendingAcknowledgement;
    pending.resolve({ exitCode: 130 });
    first.cancel();
    expect(oldEvent).toHaveBeenCalledOnce();
    expect(nextWorker?.terminate).not.toHaveBeenCalled();
    expect(replacement.interrupt).not.toHaveBeenCalled();
    expect(() => client.startExecution({ request: { script: 'still occupied' } })).toThrow('foreground execution');
    const shellState = { cwd: '/replacement', env: {} };
    later.resolve({ exitCode: 0, shellState });
    await expect(second.completion).resolves.toEqual({ status: 'exited', exitCode: 0, shellState });
  });

  it('keeps a worker responsive during file publication without waiting for the interrupt reply', async () => {
    vi.useFakeTimers();
    const remote = remoteMock();
    const completed = Promise.withResolvers<{ exitCode: number }>();
    remote.execute.mockReturnValueOnce(completed.promise);
    remote.interrupt.mockReturnValueOnce(new Promise(() => {}));
    remote.isInterruptWaitingForFilePublication.mockResolvedValue(true).mockResolvedValueOnce(false);
    const [worker] = installHostedWorkers({ remotes: [remote] });
    const client = createFileProtocolCompatibleWeshWorkerClient({ rootHandle: 'readonly', mounts: [], user: 'user', initialEnv: {} });
    await using _client = { [Symbol.asyncDispose]: () => client.dispose() };
    const execution = client.startExecution({ request: { script: 'printf data > output' } });
    await vi.advanceTimersByTimeAsync(0);

    execution.cancel();
    await vi.advanceTimersByTimeAsync(225);
    expect(remote.interrupt).toHaveBeenCalledOnce();
    expect(worker?.terminate).not.toHaveBeenCalled();

    completed.resolve({ exitCode: 130 });
    await expect(execution.completion).resolves.toEqual({ status: 'exited', exitCode: 130 });
    const probes = remote.isInterruptWaitingForFilePublication.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_001);
    expect(worker?.terminate).not.toHaveBeenCalled();
    expect(remote.isInterruptWaitingForFilePublication).toHaveBeenCalledTimes(probes);
    await expect(client.startExecution({ request: { script: 'echo next' } }).completion).resolves.toEqual({ status: 'exited', exitCode: 0 });
    expect(Comlink.wrap).toHaveBeenCalledOnce();
  });

  it('allows an accepted tee publication to complete beyond the initial stop deadline', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });
    const target = await root.getFileHandle('output', { create: true });
    const writer = await target.createWritable();
    const close = writer.close.bind(writer);
    const publishing = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    using _allowCompletion = {
      [Symbol.dispose]() {
        complete.resolve();
      },
    };
    using _writer = vi.spyOn(target, 'createWritable').mockResolvedValueOnce(writer);
    using _close = vi.spyOn(writer, 'close').mockImplementationOnce(async () => {
      publishing.resolve();
      await complete.promise;
      await close();
    });
    const workerApi = createWeshWorker();
    await workerApi.init({ rootHandle: root as unknown as FileSystemDirectoryHandle, mounts: [], user: 'user', initialEnv: {}, initialCwd: '/' });
    const remote = remoteMock();
    remote.execute.mockImplementation(request => workerApi.execute(request));
    remote.interrupt.mockImplementation(() => workerApi.interrupt());
    remote.isInterruptWaitingForFilePublication.mockImplementation(() => workerApi.isInterruptWaitingForFilePublication());
    const [worker] = installHostedWorkers({ remotes: [remote] });
    const client = createFileProtocolCompatibleWeshWorkerClient({ rootHandle: 'readonly', mounts: [], user: 'user', initialEnv: {} });
    await using _client = { [Symbol.asyncDispose]: () => client.dispose() };
    const execution = client.startExecution({ request: { script: 'printf saved | tee output; printf late > late' } });
    await publishing.promise;

    vi.useFakeTimers();
    execution.cancel();
    await vi.advanceTimersByTimeAsync(225);
    expect(worker?.terminate).not.toHaveBeenCalled();
    expect(remote.isInterruptWaitingForFilePublication).toHaveBeenCalled();
    complete.resolve();

    await expect(execution.completion).resolves.toEqual({ status: 'exited', exitCode: 130 });
    await expect((await target.getFile()).text()).resolves.toBe('saved');
    await expect(root.getFileHandle('late')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it.each([
    { waiting: false, limit: 150 },
    { waiting: true, limit: 3_000 },
  ])('terminates at $limit ms if the worker keeps reporting publication=$waiting but execution stays blocked', async ({ waiting, limit }) => {
    vi.useFakeTimers();
    const remote = remoteMock();
    remote.execute.mockReturnValueOnce(new Promise(() => {}));
    remote.isInterruptWaitingForFilePublication.mockResolvedValue(waiting);
    const [worker] = installHostedWorkers({ remotes: [remote] });
    const client = createFileProtocolCompatibleWeshWorkerClient({ rootHandle: 'readonly', mounts: [], user: 'user', initialEnv: {} });
    await using _client = { [Symbol.asyncDispose]: () => client.dispose() };
    const execution = client.startExecution({ request: { script: 'printf data > output' } });
    await vi.advanceTimersByTimeAsync(0);

    execution.cancel();
    await vi.advanceTimersByTimeAsync(limit - 1);
    expect(worker?.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(execution.completion).resolves.toEqual({ status: 'terminated' });
    expect(worker?.terminate).toHaveBeenCalledOnce();
  });

  it('does not restart a retired watchdog when a late status arrives during the next input', async () => {
    vi.useFakeTimers();
    const remote = remoteMock();
    const completed = Promise.withResolvers<{ exitCode: number }>();
    const completedSecond = Promise.withResolvers<{ exitCode: number }>();
    const publication = Promise.withResolvers<boolean>();
    remote.execute.mockReturnValueOnce(completed.promise).mockReturnValueOnce(completedSecond.promise);
    remote.isInterruptWaitingForFilePublication.mockResolvedValue(true).mockReturnValueOnce(publication.promise);
    const [worker] = installHostedWorkers({ remotes: [remote] });
    const client = createFileProtocolCompatibleWeshWorkerClient({ rootHandle: 'readonly', mounts: [], user: 'user', initialEnv: {} });
    await using _client = { [Symbol.asyncDispose]: () => client.dispose() };
    const first = client.startExecution({ request: { script: 'printf first > output' } });
    await vi.advanceTimersByTimeAsync(0);
    first.cancel();
    await vi.advanceTimersByTimeAsync(75);
    expect(remote.isInterruptWaitingForFilePublication).toHaveBeenCalledOnce();
    completed.resolve({ exitCode: 130 });
    await expect(first.completion).resolves.toEqual({ status: 'exited', exitCode: 130 });

    const second = client.startExecution({ request: { script: 'printf second > output' } });
    second.cancel();
    await vi.advanceTimersByTimeAsync(50);
    publication.resolve(true);
    await vi.advanceTimersByTimeAsync(225);
    expect(worker?.terminate).not.toHaveBeenCalled();
    expect(() => client.startExecution({ request: { script: 'overlap' } })).toThrow('foreground execution');
    completedSecond.resolve({ exitCode: 130 });
    await expect(second.completion).resolves.toEqual({ status: 'exited', exitCode: 130 });
  });

  it('ignores an output event and shell snapshot arriving as the Worker fails', async () => {
    const remote = remoteMock();
    const replacement = remoteMock();
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<Awaited<ReturnType<IWeshWorker['execute']>>>();
    remote.execute.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    const [worker] = installHostedWorkers({ remotes: [remote, replacement] });
    const client = createFileProtocolCompatibleWeshWorkerClient({ rootHandle: 'readonly', mounts: [], user: 'user', initialEnv: {} });
    await using _client = { [Symbol.asyncDispose]: () => client.dispose() };
    const onEvent = vi.fn();
    const execution = client.startExecution({ request: { script: 'pwd', includeShellState: true }, onEvent });
    const failure = expect(execution.completion).rejects.toThrow('Worker failed');
    await started.promise;

    pending.resolve({ exitCode: 0, shellState: { cwd: '/retired', env: {} } });
    worker?.dispatchEvent(new Event('error'));
    await remote.execute.mock.calls[0]?.[1]?.({ type: 'stdout', buffer: new TextEncoder().encode('old').buffer });
    await failure;
    expect(onEvent).not.toHaveBeenCalled();
    expect(worker?.terminate).toHaveBeenCalledOnce();

    const next = client.startExecution({ request: { script: 'pwd' } });
    await expect(next.completion).resolves.toEqual({ status: 'exited', exitCode: 0 });
    expect(replacement.execute).toHaveBeenCalledOnce();
  });

  it('reclaims an already allocated Worker when initialization never answers', async () => {
    vi.useFakeTimers();
    const remote = remoteMock();
    remote.init.mockReturnValueOnce(new Promise(() => {}));
    const [worker] = installHostedWorkers({ remotes: [remote] });

    const client = createFileProtocolCompatibleWeshWorkerClient({ rootHandle: 'readonly', mounts: [], user: 'user', initialEnv: {} });
    const execution = client.startExecution({ request: { script: 'echo skipped' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(remote.init).toHaveBeenCalledOnce();
    execution.cancel();
    await vi.advanceTimersByTimeAsync(150);
    await expect(execution.completion).resolves.toEqual({ status: 'terminated' });
    expect(worker?.terminate).toHaveBeenCalledOnce();
    expect(remote.execute).not.toHaveBeenCalled();
    await client.dispose();
  });

  it.each(['init', 'execute', 'getShellState'] as const)('settles a pending %s RPC when the Worker fails', async method => {
    const remote = remoteMock();
    const replacement = remoteMock();
    remote[method].mockReturnValueOnce(new Promise<never>(() => {}));
    const [worker] = installHostedWorkers({ remotes: [remote, replacement] });
    const client = createFileProtocolCompatibleWeshWorkerClient({ rootHandle: 'readonly', mounts: [], user: 'user', initialEnv: {} });
    await using _client = { [Symbol.asyncDispose]: () => client.dispose() };
    const pending = method === 'getShellState' ? client.getShellState() : client.startExecution({ request: { script: 'pwd' } }).completion;
    const event = method === 'execute' ? 'messageerror' : 'error';
    const outcome = expect(pending).rejects.toThrow(`Wesh Worker failed (${event})`);
    await vi.waitFor(() => expect(remote[method]).toHaveBeenCalledOnce());
    worker?.dispatchEvent(new Event(event));
    await outcome;
    expect(worker?.terminate).toHaveBeenCalledOnce();
    await expect(client.startExecution({ request: { script: 'pwd' } }).completion).resolves.toEqual({ status: 'exited', exitCode: 0 });
  });

  it('passes a naidan sysfs remote reader for local storage mounts', async () => {
    const remote = remoteMock();
    const [worker] = installHostedWorkers({ remotes: [remote] });
    const client = createFileProtocolCompatibleWeshWorkerClient({
      rootHandle: 'readonly',
      mounts: [{
        type: 'naidan_sysfs',
        path: '/sys/fs/naidan',
        readOnly: true,
        storageType: 'local',
        visibility: 'current_chat_only',
        binaryObjectAccess: 'data',
        currentChatId: toChatId({ raw: 'chat-1' }),
        currentChatGroupId: toChatGroupId({ raw: 'chat-group-1' }),
      }],
      user: 'user',
      initialEnv: {},
    });
    await client.getShellState();

    expect(remote.init).toHaveBeenCalledWith(
      expect.objectContaining({
        mounts: [{
          type: 'naidan_sysfs',
          path: '/sys/fs/naidan',
          readOnly: true,
          storageType: 'local',
          visibility: 'current_chat_only',
          binaryObjectAccess: 'data',
          currentChatId: 'chat-1',
          currentChatGroupId: 'chat-group-1',
        }],
      }),
      expect.objectContaining({ storageType: 'local' }),
    );
    expect(remote.init.mock.calls[0]?.[0]).not.toHaveProperty('naidanSysfsRemoteReader');
    await client.dispose();
    expect(remote[Comlink.releaseProxy]).toHaveBeenCalledOnce();
    expect(worker?.terminate).toHaveBeenCalledOnce();
  });
});
