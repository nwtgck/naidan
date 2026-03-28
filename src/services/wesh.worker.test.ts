import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('comlink', () => ({
  expose: vi.fn(),
}))

describe('wesh.worker', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('executes a script after initialization', async () => {
    const comlink = await import('comlink')
    const { MockFileSystemDirectoryHandle } = await import('@/services/wesh/mocks/InMemoryFileSystem')
    await import('./wesh.worker')

    const workerApi = vi.mocked(comlink.expose).mock.calls[0]?.[0]
    const rootHandle = new MockFileSystemDirectoryHandle('root') as unknown as FileSystemDirectoryHandle

    await workerApi.init({
      request: {
        rootHandle,
        mounts: [],
        user: 'user',
        initialEnv: {},
      },
    })

    const response = await workerApi.execute({
      request: {
        script: 'echo hello',
        stdoutLimit: 4096,
        stderrLimit: 4096,
      },
    })

    expect(response).toEqual({
      exitCode: 0,
      stdout: 'hello\n',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    })
  })

  it('can read from a mounted directory', async () => {
    const comlink = await import('comlink')
    const { MockFileSystemDirectoryHandle } = await import('@/services/wesh/mocks/InMemoryFileSystem')
    await import('./wesh.worker')

    const workerApi = vi.mocked(comlink.expose).mock.calls[0]?.[0]
    const rootHandle = new MockFileSystemDirectoryHandle('root')
    const mountedRoot = new MockFileSystemDirectoryHandle('mounted')
    const fileHandle = await mountedRoot.getFileHandle('hello.txt', { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write('from mount')
    await writable.close()

    await workerApi.init({
      request: {
        rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
        mounts: [{
          path: '/mnt',
          handle: mountedRoot as unknown as FileSystemDirectoryHandle,
          readOnly: true,
        }],
        user: 'user',
        initialEnv: {},
      },
    })

    const response = await workerApi.execute({
      request: {
        script: 'cat /mnt/hello.txt',
        stdoutLimit: 4096,
        stderrLimit: 4096,
      },
    })

    expect(response.exitCode).toBe(0)
    expect(response.stdout).toBe('from mount')
    expect(response.stdoutTruncated).toBe(false)
    expect(response.stderrTruncated).toBe(false)
  })

  it('interrupts a foreground process group', async () => {
    const comlink = await import('comlink')
    const { MockFileSystemDirectoryHandle } = await import('@/services/wesh/mocks/InMemoryFileSystem')
    await import('./wesh.worker')

    const workerApi = vi.mocked(comlink.expose).mock.calls[0]?.[0]
    await workerApi.init({
      request: {
        rootHandle: new MockFileSystemDirectoryHandle('root') as unknown as FileSystemDirectoryHandle,
        mounts: [],
        user: 'user',
        initialEnv: {},
      },
    })

    const execution = workerApi.execute({
      request: {
        script: 'sleep 5',
        stdoutLimit: 4096,
        stderrLimit: 4096,
      },
    })

    await new Promise(resolve => setTimeout(resolve, 20))
    const interrupted = await workerApi.interrupt({})
    const response = await execution

    expect(interrupted).toBe(true)
    expect(response.exitCode).toBe(130)
    expect(response.stdoutTruncated).toBe(false)
    expect(response.stderrTruncated).toBe(false)
  })

  it('streams stdout and stderr events before awaitExecution resolves', async () => {
    const comlink = await import('comlink')
    const { MockFileSystemDirectoryHandle } = await import('@/services/wesh/mocks/InMemoryFileSystem')
    await import('./wesh.worker')

    const workerApi = vi.mocked(comlink.expose).mock.calls[0]?.[0]
    await workerApi.init({
      request: {
        rootHandle: new MockFileSystemDirectoryHandle('root') as unknown as FileSystemDirectoryHandle,
        mounts: [],
        user: 'user',
        initialEnv: {},
      },
    })

    const events: Array<import('./wesh-worker.types').WeshWorkerExecutionEvent> = []
    const { executionId } = await workerApi.startExecution(
      {
        script: 'echo before-stream; echo partial-error >&2',
        stdoutLimit: 4096,
        stderrLimit: 4096,
      },
      async (event: import('./wesh-worker.types').WeshWorkerExecutionEvent) => {
        events.push(event)
      },
    )
    const response = await workerApi.awaitExecution({
      request: {
        executionId,
      },
    })

    expect(events.some(event => event.type === 'started')).toBe(true)
    expect(events.some(event => event.type === 'stdout' && event.text.includes('before-stream'))).toBe(true)
    expect(events.some(event => event.type === 'stderr' && event.text.includes('partial-error'))).toBe(true)
    expect(events.some(event => event.type === 'exit' && event.exitCode === 0)).toBe(true)
    expect(response.exitCode).toBe(0)
    expect(response.stdout).toContain('before-stream')
    expect(response.stderr).toContain('partial-error')
    expect(response.stdoutTruncated).toBe(false)
    expect(response.stderrTruncated).toBe(false)
  })
})
