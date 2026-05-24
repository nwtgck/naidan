import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chatMetaToDomain } from '@/models/mappers'
import type { ChatContent, ChatGroup, ChatMeta } from '@/models/types'
import { chatContentToDto, chatGroupToDto, chatMetaToDto } from '@/models/mappers'
import { renderChatMetadataMarkdown } from '@/services/wesh/naidan-sysfs/render/metadata-markdown'

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
  }, 15000)

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

  it('does not expose naidan sysfs when no naidan sysfs mount is provided', async () => {
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

    const response = await workerApi.execute({
      request: {
        script: 'ls /sys/fs/naidan',
      },
    })

    expect(response.exitCode).toBe(1)
  })

  it('can read naidan sysfs metadata through a local remote reader', async () => {
    const comlink = await import('comlink')
    const { MockFileSystemDirectoryHandle } = await import('@/services/wesh/mocks/InMemoryFileSystem')
    await import('./entry')

    const workerApi = vi.mocked(comlink.expose).mock.calls[0]?.[0]
    const chatMeta: ChatMeta = {
      id: 'chat-1',
      title: 'Local Chat',
      groupId: 'chat-group-1',
      currentLeafId: 'a1chatMetadataAbCdEf',
      createdAt: 100,
      updatedAt: 200,
      debugEnabled: false,
      endpoint: {
        type: 'openai',
        url: 'https://example.invalid/v1',
        httpHeaders: [['Authorization', 'secret-token']],
      },
      modelId: 'gpt-5',
      autoTitleEnabled: true,
      titleModelId: 'gpt-5-mini',
      originChatId: undefined,
      originMessageId: undefined,
      systemPrompt: undefined,
      lmParameters: undefined,
      mounts: [],
    }
    const chatContent: ChatContent = {
      currentLeafId: 'a1chatMetadataAbCdEf',
      root: { items: [] },
    }
    const chatGroup: ChatGroup = {
      id: 'chat-group-1',
      name: 'Local Group',
      isCollapsed: false,
      updatedAt: 200,
      mounts: [],
      endpoint: undefined,
      modelId: undefined,
      autoTitleEnabled: undefined,
      titleModelId: undefined,
      systemPrompt: undefined,
      lmParameters: undefined,
      items: [{
        id: 'chat:chat-1',
        type: 'chat',
        chat: {
          id: 'chat-1',
          title: 'Local Chat',
          updatedAt: 200,
          groupId: 'chat-group-1',
        },
      }],
    }
    const expectedMetadata = chatMetaToDomain({ dto: chatMetaToDto({ domain: chatMeta }) })
    expectedMetadata.groupId = 'chat-group-1'

    await workerApi.init({
      request: {
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
        naidanSysfsRemoteReader: {
          storageType: 'local',
          async getSidebarStructure() {
            return [{
              id: 'chat-group:chat-group-1',
              type: 'chat_group',
              chatGroup,
            }]
          },
          async listChats() {
            return [{
              id: 'chat-1',
              title: 'Local Chat',
              updatedAt: 200,
              groupId: 'chat-group-1',
            }]
          },
          async listChatGroups() {
            return [chatGroup]
          },
          async loadChatMeta({ chatId }: { chatId: string }) {
            return chatId === 'chat-1'
              ? {
                dto: chatMetaToDto({ domain: chatMeta }),
                groupId: 'chat-group-1',
              }
              : undefined
          },
          async loadChatContent({ chatId }: { chatId: string }) {
            return chatId === 'chat-1' ? chatContentToDto({ domain: chatContent }) : undefined
          },
          async loadChatGroup({ chatGroupId }: { chatGroupId: string }) {
            return chatGroupId === 'chat-group-1'
              ? {
                dto: chatGroupToDto({ domain: chatGroup }),
                items: chatGroup.items.map(item => ({
                  id: item.id,
                  type: 'chat',
                  chat: item.chat,
                })),
              }
              : undefined
          },
        },
      },
    })

    const stdoutChunks: string[] = []
    const response = await workerApi.startExecution(
      { script: 'cat /sys/fs/naidan/chats/chat-1/metadata.md' },
      async (event: import('./types').WeshWorkerRemoteExecutionEvent) => {
        if (event.type === 'stdout') {
          stdoutChunks.push(new TextDecoder().decode(event.buffer))
        }
      },
    )
    const awaitResponse = await workerApi.awaitExecution({
      request: { executionId: response.executionId },
    })

    expect(awaitResponse).toEqual({ exitCode: 0 })
    expect(stdoutChunks.join('')).toEqual(renderChatMetadataMarkdown({ metadata: expectedMetadata }))
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
