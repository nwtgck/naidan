import { describe, expect, it, vi } from 'vitest'
import type { ChatContent, ChatMeta } from '@/models/types'
import type { NaidanSysfsStorageReader } from './types'
import { NaidanSysfsProvider } from './provider'
import { NAIDAN_SYSFS_ROOT_PATH, NAIDAN_SYSFS_VERSION_TEXT } from './constants'

function createReaderStub({
  metadata,
  content,
}: {
  metadata?: ChatMeta;
  content?: ChatContent;
}): NaidanSysfsStorageReader {
  return {
    async loadHierarchy(_args: Record<never, never>) {
      return { items: [] }
    },
    async getSidebarStructure(_args: Record<never, never>) {
      return []
    },
    async listChats(_args: Record<never, never>) {
      return []
    },
    async listChatGroups(_args: Record<never, never>) {
      return []
    },
    async loadChatMeta({ chatId }: { chatId: string }) {
      if (chatId !== metadata?.id) {
        return undefined
      }
      return metadata
    },
    async loadChatContent({ chatId }: { chatId: string }) {
      if (chatId !== metadata?.id) {
        return undefined
      }
      return content
    },
    async loadChat({ chatId }: { chatId: string }) {
      void chatId
      return undefined
    },
    async loadChatGroup({ chatGroupId }: { chatGroupId: string }) {
      void chatGroupId
      return undefined
    },
  }
}

const sampleMetadata: ChatMeta = {
  id: 'chat-1',
  title: 'Main Chat',
  groupId: 'chat-group-1',
  currentLeafId: 'leaf-1',
  createdAt: 100,
  updatedAt: 200,
  debugEnabled: true,
  endpoint: {
    type: 'openai',
    url: 'https://example.invalid/v1',
    httpHeaders: [['Authorization', 'secret-token']],
  },
  modelId: 'gpt-5',
  autoTitleEnabled: true,
  titleModelId: 'gpt-5-mini',
  originChatId: 'origin-chat',
  originMessageId: 'origin-message',
  systemPrompt: { behavior: 'append', content: 'Be concise.' },
  lmParameters: undefined,
  mounts: [{ type: 'volume', volumeId: 'vol-1', mountPath: '/data', readOnly: true }],
}

