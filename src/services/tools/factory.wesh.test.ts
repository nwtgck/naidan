import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateClient = vi.fn()
const mockCheckOPFSSupport = vi.fn()
const mockGetDirectory = vi.fn()
const mockGetVolumeDirectoryHandle = vi.fn()

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

describe('getEnabledTools shell_execute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: mockGetDirectory,
      },
    })
  })

  it('creates a fresh Wesh worker client with resolved mounts', async () => {
    const rootHandle = { kind: 'directory', name: 'root' } as FileSystemDirectoryHandle
    const volumeHandleA = { kind: 'directory', name: 'vol-a' } as FileSystemDirectoryHandle
    const volumeHandleB = { kind: 'directory', name: 'vol-b' } as FileSystemDirectoryHandle

    mockCheckOPFSSupport.mockResolvedValue(true)
    mockGetDirectory.mockResolvedValue({
      getDirectoryHandle: vi.fn().mockResolvedValue(rootHandle),
    })
    mockGetVolumeDirectoryHandle
      .mockResolvedValueOnce(volumeHandleA)
      .mockResolvedValueOnce(volumeHandleB)
    mockCreateClient.mockResolvedValue({
      execute: vi.fn(),
      interrupt: vi.fn(),
      dispose: vi.fn(),
    })

    const { getEnabledTools } = await import('./factory')

    await getEnabledTools({
      enabledNames: ['shell_execute'],
      settings: {
        mounts: [{ volumeId: 'a', mountPath: '/mnt/a' }],
      } as never,
    })
    await getEnabledTools({
      enabledNames: ['shell_execute'],
      settings: {
        mounts: [{ volumeId: 'b', mountPath: '/mnt/b' }],
      } as never,
    })

    expect(mockCreateClient).toHaveBeenNthCalledWith(1, {
      rootHandle,
      mounts: [{
        path: '/mnt/a',
        handle: volumeHandleA,
        readOnly: false,
      }],
      user: 'user',
      initialEnv: {},
    })
    expect(mockCreateClient).toHaveBeenNthCalledWith(2, {
      rootHandle,
      mounts: [{
        path: '/mnt/b',
        handle: volumeHandleB,
        readOnly: false,
      }],
      user: 'user',
      initialEnv: {},
    })
  })

  it('does not create the shell tool when OPFS is unavailable', async () => {
    mockCheckOPFSSupport.mockResolvedValue(false)

    const { getEnabledTools } = await import('./factory')
    const tools = await getEnabledTools({
      enabledNames: ['shell_execute'],
      settings: {
        mounts: [],
      } as never,
    })

    expect(tools).toEqual([])
    expect(mockCreateClient).not.toHaveBeenCalled()
  })
})
