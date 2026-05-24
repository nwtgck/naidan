import { describe, it, expect, beforeEach } from 'vitest'
import { chatContentToDto, chatGroupToDto, chatMetaToDomain, chatMetaToDto } from '@/models/mappers'
import { createFileExplorerWorker } from './impl'
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem'
import { OPFSStorageProvider } from '@/services/storage/opfs-storage'
import type { ChatContent, ChatGroup, ChatMeta } from '@/models/types'
import { renderChatMetadataMarkdown } from '@/services/wesh/naidan-sysfs/render/metadata-markdown'

describe('file-explorer.worker.impl', () => {
  let worker: ReturnType<typeof createFileExplorerWorker>

  beforeEach(() => {
    worker = createFileExplorerWorker({})
  })

  it('lists native directory entries with metadata', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle('root')
    const fileHandle = await rootHandle.getFileHandle('readme.txt', { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write('hello')
    await writable.close()
    await rootHandle.getDirectoryHandle('docs', { create: true })

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'native-directory',
          rootName: 'Files',
          handle: rootHandle as unknown as FileSystemDirectoryHandle,
          readOnly: false,
        },
      },
    })

    const response = await worker.readDirectory({
      request: {
        sessionId,
        path: '/',
      },
    })

    expect(response.entries.map(entry => entry.name).sort()).toEqual(['docs', 'readme.txt'])
    expect(response.entries.find(entry => entry.name === 'readme.txt')?.size).toBe(5)
  })

  it('reads text previews and formats JSON', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle('root')
    const fileHandle = await rootHandle.getFileHandle('data.json', { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write('{"a":1}')
    await writable.close()

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'native-directory',
          rootName: 'Files',
          handle: rootHandle as unknown as FileSystemDirectoryHandle,
          readOnly: false,
        },
      },
    })

    const response = await worker.readPreview({
      request: {
        sessionId,
        path: '/data.json',
        mode: 'bounded',
      },
    })

    expect(response.kind).toBe('text')
    if (response.kind === 'text') {
      expect(response.rawText).toBe('{"a":1}')
      expect(response.displayText).toContain('\n')
    }
  })

  it('creates, copies, moves, and deletes entries inside a session', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle('root')
    await rootHandle.getDirectoryHandle('target', { create: true })

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'native-directory',
          rootName: 'Files',
          handle: rootHandle as unknown as FileSystemDirectoryHandle,
          readOnly: false,
        },
      },
    })

    await worker.createFile({
      request: {
        sessionId,
        parentPath: '/',
        name: 'source.txt',
      },
    })

    await worker.copyEntries({
      request: {
        sessionId,
        sourcePaths: ['/source.txt'],
        targetDirectoryPath: '/target',
      },
    })

    let targetListing = await worker.readDirectory({
      request: {
        sessionId,
        path: '/target',
      },
    })
    expect(targetListing.entries.map(entry => entry.name)).toContain('source.txt')

    await worker.moveEntries({
      request: {
        sessionId,
        sourcePaths: ['/source.txt'],
        targetDirectoryPath: '/target',
      },
    })

    const rootListing = await worker.readDirectory({
      request: {
        sessionId,
        path: '/',
      },
    })
    expect(rootListing.entries.map(entry => entry.name)).not.toContain('source.txt')

    await worker.deleteEntries({
      request: {
        sessionId,
        paths: ['/target/source.txt'],
      },
    })

    targetListing = await worker.readDirectory({
      request: {
        sessionId,
        path: '/target',
      },
    })
    expect(targetListing.entries.map(entry => entry.name)).not.toContain('source.txt')
  })

  it('exposes virtual directories for wesh mounts roots', async () => {
    const mountHandle = new MockFileSystemDirectoryHandle('project')
    const fileHandle = await mountHandle.getFileHandle('index.ts', { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write('export {}')
    await writable.close()

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'wesh-mounts',
          rootName: 'Files',
          mounts: [{
            type: 'directory',
            path: '/home/user/project',
            handle: mountHandle as unknown as FileSystemDirectoryHandle,
            readOnly: false,
          }],
        },
      },
    })

    const rootListing = await worker.readDirectory({
      request: {
        sessionId,
        path: '/',
      },
    })
    expect(rootListing.entries.map(entry => entry.name)).toEqual(['home'])

    const mountListing = await worker.readDirectory({
      request: {
        sessionId,
        path: '/home/user/project',
      },
    })
    expect(mountListing.entries.map(entry => entry.name)).toEqual(['index.ts'])
  })

  it('lists and navigates naidan sysfs entries from wesh mounts', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle('opfs-root')
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true })
    await storageRoot.getDirectoryHandle('uploaded-files', { create: true })
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        storage: {
          getDirectory: async () => opfsRoot as unknown as FileSystemDirectoryHandle,
        },
      },
      configurable: true,
    })

    const provider = new OPFSStorageProvider()
    await provider.init()
    const chatMeta: ChatMeta = {
      id: 'chat-1',
      title: 'Main Chat',
      groupId: 'chat-group-1',
      currentLeafId: 'assistant-1',
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
      currentLeafId: 'assistant-1',
      root: {
        items: [{
          id: 'user-1',
          role: 'user',
          content: 'Hello',
          timestamp: 1000,
          replies: {
            items: [{
              id: 'assistant-1',
              role: 'assistant',
              content: 'Hi',
              timestamp: 1001,
              modelId: 'gpt-5',
              replies: { items: [] },
            }],
          },
        }],
      },
    }
    const chatGroup: ChatGroup = {
      id: 'chat-group-1',
      name: 'Research',
      isCollapsed: false,
      updatedAt: 200,
      mounts: [],
      endpoint: {
        type: 'openai',
        url: 'https://example.invalid/v1',
        httpHeaders: [['Authorization', 'group-secret-token']],
      },
      modelId: 'gpt-5',
      autoTitleEnabled: true,
      titleModelId: 'gpt-5-mini',
      systemPrompt: undefined,
      lmParameters: undefined,
      items: [
        {
          id: 'chat:chat-1',
          type: 'chat',
          chat: {
            id: 'chat-1',
            title: 'Main Chat',
            updatedAt: 200,
            groupId: 'chat-group-1',
          },
        },
      ],
    }
    await provider.saveChatMeta(chatMeta)
    await provider.saveChatContent(chatMeta.id, chatContent)
    await provider.saveChatGroup(chatGroup)
    await provider.saveHierarchy({
      items: [{
        type: 'chat_group',
        id: 'chat-group-1',
        chat_ids: ['chat-1'],
      }],
    })
    const storedChatMeta = await provider.loadChatMeta({ id: 'chat-1' })

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'wesh-mounts',
          rootName: 'Files',
          mounts: [{
            type: 'naidan_sysfs',
            path: '/sys/fs/naidan',
            readOnly: true,
            storageType: 'opfs',
            visibility: 'current_chat_with_chat_group',
            currentChatId: 'chat-1',
            currentChatGroupId: 'chat-group-1',
          }],
        },
      },
    })

    const rootListing = await worker.readDirectory({
      request: {
        sessionId,
        path: '/',
      },
    })
    expect(rootListing.entries.map(entry => entry.name)).toEqual(['sys'])

    const sysfsListing = await worker.readDirectory({
      request: {
        sessionId,
        path: '/sys/fs/naidan',
      },
    })
    expect(sysfsListing.entries.map(entry => entry.name)).toEqual([
      'version',
      'current-chat',
      'chats',
      'hierarchy',
      'current-chat-group',
      'chat-groups',
    ])
    expect(sysfsListing.entries.find(entry => entry.name === 'current-chat')).toEqual({
      path: '/sys/fs/naidan/current-chat',
      name: 'current-chat',
      kind: 'directory',
      size: undefined,
      lastModified: undefined,
      extension: '',
      mimeCategory: 'binary',
      readOnly: true,
      canNavigate: true,
      canMutate: false,
    })

    const currentChatListing = await worker.readDirectory({
      request: {
        sessionId,
        path: '/sys/fs/naidan/current-chat',
      },
    })
    expect(currentChatListing.entries.map(entry => entry.name)).toEqual([
      'metadata.md',
      'metadata.json',
      'content-md',
      'content-json',
      'branches',
    ])

    const metadataPreview = await worker.readPreview({
      request: {
        sessionId,
        path: '/sys/fs/naidan/current-chat/metadata.md',
        mode: 'bounded',
      },
    })
    expect(metadataPreview.kind).toBe('text')
    if (metadataPreview.kind === 'text') {
      expect(metadataPreview.rawText).toBe(renderChatMetadataMarkdown({ metadata: storedChatMeta! }))
      expect(metadataPreview.displayText).toBe(renderChatMetadataMarkdown({ metadata: storedChatMeta! }))
    }
  })

  it('reads naidan sysfs metadata through a local remote reader', async () => {
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

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'wesh-mounts',
          rootName: 'Files',
          mounts: [{
            type: 'naidan_sysfs',
            path: '/sys/fs/naidan',
            readOnly: true,
            storageType: 'local',
            visibility: 'current_chat_only',
            currentChatId: 'chat-1',
            currentChatGroupId: 'chat-group-1',
          }],
          naidanSysfsRemoteReader: {
            storageType: 'local',
            async getSidebarStructure() {
              return [{
                id: 'chat-group:chat-group-1',
                type: 'chat_group',
                chatGroup: {
                  dto: chatGroupToDto({ domain: chatGroup }),
                  items: chatGroup.items.map(item => ({
                    id: item.id,
                    type: 'chat',
                    chat: item.chat,
                  })),
                },
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
              return [{
                dto: chatGroupToDto({ domain: chatGroup }),
                items: chatGroup.items.map(item => ({
                  id: item.id,
                  type: 'chat',
                  chat: item.chat,
                })),
              }]
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
      },
    })

    const metadataPreview = await worker.readPreview({
      request: {
        sessionId,
        path: '/sys/fs/naidan/chats/chat-1/metadata.md',
        mode: 'bounded',
      },
    })

    expect(metadataPreview).toEqual({
      kind: 'text',
      rawText: renderChatMetadataMarkdown({ metadata: expectedMetadata }),
      displayText: renderChatMetadataMarkdown({ metadata: expectedMetadata }),
      languageHint: 'markdown',
      oversized: false,
    })
  })
})
