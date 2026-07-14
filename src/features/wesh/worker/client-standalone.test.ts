import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Comlink from 'comlink';
import { createFileProtocolStandaloneWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub-standalone-loader';

vi.mock('comlink', () => {
  const releaseProxy = Symbol('releaseProxy');
  return {
    wrap: vi.fn(),
    proxy: <T>(value: T) => value,
    releaseProxy,
  };
});

vi.mock('@/features/file-protocol-standalone/worker/worker-hub-standalone-loader', () => ({
  createFileProtocolStandaloneWorkerHub: vi.fn(),
}));

describe('standalone Wesh Worker client lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('does not retain a cancelled runtime whose execution never settles', async () => {
    vi.useFakeTimers();
    try {
      const terminate1 = vi.fn();
      const terminate2 = vi.fn();
      const worker1 = { terminate: terminate1 } as unknown as Worker;
      const worker2 = { terminate: terminate2 } as unknown as Worker;
      vi.mocked(createFileProtocolStandaloneWorkerHub)
        .mockResolvedValueOnce(worker1)
        .mockResolvedValueOnce(worker2);

      const release1 = vi.fn();
      const release2 = vi.fn();
      const wesh1 = {
        init: vi.fn().mockResolvedValue(undefined),
        startExecution: vi.fn().mockResolvedValue({ executionId: 'exec-1' }),
        awaitExecution: vi.fn().mockImplementation(async () => await new Promise(() => {})),
        interruptExecution: vi.fn().mockImplementation(async () => await new Promise(() => {})),
        disposeExecution: vi.fn().mockResolvedValue(undefined),
        execute: vi.fn().mockResolvedValue({ exitCode: 0 }),
        interrupt: vi.fn().mockResolvedValue(true),
        dispose: vi.fn().mockResolvedValue(undefined),
      };
      const wesh2 = {
        init: vi.fn().mockResolvedValue(undefined),
        startExecution: vi.fn().mockResolvedValue({ executionId: 'exec-2' }),
        awaitExecution: vi.fn().mockResolvedValue({ exitCode: 0 }),
        interruptExecution: vi.fn().mockResolvedValue(true),
        disposeExecution: vi.fn().mockResolvedValue(undefined),
        execute: vi.fn().mockResolvedValue({ exitCode: 0 }),
        interrupt: vi.fn().mockResolvedValue(true),
        dispose: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(Comlink.wrap)
        .mockReturnValueOnce({
          wesh: wesh1,
          [Comlink.releaseProxy]: release1,
        } as unknown as Comlink.Remote<import('@/features/file-protocol-standalone/worker/worker-hub.types').IWorkerHub>)
        .mockReturnValueOnce({
          wesh: wesh2,
          [Comlink.releaseProxy]: release2,
        } as unknown as Comlink.Remote<import('@/features/file-protocol-standalone/worker/worker-hub.types').IWorkerHub>);

      const { MockFileSystemDirectoryHandle } = await import('@/features/wesh/mocks/InMemoryFileSystem');
      const { createFileProtocolCompatibleWeshWorkerClient } = await import('./client-standalone');
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
      expect(wesh1.awaitExecution).toHaveBeenCalledTimes(1);
      expect(wesh1.awaitExecution).toHaveBeenCalledWith({
        request: { executionId: 'exec-1' },
      });
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

  it('force-terminates the active runtime when standalone graceful disposal stalls', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const terminate = vi.fn();
      const worker = { terminate } as unknown as Worker;
      vi.mocked(createFileProtocolStandaloneWorkerHub).mockResolvedValue(worker);

      const release = vi.fn();
      const wesh = {
        init: vi.fn().mockResolvedValue(undefined),
        startExecution: vi.fn(),
        awaitExecution: vi.fn(),
        interruptExecution: vi.fn(),
        disposeExecution: vi.fn(),
        execute: vi.fn(),
        interrupt: vi.fn(),
        dispose: vi.fn().mockImplementation(async () => await new Promise(() => {})),
      };
      vi.mocked(Comlink.wrap).mockReturnValue({
        wesh,
        [Comlink.releaseProxy]: release,
      } as unknown as Comlink.Remote<import('@/features/file-protocol-standalone/worker/worker-hub.types').IWorkerHub>);

      const { MockFileSystemDirectoryHandle } = await import('@/features/wesh/mocks/InMemoryFileSystem');
      const { createFileProtocolCompatibleWeshWorkerClient } = await import('./client-standalone');
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
        'Standalone Wesh Worker did not dispose in time and was terminated',
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});
