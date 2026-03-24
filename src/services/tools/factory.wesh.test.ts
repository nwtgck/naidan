import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateClient = vi.fn()
const mockCheckOPFSSupport = vi.fn()
const mockGetDirectory = vi.fn()
const mockGetVolumeDirectoryHandle = vi.fn()
const mockGenerateId = vi.fn()

vi.mock('@/services/wesh-worker-client', () => ({
  createFileProtocolCompatibleWeshWorkerClient: mockCreateClient,
}))

vi.mock('@/services/storage/opfs-detection', () => ({
  checkOPFSSupport: mockCheckOPFSSupport,
}))

vi.mock('@/services/storage', () => ({
  storageService: {
    getVolumeDirectoryHandle: mockGetVolumeDirectoryHandle,
  },
}))

vi.mock('@/utils/id', () => ({
  generateId: mockGenerateId,
}))

describe('getEnabledTools shell_execute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: mockGetDirectory,
      },
    })
  })

  it('creates a fresh Wesh worker client with resolved mounts and a per-session /tmp', async () => {
    const tmpHandleA = { kind: 'directory', name: 'chat-1-id-a' } as FileSystemDirectoryHandle
    const tmpHandleB = { kind: 'directory', name: 'chat-1-id-b' } as FileSystemDirectoryHandle
    const volumeHandleA = { kind: 'directory', name: 'vol-a' } as FileSystemDirectoryHandle
    const volumeHandleB = { kind: 'directory', name: 'vol-b' } as FileSystemDirectoryHandle

    mockCheckOPFSSupport.mockResolvedValue(true)
    mockGenerateId
      .mockReturnValueOnce('id-a')
      .mockReturnValueOnce('id-b')
    const mockTmpBaseA = { getDirectoryHandle: vi.fn().mockResolvedValue(tmpHandleA) }
    const mockTmpBaseB = { getDirectoryHandle: vi.fn().mockResolvedValue(tmpHandleB) }
    mockGetDirectory
      .mockResolvedValueOnce({ getDirectoryHandle: vi.fn().mockResolvedValue(mockTmpBaseA) })
      .mockResolvedValueOnce({ getDirectoryHandle: vi.fn().mockResolvedValue(mockTmpBaseB) })
    mockGetVolumeDirectoryHandle
      .mockResolvedValueOnce(volumeHandleA)
      .mockResolvedValueOnce(volumeHandleB)
    mockCreateClient.mockResolvedValue({
      execute: vi.fn(),
      interrupt: vi.fn(),
      dispose: vi.fn(),
    })

    const { getEnabledTools } = await import('./factory')

    const [toolA] = await getEnabledTools({
      enabledNames: ['shell_execute'],
      chatId: 'chat-1',
      settings: {
        mounts: [{ type: 'volume', volumeId: 'a', mountPath: '/mnt/a', readOnly: false }],
      } as never,
    })
    const [toolB] = await getEnabledTools({
      enabledNames: ['shell_execute'],
      chatId: 'chat-1',
      settings: {
        mounts: [{ type: 'volume', volumeId: 'b', mountPath: '/mnt/b', readOnly: true }],
      } as never,
    })

    expect(mockCreateClient).toHaveBeenNthCalledWith(1, {
      rootHandle: 'readonly',
      mounts: [
        { path: '/tmp', handle: tmpHandleA, readOnly: false },
        { path: '/mnt/a', handle: volumeHandleA, readOnly: false },
      ],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    })
    expect(mockCreateClient).toHaveBeenNthCalledWith(2, {
      rootHandle: 'readonly',
      mounts: [
        { path: '/tmp', handle: tmpHandleB, readOnly: false },
        { path: '/mnt/b', handle: volumeHandleB, readOnly: true },
      ],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    })

    // /tmp (read-write) appears in the description because it is in resolvedMounts
    expect(toolA?.description).toEqual(`\
Execute shell scripts to perform file operations, system exploration, and data processing. You can use standard Unix-like commands (ls, cat, grep, etc.). Use the "help" command to see available utilities. This is useful for reading multiple files at once or performing complex file manipulations.

Mounted directories:
- /tmp (read-write)
- /mnt/a (read-write)`)
    expect(toolB?.description).toEqual(`\
Execute shell scripts to perform file operations, system exploration, and data processing. You can use standard Unix-like commands (ls, cat, grep, etc.). Use the "help" command to see available utilities. This is useful for reading multiple files at once or performing complex file manipulations.

Mounted directories:
- /tmp (read-write)
- /mnt/b (read-only)`)
  })

  it('sets initialCwd to /home/user when a mount lives under /home/user/', async () => {
    const tmpHandle = { kind: 'directory', name: 'chat-1-id-x' } as FileSystemDirectoryHandle
    const volumeHandle = { kind: 'directory', name: 'vol-x' } as FileSystemDirectoryHandle

    mockCheckOPFSSupport.mockResolvedValue(true)
    mockGenerateId.mockReturnValueOnce('id-x')
    const mockTmpBase = { getDirectoryHandle: vi.fn().mockResolvedValue(tmpHandle) }
    mockGetDirectory.mockResolvedValueOnce({ getDirectoryHandle: vi.fn().mockResolvedValue(mockTmpBase) })
    mockGetVolumeDirectoryHandle.mockResolvedValueOnce(volumeHandle)
    mockCreateClient.mockResolvedValue({ execute: vi.fn(), interrupt: vi.fn(), dispose: vi.fn() })

    const { getEnabledTools } = await import('./factory')

    await getEnabledTools({
      enabledNames: ['shell_execute'],
      chatId: 'chat-1',
      settings: {
        mounts: [{ type: 'volume', volumeId: 'x', mountPath: '/home/user/myproject', readOnly: false }],
      } as never,
    })

    expect(mockCreateClient).toHaveBeenCalledWith(expect.objectContaining({
      initialCwd: '/home/user',
    }))
  })

  it('does not create the shell tool when OPFS is unavailable', async () => {
    mockCheckOPFSSupport.mockResolvedValue(false)

    const { getEnabledTools } = await import('./factory')
    const tools = await getEnabledTools({
      enabledNames: ['shell_execute'],
      chatId: 'chat-1',
      settings: {
        mounts: [],
      } as never,
    })

    expect(tools).toEqual([])
    expect(mockCreateClient).not.toHaveBeenCalled()
  })
})
