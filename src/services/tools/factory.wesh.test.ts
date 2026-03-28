import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateClient = vi.fn()
const mockCheckOPFSSupport = vi.fn()
const mockGetDirectory = vi.fn()
const mockGetVolumeDirectoryHandle = vi.fn()
const mockGenerateId = vi.fn()
const mockAbortOngoingScans = vi.fn()
const mockGetVolumeExtensions = vi.fn()
const mockIsVolumeScanned = vi.fn()
const mockStartVolumeExtensionScan = vi.fn()

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

vi.mock('./volume-extension-cache', () => ({
  abortOngoingScans: mockAbortOngoingScans,
  getVolumeExtensions: mockGetVolumeExtensions,
  isVolumeScanned: mockIsVolumeScanned,
  startVolumeExtensionScan: mockStartVolumeExtensionScan,
}))

function setupStandardMocks({
  tmpHandle,
  volumeHandle,
  generateIdSuffix,
}: {
  tmpHandle: FileSystemDirectoryHandle
  volumeHandle: FileSystemDirectoryHandle
  generateIdSuffix: string
}) {
  mockCheckOPFSSupport.mockResolvedValue(true)
  mockGenerateId.mockReturnValueOnce(generateIdSuffix)
  const tmpBase = { getDirectoryHandle: vi.fn().mockResolvedValue(tmpHandle) }
  mockGetDirectory.mockResolvedValueOnce({ getDirectoryHandle: vi.fn().mockResolvedValue(tmpBase) })
  mockGetVolumeDirectoryHandle.mockResolvedValueOnce(volumeHandle)
  mockCreateClient.mockResolvedValue({
    startExecution: vi.fn(),
    awaitExecution: vi.fn(),
    interruptExecution: vi.fn(),
    cancelExecution: vi.fn(),
    disposeExecution: vi.fn(),
    execute: vi.fn(),
    interrupt: vi.fn(),
    dispose: vi.fn(),
  })
}

describe('getEnabledTools shell_execute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: mockGetDirectory,
      },
    })
    mockGetVolumeExtensions.mockReturnValue(new Set<string>())
    mockIsVolumeScanned.mockReturnValue(false)
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
      startExecution: vi.fn(),
      awaitExecution: vi.fn(),
      interruptExecution: vi.fn(),
      cancelExecution: vi.fn(),
      disposeExecution: vi.fn(),
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
Execute shell scripts to perform file operations, system exploration, and data processing. You can use standard Unix-like commands (ls, cat, grep, etc.). Run \`help\` to see available utilities.

Mounted directories:
- /tmp (read-write)
- /mnt/a (read-write)`)
    expect(toolB?.description).toEqual(`\
Execute shell scripts to perform file operations, system exploration, and data processing. You can use standard Unix-like commands (ls, cat, grep, etc.). Run \`help\` to see available utilities.

Mounted directories:
- /tmp (read-write)
- /mnt/b (read-only)`)
  })

  it('sets initialCwd to /home/user when a mount lives under /home/user/', async () => {
    const tmpHandle = { kind: 'directory', name: 'chat-1-id-x' } as FileSystemDirectoryHandle
    const volumeHandle = { kind: 'directory', name: 'vol-x' } as FileSystemDirectoryHandle

    setupStandardMocks({ tmpHandle, volumeHandle, generateIdSuffix: 'id-x' })

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

  it('starts a background scan for volumes not yet scanned', async () => {
    const tmpHandle = { kind: 'directory', name: 'chat-1-id-s' } as FileSystemDirectoryHandle
    const volumeHandle = { kind: 'directory', name: 'vol-s' } as FileSystemDirectoryHandle

    setupStandardMocks({ tmpHandle, volumeHandle, generateIdSuffix: 'id-s' })
    mockIsVolumeScanned.mockReturnValue(false)

    const { getEnabledTools } = await import('./factory')

    await getEnabledTools({
      enabledNames: ['shell_execute'],
      chatId: 'chat-1',
      settings: {
        mounts: [{ type: 'volume', volumeId: 'vol-s', mountPath: '/mnt/s', readOnly: true }],
      } as never,
    })

    expect(mockStartVolumeExtensionScan).toHaveBeenCalledWith({
      volumeId: 'vol-s',
      handle: volumeHandle,
    })
  })

  it('does not start a scan for volumes already scanned', async () => {
    const tmpHandle = { kind: 'directory', name: 'chat-1-id-r' } as FileSystemDirectoryHandle
    const volumeHandle = { kind: 'directory', name: 'vol-r' } as FileSystemDirectoryHandle

    setupStandardMocks({ tmpHandle, volumeHandle, generateIdSuffix: 'id-r' })
    mockIsVolumeScanned.mockReturnValue(true)

    const { getEnabledTools } = await import('./factory')

    await getEnabledTools({
      enabledNames: ['shell_execute'],
      chatId: 'chat-1',
      settings: {
        mounts: [{ type: 'volume', volumeId: 'vol-r', mountPath: '/mnt/r', readOnly: true }],
      } as never,
    })

    expect(mockStartVolumeExtensionScan).not.toHaveBeenCalled()
  })

  it('includes file type hints in the description for detected extensions', async () => {
    const tmpHandle = { kind: 'directory', name: 'chat-1-id-d' } as FileSystemDirectoryHandle
    const volumeHandle = { kind: 'directory', name: 'vol-d' } as FileSystemDirectoryHandle

    setupStandardMocks({ tmpHandle, volumeHandle, generateIdSuffix: 'id-d' })
    mockGetVolumeExtensions.mockReturnValue(new Set(['.docx', '.xlsx']))

    const { getEnabledTools } = await import('./factory')

    const [tool] = await getEnabledTools({
      enabledNames: ['shell_execute'],
      chatId: 'chat-1',
      settings: {
        mounts: [{ type: 'volume', volumeId: 'vol-d', mountPath: '/mnt/d', readOnly: true }],
      } as never,
    })

    expect(tool?.description).toContain('To read .docx and .xlsx files in the mounts, unzip them to /tmp first:')
    expect(tool?.description).toContain('  unzip example.docx -d /tmp/example')
    expect(tool?.description).toContain('  unzip example.xlsx -d /tmp/example')
  })
})
