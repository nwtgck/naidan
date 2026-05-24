import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Comlink from 'comlink'

vi.mock('comlink', () => {
  const releaseProxy = Symbol('releaseProxy')
  return {
    wrap: vi.fn(),
    proxy: <T>(value: T) => value,
    releaseProxy,
  }
})

describe('createFileProtocolCompatibleWeshWorkerClient', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('initializes the remote and disposes the worker', async () => {
    const terminate = vi.fn()
    const worker = { terminate } as unknown as Worker
    class WorkerMock {
      constructor() {
        return worker
      }
    }
    vi.stubGlobal('Worker', WorkerMock)

    const release = vi.fn()
    const init = vi.fn().mockResolvedValue(undefined)
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
    })
    const startExecution = vi.fn().mockResolvedValue({ executionId: 'exec-1' })
    const awaitExecution = vi.fn().mockResolvedValue({
      exitCode: 0,
    })
    const interruptExecution = vi.fn().mockResolvedValue(true)
    const cancelExecution = vi.fn().mockResolvedValue(true)
    const disposeExecution = vi.fn().mockResolvedValue(undefined)
    const interrupt = vi.fn().mockResolvedValue(true)
    const dispose = vi.fn().mockResolvedValue(undefined)

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
    } as unknown as Comlink.Remote<import('./types').IWeshWorker>)

    const { MockFileSystemDirectoryHandle } = await import('@/services/wesh/mocks/InMemoryFileSystem')
    const { createFileProtocolCompatibleWeshWorkerClient } = await import('./client')
    const client = await createFileProtocolCompatibleWeshWorkerClient({
      rootHandle: new MockFileSystemDirectoryHandle('root') as unknown as FileSystemDirectoryHandle,
      mounts: [],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    })

    const response = await client.execute({
      request: {
        script: 'echo ok',
      },
    })
    const interrupted = await client.interrupt({})
    await client.dispose({})

    expect(init).toHaveBeenCalledTimes(1)
    expect(response.exitCode).toBe(0)
    expect(interrupted).toBe(true)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(terminate).toHaveBeenCalledTimes(1)
  })

  it('does not release the active runtime before pending awaitExecution settles during cancel', async () => {
    const terminate1 = vi.fn()
    const terminate2 = vi.fn()
    const worker1 = { terminate: terminate1 } as unknown as Worker
    const worker2 = { terminate: terminate2 } as unknown as Worker
    class WorkerMock {
      static nextWorkers = [worker1, worker2]
      constructor() {
        return WorkerMock.nextWorkers.shift()!
      }
    }
    vi.stubGlobal('Worker', WorkerMock)

    const release1 = vi.fn().mockResolvedValue(undefined)
    const release2 = vi.fn().mockResolvedValue(undefined)
    const awaitExecutionResolvers: Array<(value: { exitCode: number }) => void> = []

    const remote1 = {
      init: vi.fn().mockResolvedValue(undefined),
      startExecution: vi.fn().mockResolvedValue({ executionId: 'exec-1' }),
      awaitExecution: vi.fn().mockImplementation(() => new Promise(resolve => {
        awaitExecutionResolvers.push(resolve)
      })),
      interruptExecution: vi.fn().mockResolvedValue(true),
      disposeExecution: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue({ exitCode: 0 }),
      interrupt: vi.fn().mockResolvedValue(true),
      dispose: vi.fn().mockResolvedValue(undefined),
      [Comlink.releaseProxy]: release1,
    } as unknown as Comlink.Remote<import('./types').IWeshWorker>

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
    } as unknown as Comlink.Remote<import('./types').IWeshWorker>

    vi.mocked(Comlink.wrap)
      .mockReturnValueOnce(remote1)
      .mockReturnValueOnce(remote2)

    const { MockFileSystemDirectoryHandle } = await import('@/services/wesh/mocks/InMemoryFileSystem')
    const { createFileProtocolCompatibleWeshWorkerClient } = await import('./client')
    const client = await createFileProtocolCompatibleWeshWorkerClient({
      rootHandle: new MockFileSystemDirectoryHandle('root') as unknown as FileSystemDirectoryHandle,
      mounts: [],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    })

    const completion = client.awaitExecution({
      request: {
        executionId: 'exec-1',
      },
    })

    const cancelled = await client.cancelExecution({
      request: {
        executionId: 'exec-1',
      },
    })

    expect(cancelled).toBe(true)
    expect(release1).not.toHaveBeenCalled()
    expect(terminate1).not.toHaveBeenCalled()

    for (const resolveAwaitExecution of awaitExecutionResolvers) {
      resolveAwaitExecution({ exitCode: 130 })
    }
    await expect(completion).resolves.toEqual({ exitCode: 130 })

    await new Promise(resolve => setTimeout(resolve, 0))

    expect(release1).toHaveBeenCalledTimes(1)
    expect(terminate1).toHaveBeenCalledTimes(1)
  })

  it('passes a naidan sysfs remote reader during initialization for local storage mounts', async () => {
    const terminate = vi.fn()
    const worker = { terminate } as unknown as Worker
    class WorkerMock {
      constructor() {
        return worker
      }
    }
    vi.stubGlobal('Worker', WorkerMock)

    const release = vi.fn()
    const init = vi.fn().mockResolvedValue(undefined)
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
    } as unknown as Comlink.Remote<import('./types').IWeshWorker>
    vi.mocked(Comlink.wrap).mockReturnValue(remote)

    const { MockFileSystemDirectoryHandle } = await import('@/services/wesh/mocks/InMemoryFileSystem')
    const { createFileProtocolCompatibleWeshWorkerClient } = await import('./client')
    const client = await createFileProtocolCompatibleWeshWorkerClient({
      rootHandle: new MockFileSystemDirectoryHandle('root') as unknown as FileSystemDirectoryHandle,
      mounts: [{
        type: 'naidan_sysfs',
        path: '/sys/fs/naidan',
        readOnly: true,
        storageType: 'local',
        visibility: 'current_chat_only',
        currentChatId: 'chat-1',
        currentChatGroupId: 'chat-group-1',
      }],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    })

    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        mounts: [{
          type: 'naidan_sysfs',
          path: '/sys/fs/naidan',
          readOnly: true,
          storageType: 'local',
          visibility: 'current_chat_only',
          currentChatId: 'chat-1',
          currentChatGroupId: 'chat-group-1',
        }],
      }),
      expect.objectContaining({
        storageType: 'local',
      }),
    )
    expect(init.mock.calls[0]?.[0]).not.toHaveProperty('naidanSysfsRemoteReader')

    await client.dispose({})
    expect(release).toHaveBeenCalledTimes(1)
    expect(terminate).toHaveBeenCalledTimes(1)
  })
})