const sampleContent: ChatContent = {
  currentLeafId: 'tool-1',
  root: {
    items: [
      {
        id: 'user-1',
        role: 'user',
        content: 'Hello from the user',
        timestamp: 1000,
        attachments: [{
          id: 'att-1',
          binaryObjectId: 'bin-1',
          originalName: 'note.pdf',
          mimeType: 'application/pdf',
          size: 1234,
          uploadedAt: 999,
          status: 'persisted',
        }],
        lmParameters: undefined,
        replies: {
          items: [
            {
              id: 'assistant-1',
              role: 'assistant',
              content: 'Assistant reply',
              timestamp: 1001,
              thinking: 'internal thought',
              error: undefined,
              modelId: 'gpt-5',
              lmParameters: undefined,
              toolCalls: [{
                id: 'tool-call-1',
                type: 'function',
                function: {
                  name: 'shell_execute',
                  arguments: '{"cmd":"echo hi"}',
                },
              }],
              replies: {
                items: [
                  {
                    id: 'tool-1',
                    role: 'tool',
                    content: undefined,
                    attachments: undefined,
                    thinking: undefined,
                    error: undefined,
                    modelId: undefined,
                    lmParameters: undefined,
                    toolCalls: undefined,
                    results: [{
                      toolCallId: 'tool-call-1',
                      status: 'success',
                      content: {
                        type: 'text',
                        text: 'tool output',
                      },
                    }],
                    timestamp: 1002,
                    replies: { items: [] },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  },
}

describe('NaidanSysfsProvider', () => {
  it('lists version at the sysfs root', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({}),
      visibility: 'current_chat_only',
      currentChatId: 'chat-1',
      currentChatGroupId: undefined,
    })

    const entries = []
    for await (const entry of provider.readDir({ path: NAIDAN_SYSFS_ROOT_PATH })) {
      entries.push(entry)
    }

    expect(entries).toEqual([
      { name: 'version', type: 'file', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/version` },
      { name: 'current-chat', type: 'symlink', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/current-chat` },
      { name: 'chats', type: 'directory', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/chats` },
    ])
  })

  it('opens version as a generated text file', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({}),
      visibility: 'current_chat_only',
      currentChatId: 'chat-1',
      currentChatGroupId: undefined,
    })

    const handle = await provider.open({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/version`,
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
      mode: undefined,
    })
    const buffer = new Uint8Array(64)
    const result = await handle.read({ buffer })

    expect(new TextDecoder().decode(buffer.subarray(0, result.bytesRead))).toBe(NAIDAN_SYSFS_VERSION_TEXT)
  })

  it('rejects write opens for generated files', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({}),
      visibility: 'current_chat_only',
      currentChatId: 'chat-1',
      currentChatGroupId: undefined,
    })

    await expect(provider.open({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/version`,
      flags: { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' },
      mode: undefined,
    })).rejects.toThrow('File is read-only')
  })

  it('does not touch the storage reader for version access', async () => {
    const reader = createReaderStub({})
    const loadHierarchy = vi.spyOn(reader, 'loadHierarchy')
    const provider = new NaidanSysfsProvider({
      reader,
      visibility: 'current_chat_only',
      currentChatId: 'chat-1',
      currentChatGroupId: undefined,
    })

    await provider.stat({ path: `${NAIDAN_SYSFS_ROOT_PATH}/version` })
    const entries = []
    for await (const entry of provider.readDir({ path: NAIDAN_SYSFS_ROOT_PATH })) {
      entries.push(entry)
    }

    expect(entries).toHaveLength(3)
    expect(loadHierarchy).not.toHaveBeenCalled()
  })

  it('resolves current-chat to the current chat directory', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({ metadata: sampleMetadata }),
      visibility: 'current_chat_only',
      currentChatId: 'chat-1',
      currentChatGroupId: undefined,
    })

    expect(await provider.readlink({ path: `${NAIDAN_SYSFS_ROOT_PATH}/current-chat` })).toBe(`${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1`)

    const entries = []
    for await (const entry of provider.readDir({ path: `${NAIDAN_SYSFS_ROOT_PATH}/chats` })) {
      entries.push(entry)
    }

    expect(entries).toEqual([
      { name: 'chat-1', type: 'directory', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1` },
    ])
  })

  it('renders metadata.json with masked header values', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({ metadata: sampleMetadata }),
      visibility: 'current_chat_only',
      currentChatId: 'chat-1',
      currentChatGroupId: undefined,
    })

    const handle = await provider.open({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/metadata.json`,
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
      mode: undefined,
    })
    const buffer = new Uint8Array(4096)
    const result = await handle.read({ buffer })
    const text = new TextDecoder().decode(buffer.subarray(0, result.bytesRead))

    expect(text).toContain('"id": "chat-1"')
    expect(text).toContain('"Authorization"')
    expect(text).toContain('[masked]')
    expect(text).not.toContain('secret-token')
  })

  it('renders metadata.md with masked header values', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({ metadata: sampleMetadata }),
      visibility: 'current_chat_only',
      currentChatId: 'chat-1',
      currentChatGroupId: undefined,
    })

    const handle = await provider.open({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/metadata.md`,
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
      mode: undefined,
    })
    const buffer = new Uint8Array(4096)
    const result = await handle.read({ buffer })
    const text = new TextDecoder().decode(buffer.subarray(0, result.bytesRead))

    expect(text).toContain('# Chat Metadata')
    expect(text).toContain('id: chat-1')
    expect(text).toContain('[masked]')
    expect(text).not.toContain('secret-token')
  })

  it('lists current branch messages under content-md and content-json', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({ metadata: sampleMetadata, content: sampleContent }),
      visibility: 'current_chat_only',
      currentChatId: 'chat-1',
      currentChatGroupId: undefined,
    })

    const markdownEntries = []
    for await (const entry of provider.readDir({ path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/content-md` })) {
      markdownEntries.push(entry)
    }

    const jsonEntries = []
    for await (const entry of provider.readDir({ path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/content-json` })) {
      jsonEntries.push(entry)
    }

    expect(markdownEntries.map(entry => entry.name)).toEqual([
      '0001-user.md',
      '0002-assistant.md',
      '0003-tool.md',
    ])
    expect(jsonEntries.map(entry => entry.name)).toEqual([
      '0001-user.json',
      '0002-assistant.json',
      '0003-tool.json',
    ])
  })

  it('renders content-md with hidden attachments and visible tool results', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({ metadata: sampleMetadata, content: sampleContent }),
      visibility: 'current_chat_only',
      currentChatId: 'chat-1',
      currentChatGroupId: undefined,
    })

    const handle = await provider.open({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/content-md/0001-user.md`,
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
      mode: undefined,
    })
    const buffer = new Uint8Array(4096)
    const result = await handle.read({ buffer })
    const text = new TextDecoder().decode(buffer.subarray(0, result.bytesRead))

    expect(text).toContain('Hello from the user')
    expect(text).toContain('binary hidden')

    const toolHandle = await provider.open({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/content-md/0003-tool.md`,
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
      mode: undefined,
    })
    const toolBuffer = new Uint8Array(4096)
    const toolResult = await toolHandle.read({ buffer: toolBuffer })
    const toolText = new TextDecoder().decode(toolBuffer.subarray(0, toolResult.bytesRead))

    expect(toolText).toContain('tool output')
  })

  it('renders content-json with tool call data', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({ metadata: sampleMetadata, content: sampleContent }),
      visibility: 'current_chat_only',
      currentChatId: 'chat-1',
      currentChatGroupId: undefined,
    })

    const handle = await provider.open({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/content-json/0002-assistant.json`,
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
      mode: undefined,
    })
    const buffer = new Uint8Array(4096)
    const result = await handle.read({ buffer })
    const text = new TextDecoder().decode(buffer.subarray(0, result.bytesRead))

    expect(text).toContain('"shell_execute"')
    expect(text).toContain('"Assistant reply"')
  })
})
