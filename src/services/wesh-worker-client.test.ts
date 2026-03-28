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
      stdout: 'ok\n',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    })
    const startExecution = vi.fn().mockResolvedValue({ executionId: 'exec-1' })
    const awaitExecution = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: 'ok\n',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    })
    const interruptExecution = vi.fn().mockResolvedValue(true)
    const disposeExecution = vi.fn().mockResolvedValue(undefined)
    const interrupt = vi.fn().mockResolvedValue(true)
    const dispose = vi.fn().mockResolvedValue(undefined)

    vi.mocked(Comlink.wrap).mockReturnValue({
      init,
      startExecution,
      awaitExecution,
      interruptExecution,
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
        stdoutLimit: 10,
        stderrLimit: 10,
      },
    })
    const interrupted = await client.interrupt({})
    await client.dispose({})

    expect(init).toHaveBeenCalledTimes(1)
    expect(response.stdout).toBe('ok\n')
    expect(interrupted).toBe(true)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(terminate).toHaveBeenCalledTimes(1)
  })
})
