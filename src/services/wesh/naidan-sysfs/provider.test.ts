import { describe, expect, it, vi } from 'vitest'
import type { ChatMeta } from '@/models/types'
import type { NaidanSysfsStorageReader } from './types'
import { NaidanSysfsProvider } from './provider'
import { NAIDAN_SYSFS_ROOT_PATH, NAIDAN_SYSFS_VERSION_TEXT } from './constants'

function createReaderStub({
  metadata,
}: {
  metadata?: ChatMeta;
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
      void chatId
      return undefined
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
})
