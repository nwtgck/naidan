import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Comlink from 'comlink'

const mockCreateWorker = vi.fn()

vi.mock('@/services/wesh-worker-loader', () => ({
  createFileProtocolCompatibleWeshWorker: mockCreateWorker,
}))

vi.mock('comlink', () => {
  const releaseProxy = Symbol('releaseProxy')
  return {
    wrap: vi.fn(),
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
    mockCreateWorker.mockReturnValue(worker)

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
    } as unknown as Comlink.Remote<import('./wesh-worker.types').IWeshWorker>)

    const { MockFileSystemDirectoryHandle } = await import('@/services/wesh/mocks/InMemoryFileSystem')
    const { createFileProtocolCompatibleWeshWorkerClient } = await import('./wesh-worker-client')
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
    mockCreateWorker
      .mockReturnValueOnce(worker1)
      .mockReturnValueOnce(worker2)

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
    } as unknown as Comlink.Remote<import('./wesh-worker.types').IWeshWorker>

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
    } as unknown as Comlink.Remote<import('./wesh-worker.types').IWeshWorker>

    vi.mocked(Comlink.wrap)
      .mockReturnValueOnce(remote1)
      .mockReturnValueOnce(remote2)

    const { MockFileSystemDirectoryHandle } = await import('@/services/wesh/mocks/InMemoryFileSystem')
    const { createFileProtocolCompatibleWeshWorkerClient } = await import('./wesh-worker-client')
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
})
