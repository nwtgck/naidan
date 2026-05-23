import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('comlink', () => ({
  expose: vi.fn(),
  transfer: <T>(value: T) => value,
}))

describe('wesh.worker', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('executes a script after initialization', async () => {
    const comlink = await import('comlink')
    const { MockFileSystemDirectoryHandle } = await import('@/services/wesh/mocks/InMemoryFileSystem')
    await import('./entry')

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
      },
    })

    expect(response).toEqual({
      exitCode: 0,
    })
  })

  it('can read from a mounted directory', async () => {
    const comlink = await import('comlink')
    const { MockFileSystemDirectoryHandle } = await import('@/services/wesh/mocks/InMemoryFileSystem')
    await import('./entry')

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
          type: 'directory',
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
      },
    })

    expect(response.exitCode).toBe(0)
  })

  it('can read the naidan sysfs version file', async () => {
    const comlink = await import('comlink')
    const { MockFileSystemDirectoryHandle } = await import('@/services/wesh/mocks/InMemoryFileSystem')
    const opfsRoot = new MockFileSystemDirectoryHandle('opfs-root')
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true })
    await storageRoot.getDirectoryHandle('uploaded-files', { create: true })
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockResolvedValue(opfsRoot as unknown as FileSystemDirectoryHandle),
      },
    })
    await import('./entry')

    const workerApi = vi.mocked(comlink.expose).mock.calls[0]?.[0]
    await workerApi.init({
      request: {
        rootHandle: new MockFileSystemDirectoryHandle('root') as unknown as FileSystemDirectoryHandle,
        mounts: [{
          type: 'naidan_sysfs',
          path: '/sys/fs/naidan',
          readOnly: true,
          storageType: 'opfs',
          visibility: 'current_chat_only',
          currentChatId: 'chat-1',
          currentChatGroupId: 'chat-group-1',
        }],
        user: 'user',
        initialEnv: {},
      },
    })

    const response = await workerApi.execute({
      request: {
        script: 'cat /sys/fs/naidan/version',
      },
    })

    expect(response.exitCode).toBe(0)
  })

  it('interrupts a foreground process group', async () => {
    const comlink = await import('comlink')
    const { MockFileSystemDirectoryHandle } = await import('@/services/wesh/mocks/InMemoryFileSystem')
    await import('./entry')

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
      },
    })

    await new Promise(resolve => setTimeout(resolve, 20))
    const interrupted = await workerApi.interrupt({})
    const response = await execution

    expect(interrupted).toBe(true)
    expect(response.exitCode).toBe(130)
  })

  it('streams stdout and stderr events before awaitExecution resolves', async () => {
    const comlink = await import('comlink')
    const { MockFileSystemDirectoryHandle } = await import('@/services/wesh/mocks/InMemoryFileSystem')
    await import('./entry')

    const workerApi = vi.mocked(comlink.expose).mock.calls[0]?.[0]
    await workerApi.init({
      request: {
        rootHandle: new MockFileSystemDirectoryHandle('root') as unknown as FileSystemDirectoryHandle,
        mounts: [],
        user: 'user',
        initialEnv: {},
      },
    })

    const events: Array<import('./types').WeshWorkerRemoteExecutionEvent> = []
    const { executionId } = await workerApi.startExecution(
      {
        script: 'echo before-stream; echo partial-error >&2',
      },
      async (event: import('./types').WeshWorkerRemoteExecutionEvent) => {
        events.push(event)
      },
    )
    const response = await workerApi.awaitExecution({
      request: {
        executionId,
      },
    })

    const decoder = new TextDecoder()
    const stdoutOutput = events
      .filter((event): event is Extract<typeof event, { type: 'stdout' }> => event.type === 'stdout')
      .map(event => decoder.decode(event.buffer))
      .join('')
    const stderrOutput = events
      .filter((event): event is Extract<typeof event, { type: 'stderr' }> => event.type === 'stderr')
      .map(event => decoder.decode(event.buffer))
      .join('')

    expect(events.some(event => event.type === 'started')).toBe(true)
    expect(stdoutOutput).toContain('before-stream')
    expect(stderrOutput).toContain('partial-error')
    expect(events.some(event => event.type === 'exit' && event.exitCode === 0)).toBe(true)
    expect(response.exitCode).toBe(0)
  })
})
