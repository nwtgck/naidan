import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toChatGroupId, toChatId, toVolumeId } from '@/models/ids'

const mockCreateClient = vi.fn()
const mockGetVolumeDirectoryHandle = vi.fn()
const mockAbortOngoingScans = vi.fn()
const mockGetVolumeExtensions = vi.fn()
const mockIsVolumeScanned = vi.fn()
const mockStartVolumeExtensionScan = vi.fn()

vi.mock('@/services/wesh/worker/client', () => ({
  createFileProtocolCompatibleWeshWorkerClient: mockCreateClient,
}))

vi.mock('@/services/storage', () => ({
  storageService: {
    getVolumeDirectoryHandle: mockGetVolumeDirectoryHandle,
  },
}))

vi.mock('./wesh/volume-extension-cache', () => ({
  abortOngoingScans: mockAbortOngoingScans,
  getVolumeExtensions: mockGetVolumeExtensions,
  isVolumeScanned: mockIsVolumeScanned,
  startVolumeExtensionScan: mockStartVolumeExtensionScan,
}))

function setupStandardMocks({
  volumeHandle,
}: {
  volumeHandle: FileSystemDirectoryHandle
}) {
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
    mockGetVolumeExtensions.mockReturnValue(new Set<string>())
    mockIsVolumeScanned.mockReturnValue(false)
  })

  it('creates a fresh Wesh worker client with resolved mounts and a per-session /tmp', async () => {
    const tmpHandleA = { kind: 'directory', name: 'chat-1-id-a' } as FileSystemDirectoryHandle
    const tmpHandleB = { kind: 'directory', name: 'chat-1-id-b' } as FileSystemDirectoryHandle
    const volumeHandleA = { kind: 'directory', name: 'vol-a' } as FileSystemDirectoryHandle
    const volumeHandleB = { kind: 'directory', name: 'vol-b' } as FileSystemDirectoryHandle

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
      tmpHandle: tmpHandleA,
      chatId: toChatId({ raw: 'chat-1' }),
      chatGroupId: toChatGroupId({ raw: 'chat-group-1' }),
      naidanSysfsAccessScope: 'current_chat_only',
      settings: {
        storageType: 'opfs',
        mounts: [{ type: 'volume', volumeId: toVolumeId({ raw: 'a' }), mountPath: '/mnt/a', readOnly: false }],
      } as never,
    })
    const [toolB] = await getEnabledTools({
      enabledNames: ['shell_execute'],
      tmpHandle: tmpHandleB,
      chatId: toChatId({ raw: 'chat-2' }),
      chatGroupId: undefined,
      naidanSysfsAccessScope: 'main_chats',
      settings: {
        storageType: 'opfs',
        mounts: [{ type: 'volume', volumeId: toVolumeId({ raw: 'b' }), mountPath: '/mnt/b', readOnly: true }],
      } as never,
    })

    expect(mockCreateClient).toHaveBeenNthCalledWith(1, {
      rootHandle: 'readonly',
      mounts: [
        { type: 'directory', path: '/tmp', handle: tmpHandleA, readOnly: false },
        {
          type: 'naidan_sysfs',
          path: '/sys/fs/naidan',
          readOnly: true,
          storageType: 'opfs',
          visibility: 'current_chat_only',
          binaryObjectAccess: 'data',
          currentChatId: 'chat-1',
          currentChatGroupId: 'chat-group-1',
        },
        { type: 'directory', path: '/mnt/a', handle: volumeHandleA, readOnly: false },
      ],
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    })
    expect(mockCreateClient).toHaveBeenNthCalledWith(2, {
      rootHandle: 'readonly',
      mounts: [
        { type: 'directory', path: '/tmp', handle: tmpHandleB, readOnly: false },
        {
          type: 'naidan_sysfs',
          path: '/sys/fs/naidan',
          readOnly: true,
          storageType: 'opfs',
          visibility: 'main_chats',
          binaryObjectAccess: 'data',
          currentChatId: 'chat-2',
          currentChatGroupId: undefined,
        },
        { type: 'directory', path: '/mnt/b', handle: volumeHandleB, readOnly: true },
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
- /sys/fs/naidan (read-only)
- /mnt/a (read-write)`)
    expect(toolB?.description).toEqual(`\
Execute shell scripts to perform file operations, system exploration, and data processing. You can use standard Unix-like commands (ls, cat, grep, etc.). Run \`help\` to see available utilities.

Mounted directories:
- /tmp (read-write)
- /sys/fs/naidan (read-only)
- /mnt/b (read-only)`)
  }, 15000)

  it('sets initialCwd to /home/user when a mount lives under /home/user/', async () => {
    const tmpHandle = { kind: 'directory', name: 'chat-1-id-x' } as FileSystemDirectoryHandle
    const volumeHandle = { kind: 'directory', name: 'vol-x' } as FileSystemDirectoryHandle

    setupStandardMocks({ volumeHandle })

    const { getEnabledTools } = await import('./factory')

    await getEnabledTools({
      enabledNames: ['shell_execute'],
      tmpHandle,
      chatId: toChatId({ raw: 'chat-1' }),
      chatGroupId: undefined,
      naidanSysfsAccessScope: 'current_chat_with_chat_group',
      settings: {
        storageType: 'opfs',
        mounts: [{ type: 'volume', volumeId: 'x', mountPath: '/home/user/myproject', readOnly: false }],
      } as never,
    })

    expect(mockCreateClient).toHaveBeenCalledWith(expect.objectContaining({
      initialCwd: '/home/user',
    }))
  })

  it('creates the shell tool for local storage without /tmp', async () => {
    const volumeHandle = { kind: 'directory', name: 'vol-local-only' } as FileSystemDirectoryHandle
    setupStandardMocks({ volumeHandle })
    const { getEnabledTools } = await import('./factory')
    const tools = await getEnabledTools({
      enabledNames: ['shell_execute'],
      tmpHandle: undefined,
      chatId: toChatId({ raw: 'chat-1' }),
      chatGroupId: toChatGroupId({ raw: 'chat-group-1' }),
      naidanSysfsAccessScope: 'current_chat_only',
      settings: {
        storageType: 'local',
        mounts: [{ type: 'volume', volumeId: 'vol-local-only', mountPath: '/mnt/local-only', readOnly: true }],
      } as never,
    })

    expect(tools).toHaveLength(1)
    expect(mockCreateClient).toHaveBeenCalledWith(expect.objectContaining({
      mounts: [
        {
          type: 'naidan_sysfs',
          path: '/sys/fs/naidan',
          readOnly: true,
          storageType: 'local',
          visibility: 'current_chat_only',
          binaryObjectAccess: 'data',
          currentChatId: 'chat-1',
          currentChatGroupId: 'chat-group-1',
        },
        { type: 'directory', path: '/mnt/local-only', handle: volumeHandle, readOnly: true },
      ],
    }))
  })

  it('does not add a naidan sysfs mount when selection is none', async () => {
    const tmpHandle = { kind: 'directory', name: 'chat-1-id-none' } as FileSystemDirectoryHandle
    const volumeHandle = { kind: 'directory', name: 'vol-none' } as FileSystemDirectoryHandle

    setupStandardMocks({ volumeHandle })

    const { getEnabledTools } = await import('./factory')

    await getEnabledTools({
      enabledNames: ['shell_execute'],
      tmpHandle,
      chatId: toChatId({ raw: 'chat-1' }),
      chatGroupId: toChatGroupId({ raw: 'chat-group-1' }),
      naidanSysfsAccessScope: 'none',
      settings: {
        storageType: 'opfs',
        mounts: [{ type: 'volume', volumeId: 'vol-none', mountPath: '/mnt/none', readOnly: true }],
      } as never,
    })

    expect(mockCreateClient).toHaveBeenCalledWith(expect.objectContaining({
      mounts: [
        { type: 'directory', path: '/tmp', handle: tmpHandle, readOnly: false },
        { type: 'directory', path: '/mnt/none', handle: volumeHandle, readOnly: true },
      ],
    }))
  })

  it('does not expose wikipedia tools when shell_execute is disabled', async () => {
    const { getEnabledTools } = await import('./factory')

    const tools = await getEnabledTools({
      enabledNames: ['wikipedia_search', 'wikipedia_get_page'],
      tmpHandle: { kind: 'directory', name: 'tmp' } as FileSystemDirectoryHandle,
      chatId: toChatId({ raw: 'chat-1' }),
      chatGroupId: toChatGroupId({ raw: 'chat-group-1' }),
      naidanSysfsAccessScope: 'current_chat_only',
      settings: {
        storageType: 'opfs',
        mounts: [],
      } as never,
    })

    expect(tools).toHaveLength(0)
  })

  it('does not expose wikipedia tools when sysfs Naidan is disabled', async () => {
    const tmpHandle = { kind: 'directory', name: 'tmp' } as FileSystemDirectoryHandle
    const { getEnabledTools } = await import('./factory')

    const tools = await getEnabledTools({
      enabledNames: ['shell_execute', 'wikipedia_search', 'wikipedia_get_page'],
      tmpHandle,
      chatId: toChatId({ raw: 'chat-1' }),
      chatGroupId: toChatGroupId({ raw: 'chat-group-1' }),
      naidanSysfsAccessScope: 'none',
      settings: {
        storageType: 'opfs',
        mounts: [],
      } as never,
    })

    expect(tools.map(({ name }) => name)).toEqual(['shell_execute'])
  })

  it('does not expose wikipedia tools when shell_execute cannot be created', async () => {
    const { getEnabledTools } = await import('./factory')

    const tools = await getEnabledTools({
      enabledNames: ['shell_execute', 'wikipedia_search', 'wikipedia_get_page'],
      tmpHandle: undefined,
      chatId: toChatId({ raw: 'chat-1' }),
      chatGroupId: toChatGroupId({ raw: 'chat-group-1' }),
      naidanSysfsAccessScope: 'current_chat_only',
      settings: {
        storageType: 'opfs',
        mounts: [],
      } as never,
    })

    expect(tools).toHaveLength(0)
  })

  it('exposes wikipedia tools only when shell_execute and sysfs Naidan are both usable', async () => {
    const tmpHandle = { kind: 'directory', name: 'tmp' } as FileSystemDirectoryHandle
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

    const tools = await getEnabledTools({
      enabledNames: ['wikipedia_search', 'shell_execute', 'wikipedia_get_page'],
      tmpHandle,
      chatId: toChatId({ raw: 'chat-1' }),
      chatGroupId: toChatGroupId({ raw: 'chat-group-1' }),
      naidanSysfsAccessScope: 'current_chat_only',
      settings: {
        storageType: 'opfs',
        mounts: [],
      } as never,
    })

    expect(tools.map(({ name }) => name)).toEqual([
      'wikipedia_search',
      'shell_execute',
      'wikipedia_get_page',
    ])
  })

  it('creates a local-storage naidan sysfs mount when selected', async () => {
    const volumeHandle = { kind: 'directory', name: 'vol-local' } as FileSystemDirectoryHandle

    setupStandardMocks({ volumeHandle })

    const { getEnabledTools } = await import('./factory')

    await getEnabledTools({
      enabledNames: ['shell_execute'],
      tmpHandle: undefined,
      chatId: toChatId({ raw: 'chat-1' }),
      chatGroupId: toChatGroupId({ raw: 'chat-group-1' }),
      naidanSysfsAccessScope: 'current_chat_with_chat_group',
      settings: {
        storageType: 'local',
        mounts: [{ type: 'volume', volumeId: 'vol-local', mountPath: '/mnt/local', readOnly: true }],
      } as never,
    })

    expect(mockCreateClient).toHaveBeenCalledWith(expect.objectContaining({
      mounts: [
        {
          type: 'naidan_sysfs',
          path: '/sys/fs/naidan',
          readOnly: true,
          storageType: 'local',
          visibility: 'current_chat_with_chat_group',
          binaryObjectAccess: 'data',
          currentChatId: 'chat-1',
          currentChatGroupId: 'chat-group-1',
        },
        { type: 'directory', path: '/mnt/local', handle: volumeHandle, readOnly: true },
      ],
    }))
  })

  it('starts a background scan for volumes not yet scanned', async () => {
    const tmpHandle = { kind: 'directory', name: 'chat-1-id-s' } as FileSystemDirectoryHandle
    const volumeHandle = { kind: 'directory', name: 'vol-s' } as FileSystemDirectoryHandle

    setupStandardMocks({ volumeHandle })
    mockIsVolumeScanned.mockReturnValue(false)

    const { getEnabledTools } = await import('./factory')

    await getEnabledTools({
      enabledNames: ['shell_execute'],
      tmpHandle,
      chatId: toChatId({ raw: 'chat-1' }),
      chatGroupId: undefined,
      naidanSysfsAccessScope: 'current_chat_with_chat_group',
      settings: {
        storageType: 'opfs',
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

    setupStandardMocks({ volumeHandle })
    mockIsVolumeScanned.mockReturnValue(true)

    const { getEnabledTools } = await import('./factory')

    await getEnabledTools({
      enabledNames: ['shell_execute'],
      tmpHandle,
      chatId: toChatId({ raw: 'chat-1' }),
      chatGroupId: undefined,
      naidanSysfsAccessScope: 'current_chat_with_chat_group',
      settings: {
        storageType: 'opfs',
        mounts: [{ type: 'volume', volumeId: 'vol-r', mountPath: '/mnt/r', readOnly: true }],
      } as never,
    })

    expect(mockStartVolumeExtensionScan).not.toHaveBeenCalled()
  })

  it('includes file type hints in the description for detected extensions', async () => {
    const tmpHandle = { kind: 'directory', name: 'chat-1-id-d' } as FileSystemDirectoryHandle
    const volumeHandle = { kind: 'directory', name: 'vol-d' } as FileSystemDirectoryHandle

    setupStandardMocks({ volumeHandle })
    mockGetVolumeExtensions.mockReturnValue(new Set(['.docx', '.xlsx']))

    const { getEnabledTools } = await import('./factory')

    const [tool] = await getEnabledTools({
      enabledNames: ['shell_execute'],
      tmpHandle,
      chatId: toChatId({ raw: 'chat-1' }),
      chatGroupId: undefined,
      naidanSysfsAccessScope: 'current_chat_with_chat_group',
      settings: {
        storageType: 'opfs',
        mounts: [{ type: 'volume', volumeId: 'vol-d', mountPath: '/mnt/d', readOnly: true }],
      } as never,
    })

    expect(tool?.description).toContain('To read .docx and .xlsx files in the mounts, unzip them to /tmp first:')
    expect(tool?.description).toContain('  unzip example.docx -d /tmp/example')
    expect(tool?.description).toContain('  unzip example.xlsx -d /tmp/example')
  })
})
