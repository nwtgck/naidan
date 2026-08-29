import { toChatGroupId, toChatId } from '@/01-models/ids';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Comlink from 'comlink';

vi.mock('comlink', () => {
  const releaseProxy = Symbol('releaseProxy');
  return {
    wrap: vi.fn(),
    proxy: <T>(value: T) => value,
    releaseProxy,
  };
});

describe('createFileProtocolCompatibleWeshWorkerClient', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('initializes the remote and disposes the worker', async () => {
    const terminate = vi.fn();
    const worker = { terminate } as unknown as Worker;
    class WorkerMock {
      constructor() {
        return worker;
      }
    }
    vi.stubGlobal('Worker', WorkerMock);

    const release = vi.fn();
    const init = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
    });
    const startExecution = vi.fn().mockResolvedValue({ executionId: 'exec-1' });
    const awaitExecution = vi.fn().mockResolvedValue({
      exitCode: 0,
    });
    const interruptExecution = vi.fn().mockResolvedValue(true);
    const cancelExecution = vi.fn().mockResolvedValue(true);
    const disposeExecution = vi.fn().mockResolvedValue(undefined);
    const interrupt = vi.fn().mockResolvedValue(true);
    const dispose = vi.fn().mockResolvedValue(undefined);

    vi.mocked(Comlink.wrap).mockReturnValue({
      init,
      startExecution,
      awaitExecution,
      interruptExecution,
      cancelExecution,
      disposeExecution,
      execute,
      interrupt,
      dispose,
      [Comlink.releaseProxy]: release,
    } as unknown as Comlink.Remote<import('./types').IWeshWorker>);

    const { MockFileSystemDirectoryHandle } = await import('@/features/wesh/mocks/InMemoryFileSystem');
    const { createFileProtocolCompatibleWeshWorkerClient } = await import('./client');
    const client = await createFileProtocolCompatibleWeshWorkerClient({
      rootHandle: new MockFileSystemDirectoryHandle({ name: 'root' }) as unknown as FileSystemDirectoryHandle,
      mounts: [],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    });

    const response = await client.execute({
      request: {
        script: 'echo ok',
      },
    });
    const interrupted = await client.interrupt();
    await client.dispose();

    expect(init).toHaveBeenCalledTimes(1);
    expect(response.exitCode).toBe(0);
    expect(interrupted).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('destroys the Worker runtime when initialization fails', async () => {
    const terminate = vi.fn();
    const worker = { terminate } as unknown as Worker;
    class WorkerMock {
      constructor() {
        return worker;
      }
    }
    vi.stubGlobal('Worker', WorkerMock);

    const release = vi.fn().mockResolvedValue(undefined);
    const initializationError = new Error('init failed');
    vi.mocked(Comlink.wrap).mockReturnValue({
      init: vi.fn().mockRejectedValue(initializationError),
      startExecution: vi.fn(),
      awaitExecution: vi.fn(),
      interruptExecution: vi.fn(),
      cancelExecution: vi.fn(),
      disposeExecution: vi.fn(),
      execute: vi.fn(),
      interrupt: vi.fn(),
      dispose: vi.fn(),
      [Comlink.releaseProxy]: release,
    } as unknown as Comlink.Remote<import('./types').IWeshWorker>);

    const { MockFileSystemDirectoryHandle } = await import('@/features/wesh/mocks/InMemoryFileSystem');
    const { createFileProtocolCompatibleWeshWorkerClient } = await import('./client');

    await expect(createFileProtocolCompatibleWeshWorkerClient({
      rootHandle: new MockFileSystemDirectoryHandle({ name: 'root' }) as unknown as FileSystemDirectoryHandle,
      mounts: [],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    })).rejects.toBe(initializationError);

    expect(release).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('retries with OPFS locators when directory handles cannot be cloned', async () => {
    const firstTerminate = vi.fn();
    const secondTerminate = vi.fn();
    const workers = [
      { terminate: firstTerminate } as unknown as Worker,
      { terminate: secondTerminate } as unknown as Worker,
    ];
    class WorkerMock {
      constructor() {
        return workers.shift()!;
      }
    }
    vi.stubGlobal('Worker', WorkerMock);

    const firstInit = vi.fn().mockRejectedValue(new DOMException('Cannot clone handle', 'DataCloneError'));
    const secondInit = vi.fn().mockResolvedValue(undefined);
    const secondRelease = vi.fn().mockResolvedValue(undefined);
    const createRemote = ({ init, release }: {
      init: typeof firstInit,
      release: ReturnType<typeof vi.fn>,
    }) => ({
      init,
      startExecution: vi.fn(),
      awaitExecution: vi.fn(),
      interruptExecution: vi.fn(),
      disposeExecution: vi.fn(),
      execute: vi.fn(),
      getShellState: vi.fn(),
      listCommands: vi.fn(),
      listDirectory: vi.fn(),
      interrupt: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      [Comlink.releaseProxy]: release,
    } as unknown as Comlink.Remote<import('./types').IWeshWorker>);
    vi.mocked(Comlink.wrap)
      .mockReturnValueOnce(createRemote({ init: firstInit, release: vi.fn() }))
      .mockReturnValueOnce(createRemote({ init: secondInit, release: secondRelease }));

    const { MockFileSystemDirectoryHandle } = await import('@/features/wesh/mocks/InMemoryFileSystem');
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: '' });
    const terminalRoot = await opfsRoot.getDirectoryHandle('terminal', { create: true });
    const globalRoot = await terminalRoot.getDirectoryHandle('global', { create: true });
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockResolvedValue(opfsRoot),
      },
    });

    const { createFileProtocolCompatibleWeshWorkerClient } = await import('./client');
    const client = await createFileProtocolCompatibleWeshWorkerClient({
      rootHandle: globalRoot as unknown as FileSystemDirectoryHandle,
      mounts: [],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    });

    expect(firstInit).toHaveBeenCalledOnce();
    expect(firstTerminate).toHaveBeenCalledOnce();
    expect(secondInit).toHaveBeenCalledWith({
      rootHandle: {
        kind: 'opfs-directory',
        pathSegments: ['terminal', 'global'],
      },
      mounts: [],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    }, undefined, undefined);

    await client.dispose();
    expect(secondRelease).toHaveBeenCalledOnce();
    expect(secondTerminate).toHaveBeenCalledOnce();
  });

  it('sends HizoFS mount capabilities to the Worker without creating a UI filesystem remote', async () => {
    const terminate = vi.fn();
    const worker = { terminate } as unknown as Worker;
    class WorkerMock {
      constructor() {
        return worker;
      }
    }
    vi.stubGlobal('Worker', WorkerMock);

    const release = vi.fn();
    const init = vi.fn().mockResolvedValue(undefined);
    vi.mocked(Comlink.wrap).mockReturnValue({
      init,
      startExecution: vi.fn(),
      awaitExecution: vi.fn(),
      interruptExecution: vi.fn(),
      cancelExecution: vi.fn(),
      disposeExecution: vi.fn(),
      execute: vi.fn(),
      interrupt: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      [Comlink.releaseProxy]: release,
    } as unknown as Comlink.Remote<import('./types').IWeshWorker>);

    const { MockFileSystemDirectoryHandle } = await import('@/features/wesh/mocks/InMemoryFileSystem');
    const { createFileProtocolCompatibleWeshWorkerClient } = await import('./client');
    const workerGrant = {
      type: 'storage_directory_worker_mount_grant' as const,
      version: 1 as const,
      implementation: 'hizofs' as const,
      grantId: 'grant-1',
      accessMode: 'read_write' as const,
      opaquePayload: { cloneable: true },
    };
    const createWorkerMountGrant = vi.fn().mockResolvedValue(workerGrant);
    const client = await createFileProtocolCompatibleWeshWorkerClient({
      rootHandle: new MockFileSystemDirectoryHandle({ name: 'root' }) as unknown as FileSystemDirectoryHandle,
      mounts: [{
        type: 'storage_directory',
        path: '/encrypted',
        handle: {
          createWorkerMountGrant,
        } as unknown as import('@/00-storage/service/storage-file-system/types').StorageDirectoryHandle,
        readOnly: false,
      }],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    });

    expect(createWorkerMountGrant).toHaveBeenCalledExactlyOnceWith({ accessMode: 'read_write' });
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        mounts: [{
          type: 'storage_directory',
          path: '/encrypted',
          workerGrant,
          readOnly: false,
        }],
      }),
      undefined,
      undefined,
    );

    await client.dispose();
    expect(release).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('settles pending completion before terminating a cancelled runtime', async () => {
    vi.useFakeTimers();
    try {
      const terminate1 = vi.fn();
      const terminate2 = vi.fn();
      const worker1 = { terminate: terminate1 } as unknown as Worker;
      const worker2 = { terminate: terminate2 } as unknown as Worker;
      class WorkerMock {
        static nextWorkers = [worker1, worker2];
        constructor() {
          return WorkerMock.nextWorkers.shift()!;
        }
      }
      vi.stubGlobal('Worker', WorkerMock);

      const release1 = vi.fn().mockResolvedValue(undefined);
      const release2 = vi.fn().mockResolvedValue(undefined);
      const remote1 = {
        init: vi.fn().mockResolvedValue(undefined),
        startExecution: vi.fn().mockResolvedValue({ executionId: 'remote-exec-1' }),
        awaitExecution: vi.fn().mockImplementation(async () => await new Promise(() => {})),
        interruptExecution: vi.fn().mockResolvedValue(true),
        disposeExecution: vi.fn().mockResolvedValue(undefined),
        execute: vi.fn().mockResolvedValue({ exitCode: 0 }),
        interrupt: vi.fn().mockResolvedValue(true),
        dispose: vi.fn().mockResolvedValue(undefined),
        [Comlink.releaseProxy]: release1,
      } as unknown as Comlink.Remote<import('./types').IWeshWorker>;
      const remote2 = {
        init: vi.fn().mockResolvedValue(undefined),
        startExecution: vi.fn().mockResolvedValue({ executionId: 'remote-exec-1' }),
        awaitExecution: vi.fn().mockResolvedValue({ exitCode: 0 }),
        interruptExecution: vi.fn().mockResolvedValue(true),
        disposeExecution: vi.fn().mockResolvedValue(undefined),
        execute: vi.fn().mockResolvedValue({ exitCode: 0 }),
        interrupt: vi.fn().mockResolvedValue(true),
        dispose: vi.fn().mockResolvedValue(undefined),
        [Comlink.releaseProxy]: release2,
      } as unknown as Comlink.Remote<import('./types').IWeshWorker>;

      vi.mocked(Comlink.wrap)
        .mockReturnValueOnce(remote1)
        .mockReturnValueOnce(remote2);

      const { MockFileSystemDirectoryHandle } = await import('@/features/wesh/mocks/InMemoryFileSystem');
      const { createFileProtocolCompatibleWeshWorkerClient } = await import('./client');
      const client = await createFileProtocolCompatibleWeshWorkerClient({
        rootHandle: new MockFileSystemDirectoryHandle({ name: 'root' }) as unknown as FileSystemDirectoryHandle,
        mounts: [],
        user: 'user',
        initialEnv: {},
        initialCwd: undefined,
      });
      const started = await client.startExecution({ request: { script: 'sleep forever' } });
      const completion = client.awaitExecution({
        request: { executionId: started.executionId },
      });
      const cancellation = client.cancelExecution({
        request: { executionId: started.executionId },
      });

      await vi.advanceTimersByTimeAsync(150);
      await expect(cancellation).resolves.toBe(true);
      await expect(completion).resolves.toEqual({ exitCode: 130 });
      expect(remote1.awaitExecution).toHaveBeenCalledTimes(1);
      expect(remote1.awaitExecution).toHaveBeenCalledWith({
        request: { executionId: 'remote-exec-1' },
      });
      expect(release1).toHaveBeenCalledTimes(1);
      expect(terminate1).toHaveBeenCalledTimes(1);

      await client.disposeExecution({ request: { executionId: started.executionId } });
      expect(remote1.disposeExecution).not.toHaveBeenCalled();

      const restarted = await client.startExecution({ request: { script: 'echo restarted' } });
      expect(restarted.executionId).not.toBe(started.executionId);
      await expect(client.awaitExecution({
        request: { executionId: restarted.executionId },
      })).resolves.toEqual({ exitCode: 0 });
      expect(remote2.awaitExecution).toHaveBeenCalledWith({
        request: { executionId: 'remote-exec-1' },
      });
      await client.disposeExecution({ request: { executionId: restarted.executionId } });

      await client.dispose();
      expect(release2).toHaveBeenCalledTimes(1);
      expect(terminate2).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });


  it('creates only one replacement for concurrent cancellations on the same runtime', async () => {
    vi.useFakeTimers();
    try {
      const terminate1 = vi.fn();
      const terminate2 = vi.fn();
      const worker1 = { terminate: terminate1 } as unknown as Worker;
      const worker2 = { terminate: terminate2 } as unknown as Worker;
      class WorkerMock {
        static nextWorkers = [worker1, worker2];
        constructor() {
          const worker = WorkerMock.nextWorkers.shift();
          if (worker === undefined) {
            throw new Error('Unexpected extra Wesh Worker replacement');
          }
          return worker;
        }
      }
      vi.stubGlobal('Worker', WorkerMock);

      const release1 = vi.fn();
      const release2 = vi.fn();
      const remote1 = {
        init: vi.fn().mockResolvedValue(undefined),
        startExecution: vi.fn()
          .mockResolvedValueOnce({ executionId: 'remote-exec-1' })
          .mockResolvedValueOnce({ executionId: 'remote-exec-2' }),
        awaitExecution: vi.fn().mockImplementation(async () => await new Promise(() => {})),
        interruptExecution: vi.fn().mockResolvedValue(true),
        disposeExecution: vi.fn().mockResolvedValue(undefined),
        execute: vi.fn().mockResolvedValue({ exitCode: 0 }),
        interrupt: vi.fn().mockResolvedValue(true),
        dispose: vi.fn().mockResolvedValue(undefined),
        [Comlink.releaseProxy]: release1,
      } as unknown as Comlink.Remote<import('./types').IWeshWorker>;
      const remote2 = {
        init: vi.fn().mockResolvedValue(undefined),
        startExecution: vi.fn(),
        awaitExecution: vi.fn(),
        interruptExecution: vi.fn(),
        disposeExecution: vi.fn(),
        execute: vi.fn(),
        interrupt: vi.fn(),
        dispose: vi.fn().mockResolvedValue(undefined),
        [Comlink.releaseProxy]: release2,
      } as unknown as Comlink.Remote<import('./types').IWeshWorker>;
      vi.mocked(Comlink.wrap)
        .mockReturnValueOnce(remote1)
        .mockReturnValueOnce(remote2);

      const { MockFileSystemDirectoryHandle } = await import('@/features/wesh/mocks/InMemoryFileSystem');
      const { createFileProtocolCompatibleWeshWorkerClient } = await import('./client');
      const client = await createFileProtocolCompatibleWeshWorkerClient({
        rootHandle: new MockFileSystemDirectoryHandle({ name: 'root' }) as unknown as FileSystemDirectoryHandle,
        mounts: [],
        user: 'user',
        initialEnv: {},
        initialCwd: undefined,
      });
      const first = await client.startExecution({ request: { script: 'first' } });
      const second = await client.startExecution({ request: { script: 'second' } });
      const firstCompletion = client.awaitExecution({
        request: { executionId: first.executionId },
      });
      const secondCompletion = client.awaitExecution({
        request: { executionId: second.executionId },
      });

      const cancellations = Promise.all([
        client.cancelExecution({ request: { executionId: first.executionId } }),
        client.cancelExecution({ request: { executionId: second.executionId } }),
      ]);
      await vi.advanceTimersByTimeAsync(150);

      await expect(cancellations).resolves.toEqual([true, true]);
      await expect(firstCompletion).resolves.toEqual({ exitCode: 130 });
      await expect(secondCompletion).resolves.toEqual({ exitCode: 130 });
      expect(Comlink.wrap).toHaveBeenCalledTimes(2);
      expect(release1).toHaveBeenCalledTimes(1);
      expect(terminate1).toHaveBeenCalledTimes(1);

      await client.dispose();
      expect(release2).toHaveBeenCalledTimes(1);
      expect(terminate2).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });


  it('disposes a replacement that finishes initialization during client disposal', async () => {
    vi.useFakeTimers();
    try {
      const terminate1 = vi.fn();
      const terminate2 = vi.fn();
      const worker1 = { terminate: terminate1 } as unknown as Worker;
      const worker2 = { terminate: terminate2 } as unknown as Worker;
      class WorkerMock {
        static nextWorkers = [worker1, worker2];
        constructor() {
          return WorkerMock.nextWorkers.shift()!;
        }
      }
      vi.stubGlobal('Worker', WorkerMock);

      const replacementInitialization = Promise.withResolvers<void>();
      const release1 = vi.fn();
      const release2 = vi.fn();
      const remote1 = {
        init: vi.fn().mockResolvedValue(undefined),
        startExecution: vi.fn().mockResolvedValue({ executionId: 'remote-exec-1' }),
        awaitExecution: vi.fn().mockImplementation(async () => await new Promise(() => {})),
        interruptExecution: vi.fn().mockResolvedValue(true),
        disposeExecution: vi.fn().mockResolvedValue(undefined),
        execute: vi.fn(),
        interrupt: vi.fn(),
        dispose: vi.fn().mockResolvedValue(undefined),
        [Comlink.releaseProxy]: release1,
      } as unknown as Comlink.Remote<import('./types').IWeshWorker>;
      const remote2 = {
        init: vi.fn().mockImplementation(async () => await replacementInitialization.promise),
        startExecution: vi.fn(),
        awaitExecution: vi.fn(),
        interruptExecution: vi.fn(),
        disposeExecution: vi.fn(),
        execute: vi.fn(),
        interrupt: vi.fn(),
        dispose: vi.fn().mockResolvedValue(undefined),
        [Comlink.releaseProxy]: release2,
      } as unknown as Comlink.Remote<import('./types').IWeshWorker>;
      vi.mocked(Comlink.wrap)
        .mockReturnValueOnce(remote1)
        .mockReturnValueOnce(remote2);

      const { MockFileSystemDirectoryHandle } = await import('@/features/wesh/mocks/InMemoryFileSystem');
      const { createFileProtocolCompatibleWeshWorkerClient } = await import('./client');
      const client = await createFileProtocolCompatibleWeshWorkerClient({
        rootHandle: new MockFileSystemDirectoryHandle({ name: 'root' }) as unknown as FileSystemDirectoryHandle,
        mounts: [],
        user: 'user',
        initialEnv: {},
        initialCwd: undefined,
      });
      const started = await client.startExecution({ request: { script: 'sleep forever' } });
      const cancellation = client.cancelExecution({
        request: { executionId: started.executionId },
      });
      await vi.advanceTimersByTimeAsync(150);
      expect(remote2.init).toHaveBeenCalledTimes(1);

      const disposal = client.dispose();
      replacementInitialization.resolve();

      await expect(cancellation).resolves.toBe(true);
      await expect(disposal).resolves.toBeUndefined();
      expect(release1).toHaveBeenCalledTimes(1);
      expect(terminate1).toHaveBeenCalledTimes(1);
      expect(release2).toHaveBeenCalledTimes(1);
      expect(terminate2).toHaveBeenCalledTimes(1);
      expect(remote2.dispose).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retain a cancelled runtime whose execution never settles', async () => {
    vi.useFakeTimers();
    try {
      const terminate1 = vi.fn();
      const terminate2 = vi.fn();
      const worker1 = { terminate: terminate1 } as unknown as Worker;
      const worker2 = { terminate: terminate2 } as unknown as Worker;
      class WorkerMock {
        static nextWorkers = [worker1, worker2];
        constructor() {
          return WorkerMock.nextWorkers.shift()!;
        }
      }
      vi.stubGlobal('Worker', WorkerMock);

      const release1 = vi.fn();
      const release2 = vi.fn();
      const remote1 = {
        init: vi.fn().mockResolvedValue(undefined),
        startExecution: vi.fn().mockResolvedValue({ executionId: 'exec-1' }),
        awaitExecution: vi.fn().mockImplementation(async () => await new Promise(() => {})),
        interruptExecution: vi.fn().mockImplementation(async () => await new Promise(() => {})),
        disposeExecution: vi.fn().mockResolvedValue(undefined),
        execute: vi.fn().mockResolvedValue({ exitCode: 0 }),
        interrupt: vi.fn().mockResolvedValue(true),
        dispose: vi.fn().mockResolvedValue(undefined),
        [Comlink.releaseProxy]: release1,
      } as unknown as Comlink.Remote<import('./types').IWeshWorker>;
      const remote2 = {
        init: vi.fn().mockResolvedValue(undefined),
        startExecution: vi.fn().mockResolvedValue({ executionId: 'exec-2' }),
        awaitExecution: vi.fn().mockResolvedValue({ exitCode: 0 }),
        interruptExecution: vi.fn().mockResolvedValue(true),
        disposeExecution: vi.fn().mockResolvedValue(undefined),
        execute: vi.fn().mockResolvedValue({ exitCode: 0 }),
        interrupt: vi.fn().mockResolvedValue(true),
        dispose: vi.fn().mockResolvedValue(undefined),
        [Comlink.releaseProxy]: release2,
      } as unknown as Comlink.Remote<import('./types').IWeshWorker>;

      vi.mocked(Comlink.wrap)
        .mockReturnValueOnce(remote1)
        .mockReturnValueOnce(remote2);

      const { MockFileSystemDirectoryHandle } = await import('@/features/wesh/mocks/InMemoryFileSystem');
      const { createFileProtocolCompatibleWeshWorkerClient } = await import('./client');
      const client = await createFileProtocolCompatibleWeshWorkerClient({
        rootHandle: new MockFileSystemDirectoryHandle({ name: 'root' }) as unknown as FileSystemDirectoryHandle,
        mounts: [],
        user: 'user',
        initialEnv: {},
        initialCwd: undefined,
      });

      const started = await client.startExecution({ request: { script: 'sleep forever' } });
      const completion = client.awaitExecution({
        request: { executionId: started.executionId },
      });
      const cancellation = client.cancelExecution({
        request: { executionId: started.executionId },
      });
      await vi.advanceTimersByTimeAsync(150);
      await expect(cancellation).resolves.toBe(true);
      await expect(completion).resolves.toEqual({ exitCode: 130 });
      expect(release1).toHaveBeenCalledTimes(1);
      expect(terminate1).toHaveBeenCalledTimes(1);

      await client.dispose();

      expect(release1).toHaveBeenCalledTimes(1);
      expect(terminate1).toHaveBeenCalledTimes(1);
      expect(release2).toHaveBeenCalledTimes(1);
      expect(terminate2).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('force-terminates the active runtime when graceful disposal does not settle', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const terminate = vi.fn();
      const worker = { terminate } as unknown as Worker;
      class WorkerMock {
        constructor() {
          return worker;
        }
      }
      vi.stubGlobal('Worker', WorkerMock);

      const release = vi.fn();
      const remote = {
        init: vi.fn().mockResolvedValue(undefined),
        startExecution: vi.fn(),
        awaitExecution: vi.fn(),
        interruptExecution: vi.fn(),
        disposeExecution: vi.fn(),
        execute: vi.fn(),
        interrupt: vi.fn(),
        dispose: vi.fn().mockImplementation(async () => await new Promise(() => {})),
        [Comlink.releaseProxy]: release,
      } as unknown as Comlink.Remote<import('./types').IWeshWorker>;
      vi.mocked(Comlink.wrap).mockReturnValue(remote);

      const { MockFileSystemDirectoryHandle } = await import('@/features/wesh/mocks/InMemoryFileSystem');
      const { createFileProtocolCompatibleWeshWorkerClient } = await import('./client');
      const client = await createFileProtocolCompatibleWeshWorkerClient({
        rootHandle: new MockFileSystemDirectoryHandle({ name: 'root' }) as unknown as FileSystemDirectoryHandle,
        mounts: [],
        user: 'user',
        initialEnv: {},
        initialCwd: undefined,
      });

      const disposal = client.dispose();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1000);
      await expect(disposal).resolves.toBeUndefined();

      expect(release).toHaveBeenCalledTimes(1);
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'Wesh Worker did not dispose in time and was terminated',
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('passes a naidan sysfs remote reader during initialization for local storage mounts', async () => {
    const terminate = vi.fn();
    const worker = { terminate } as unknown as Worker;
    class WorkerMock {
      constructor() {
        return worker;
      }
    }
    vi.stubGlobal('Worker', WorkerMock);

    const release = vi.fn();
    const init = vi.fn().mockResolvedValue(undefined);
    const remote = {
      init,
      startExecution: vi.fn(),
      awaitExecution: vi.fn(),
      interruptExecution: vi.fn(),
      disposeExecution: vi.fn(),
      execute: vi.fn(),
      interrupt: vi.fn(),
      dispose: vi.fn(),
      [Comlink.releaseProxy]: release,
    } as unknown as Comlink.Remote<import('./types').IWeshWorker>;
    vi.mocked(Comlink.wrap).mockReturnValue(remote);

    const { MockFileSystemDirectoryHandle } = await import('@/features/wesh/mocks/InMemoryFileSystem');
    const { createFileProtocolCompatibleWeshWorkerClient } = await import('./client');
    const client = await createFileProtocolCompatibleWeshWorkerClient({
      rootHandle: new MockFileSystemDirectoryHandle({ name: 'root' }) as unknown as FileSystemDirectoryHandle,
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
      initialCwd: undefined,
    });

    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
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
      }),
      expect.objectContaining({
        storageType: 'local',
      }),
      undefined,
    );
    expect(init.mock.calls[0]?.[0]).not.toHaveProperty('naidanSysfsRemoteReader');

    await client.dispose();
    expect(release).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});
