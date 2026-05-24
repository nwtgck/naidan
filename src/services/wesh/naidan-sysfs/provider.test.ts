import { describe, expect, it, vi } from 'vitest'
import type { ChatContent, ChatGroup, ChatMeta } from '@/models/types'
import type { NaidanSysfsStorageReader } from './types'
import { NaidanSysfsProvider } from './provider'
import { NAIDAN_SYSFS_ROOT_PATH, NAIDAN_SYSFS_VERSION_TEXT } from './constants'

function createReaderStub({
  metadata,
  content,
  chatGroup,
}: {
  metadata?: ChatMeta;
  content?: ChatContent;
  chatGroup?: ChatGroup;
}): NaidanSysfsStorageReader {
  return {
    async loadHierarchy(_args: Record<never, never>) {
      return { items: [] }
    },
    async getSidebarStructure(_args: Record<never, never>) {
      if (chatGroup !== undefined) {
        return [{
          id: `chat_group:${chatGroup.id}`,
          type: 'chat_group' as const,
          chatGroup,
        }]
      }
      if (metadata !== undefined) {
        return [{
          id: `chat:${metadata.id}`,
          type: 'chat' as const,
          chat: {
            id: metadata.id,
            title: metadata.title,
            updatedAt: metadata.updatedAt,
            groupId: metadata.groupId ?? null,
          },
        }]
      }
      return []
    },
    async listChats(_args: Record<never, never>) {
      return chatGroup?.items.map(item => item.chat) ?? []
    },
    async listChatGroups(_args: Record<never, never>) {
      return chatGroup === undefined ? [] : [chatGroup]
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
      if (chatGroupId !== chatGroup?.id) {
        return undefined
      }
      return chatGroup
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

const branchingContent: ChatContent = {
  currentLeafId: 'assistant-branch-a2',
  root: {
    items: [
      {
        id: 'user-root',
        role: 'user',
        content: 'Root user',
        timestamp: 2000,
        attachments: [],
        thinking: undefined,
        error: undefined,
        modelId: undefined,
        lmParameters: undefined,
        toolCalls: undefined,
        results: undefined,
        replies: {
          items: [
            {
              id: 'assistant-root',
              role: 'assistant',
              content: 'Root assistant',
              timestamp: 2001,
              attachments: undefined,
              thinking: undefined,
              error: undefined,
              modelId: 'gpt-5',
              lmParameters: undefined,
              toolCalls: undefined,
              results: undefined,
              replies: {
                items: [
                  {
                    id: 'user-branch-a',
                    role: 'user',
                    content: 'Branch A user',
                    timestamp: 2002,
                    attachments: [],
                    thinking: undefined,
                    error: undefined,
                    modelId: undefined,
                    lmParameters: undefined,
                    toolCalls: undefined,
                    results: undefined,
                    replies: {
                      items: [
                        {
                          id: 'assistant-branch-a1',
                          role: 'assistant',
                          content: 'Branch A first leaf',
                          timestamp: 2003,
                          attachments: undefined,
                          thinking: undefined,
                          error: undefined,
                          modelId: 'gpt-5',
                          lmParameters: undefined,
                          toolCalls: undefined,
                          results: undefined,
                          replies: { items: [] },
                        },
                        {
                          id: 'assistant-branch-a2',
                          role: 'assistant',
                          content: 'Branch A current leaf',
                          timestamp: 2004,
                          attachments: undefined,
                          thinking: undefined,
                          error: undefined,
                          modelId: 'gpt-5',
                          lmParameters: undefined,
                          toolCalls: undefined,
                          results: undefined,
                          replies: { items: [] },
                        },
                      ],
                    },
                  },
                  {
                    id: 'user-branch-b',
                    role: 'user',
                    content: 'Branch B user',
                    timestamp: 2005,
                    attachments: [],
                    thinking: undefined,
                    error: undefined,
                    modelId: undefined,
                    lmParameters: undefined,
                    toolCalls: undefined,
                    results: undefined,
                    replies: {
                      items: [
                        {
                          id: 'assistant-branch-b1',
                          role: 'assistant',
                          content: 'Branch B leaf',
                          timestamp: 2006,
                          attachments: undefined,
                          thinking: undefined,
                          error: undefined,
                          modelId: 'gpt-5',
                          lmParameters: undefined,
                          toolCalls: undefined,
                          results: undefined,
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
      },
    ],
  },
}

const sampleChatGroup: ChatGroup = {
  id: 'chat-group-1',
  name: 'Primary Group',
  isCollapsed: false,
  updatedAt: 300,
  endpoint: {
    type: 'openai',
    url: 'https://example.invalid/v1',
    httpHeaders: [['Authorization', 'group-secret-token']],
  },
  modelId: 'gpt-5',
  autoTitleEnabled: true,
  titleModelId: 'gpt-5-mini',
  systemPrompt: { behavior: 'append', content: 'Group prompt.' },
  lmParameters: undefined,
  mounts: [{ type: 'volume', volumeId: 'vol-2', mountPath: '/shared', readOnly: true }],
  items: [
    { id: 'chat-1', type: 'chat', chat: { id: 'chat-1', title: 'Main Chat', updatedAt: 200, groupId: 'chat-group-1' } },
    { id: 'chat-2', type: 'chat', chat: { id: 'chat-2', title: 'Sibling Chat', updatedAt: 250, groupId: 'chat-group-1' } },
  ],
}

describe('NaidanSysfsProvider', () => {
  it('lists version at the sysfs root', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({ chatGroup: sampleChatGroup }),
      visibility: 'current_chat_only',
      currentChatId: 'chat-1',
      currentChatGroupId: 'chat-group-1',
    })

    const entries = []
    for await (const entry of provider.readDir({ path: NAIDAN_SYSFS_ROOT_PATH })) {
      entries.push(entry)
    }

    expect(entries).toEqual([
      { name: 'version', type: 'file', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/version` },
      { name: 'current-chat', type: 'symlink', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/current-chat` },
      { name: 'chats', type: 'directory', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/chats` },
      { name: 'hierarchy', type: 'directory', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/hierarchy` },
      { name: 'current-chat-group', type: 'symlink', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/current-chat-group` },
      { name: 'chat-groups', type: 'directory', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/chat-groups` },
    ])
  })

  it('opens version as a generated text file', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({ chatGroup: sampleChatGroup }),
      visibility: 'current_chat_only',
      currentChatId: 'chat-1',
      currentChatGroupId: 'chat-group-1',
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
      reader: createReaderStub({ chatGroup: sampleChatGroup }),
      visibility: 'current_chat_only',
      currentChatId: 'chat-1',
      currentChatGroupId: 'chat-group-1',
    })

    await expect(provider.open({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/version`,
      flags: { access: 'write', creation: 'if-needed', truncate: 'truncate', append: 'preserve' },
      mode: undefined,
    })).rejects.toThrow('File is read-only')
  })

  it('does not touch the storage reader for version access', async () => {
    const reader = createReaderStub({ chatGroup: sampleChatGroup })
    const loadHierarchy = vi.spyOn(reader, 'loadHierarchy')
    const provider = new NaidanSysfsProvider({
      reader,
      visibility: 'current_chat_only',
      currentChatId: 'chat-1',
      currentChatGroupId: 'chat-group-1',
    })

    await provider.stat({ path: `${NAIDAN_SYSFS_ROOT_PATH}/version` })
    const entries = []
    for await (const entry of provider.readDir({ path: NAIDAN_SYSFS_ROOT_PATH })) {
      entries.push(entry)
    }

    expect(entries).toHaveLength(6)
    expect(loadHierarchy).not.toHaveBeenCalled()
  })

  it('resolves current-chat to the current chat directory', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({ metadata: sampleMetadata }),
      visibility: 'current_chat_only',
      currentChatId: 'chat-1',
      currentChatGroupId: 'chat-group-1',
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
      currentChatGroupId: 'chat-group-1',
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
      currentChatGroupId: 'chat-group-1',
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
      currentChatGroupId: 'chat-group-1',
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
      '1-user.md',
      '2-assistant.md',
      '3-tool.md',
    ])
    expect(jsonEntries.map(entry => entry.name)).toEqual([
      '1-user.json',
      '2-assistant.json',
      '3-tool.json',
    ])
  })

  it('renders content-md with hidden attachments and visible tool results', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({ metadata: sampleMetadata, content: sampleContent }),
      visibility: 'current_chat_only',
      currentChatId: 'chat-1',
      currentChatGroupId: 'chat-group-1',
    })

    const handle = await provider.open({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/content-md/1-user.md`,
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
      mode: undefined,
    })
    const buffer = new Uint8Array(4096)
    const result = await handle.read({ buffer })
    const text = new TextDecoder().decode(buffer.subarray(0, result.bytesRead))

    expect(text).toContain('Hello from the user')
    expect(text).toContain('binary hidden')

    const toolHandle = await provider.open({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/content-md/3-tool.md`,
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
      currentChatGroupId: 'chat-group-1',
    })

    const handle = await provider.open({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/content-json/2-assistant.json`,
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
      mode: undefined,
    })
    const buffer = new Uint8Array(4096)
    const result = await handle.read({ buffer })
    const text = new TextDecoder().decode(buffer.subarray(0, result.bytesRead))

    expect(text).toContain('"shell_execute"')
    expect(text).toContain('"Assistant reply"')
  })

  it('exposes branch tree and leaf views for a branching chat', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({ metadata: sampleMetadata, content: branchingContent }),
      visibility: 'current_chat_only',
      currentChatId: 'chat-1',
      currentChatGroupId: 'chat-group-1',
    })

    const branchEntries = []
    for await (const entry of provider.readDir({ path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/branches` })) {
      branchEntries.push(entry)
    }
    expect(branchEntries.map(entry => entry.name)).toEqual([
      'current-md',
      'current-json',
      'tree-md',
      'tree-json',
      'leaves-md',
      'leaves-json',
    ])

    expect(await provider.readlink({ path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/branches/current-md` }))
      .toBe(`${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/branches/leaves-md/assistant-branch-a2`)

    const treeEntries = []
    for await (const entry of provider.readDir({ path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/branches/tree-md` })) {
      treeEntries.push(entry)
    }
    expect(treeEntries.map(entry => entry.name)).toEqual([
      '1-user-user-root.md',
      '2-assistant-assistant-root.md',
      '3-branch-1',
      '3-branch-2',
    ])

    const branchAEntries = []
    for await (const entry of provider.readDir({ path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/branches/tree-md/3-branch-1` })) {
      branchAEntries.push(entry)
    }
    expect(branchAEntries.map(entry => entry.name)).toEqual([
      '3-user-user-branch-a.md',
      '4-branch-1',
      '4-branch-2',
    ])

    expect(await provider.readlink({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/branches/tree-md/3-branch-1/4-branch-2/branch`,
    })).toBe(`${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/branches/leaves-md/assistant-branch-a2`)

    const leavesEntries = []
    for await (const entry of provider.readDir({ path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/branches/leaves-md` })) {
      leavesEntries.push(entry)
    }
    expect(leavesEntries.map(entry => entry.name)).toEqual([
      'assistant-branch-a1',
      'assistant-branch-a2',
      'assistant-branch-b1',
    ])

    const leafEntries = []
    for await (const entry of provider.readDir({ path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/branches/leaves-md/assistant-branch-a2` })) {
      leafEntries.push(entry)
    }
    expect(leafEntries.map(entry => entry.name)).toEqual([
      'metadata.md',
      'content',
    ])

    const metadataHandle = await provider.open({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/branches/leaves-json/assistant-branch-a2/metadata.json`,
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
      mode: undefined,
    })
    const metadataBuffer = new Uint8Array(4096)
    const metadataResult = await metadataHandle.read({ buffer: metadataBuffer })
    const metadataText = new TextDecoder().decode(metadataBuffer.subarray(0, metadataResult.bytesRead))
    expect(metadataText).toContain('"leafId": "assistant-branch-a2"')
    expect(metadataText).toContain('"isCurrentLeaf": true')
  })

  it('resolves current-chat-group and exposes a restricted chats directory in current_chat_only', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({ metadata: sampleMetadata, chatGroup: sampleChatGroup }),
      visibility: 'current_chat_only',
      currentChatId: 'chat-1',
      currentChatGroupId: 'chat-group-1',
    })

    expect(await provider.readlink({ path: `${NAIDAN_SYSFS_ROOT_PATH}/current-chat-group` })).toBe(`${NAIDAN_SYSFS_ROOT_PATH}/chat-groups/chat-group-1`)

    const entries = []
    for await (const entry of provider.readDir({ path: `${NAIDAN_SYSFS_ROOT_PATH}/chat-groups/chat-group-1` })) {
      entries.push(entry)
    }

    expect(entries).toEqual([
      { name: 'metadata.md', type: 'file', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/chat-groups/chat-group-1/metadata.md` },
      { name: 'metadata.json', type: 'file', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/chat-groups/chat-group-1/metadata.json` },
      { name: 'chats', type: 'directory', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/chat-groups/chat-group-1/chats` },
    ])

    await expect(async () => {
      for await (const _entry of provider.readDir({ path: `${NAIDAN_SYSFS_ROOT_PATH}/chat-groups/chat-group-1/chats` })) {
        // no-op
      }
    }).rejects.toThrow('Permission denied')
  })

  it('lists sibling chat symlinks for current_chat_with_chat_group', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({ metadata: sampleMetadata, chatGroup: sampleChatGroup }),
      visibility: 'current_chat_with_chat_group',
      currentChatId: 'chat-1',
      currentChatGroupId: 'chat-group-1',
    })

    const chatEntries = []
    for await (const entry of provider.readDir({ path: `${NAIDAN_SYSFS_ROOT_PATH}/chats` })) {
      chatEntries.push(entry)
    }
    expect(chatEntries.map(entry => entry.name)).toEqual(['chat-1', 'chat-2'])

    const groupChatEntries = []
    for await (const entry of provider.readDir({ path: `${NAIDAN_SYSFS_ROOT_PATH}/chat-groups/chat-group-1/chats` })) {
      groupChatEntries.push(entry)
    }
    expect(groupChatEntries).toEqual([
      { name: '1-chat-chat-1', type: 'symlink', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/chat-groups/chat-group-1/chats/1-chat-chat-1` },
      { name: '2-chat-chat-2', type: 'symlink', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/chat-groups/chat-group-1/chats/2-chat-chat-2` },
    ])
    expect(await provider.readlink({ path: `${NAIDAN_SYSFS_ROOT_PATH}/chat-groups/chat-group-1/chats/2-chat-chat-2` })).toBe(`${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-2`)
  })

  it('renders chat-group metadata with masked header values', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({ metadata: sampleMetadata, chatGroup: sampleChatGroup }),
      visibility: 'current_chat_only',
      currentChatId: 'chat-1',
      currentChatGroupId: 'chat-group-1',
    })

    const handle = await provider.open({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/chat-groups/chat-group-1/metadata.json`,
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
      mode: undefined,
    })
    const buffer = new Uint8Array(4096)
    const result = await handle.read({ buffer })
    const text = new TextDecoder().decode(buffer.subarray(0, result.bytesRead))

    expect(text).toContain('"chat-group-1"')
    expect(text).toContain('[masked]')
    expect(text).not.toContain('group-secret-token')
  })

  it('exposes hierarchy chat and chat-group symlinks', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({ metadata: sampleMetadata, chatGroup: sampleChatGroup }),
      visibility: 'current_chat_with_chat_group',
      currentChatId: 'chat-1',
      currentChatGroupId: 'chat-group-1',
    })

    const hierarchyEntries = []
    for await (const entry of provider.readDir({ path: `${NAIDAN_SYSFS_ROOT_PATH}/hierarchy` })) {
      hierarchyEntries.push(entry)
    }
    expect(hierarchyEntries).toEqual([
      { name: '1-chat-group-chat-group-1', type: 'symlink', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/hierarchy/1-chat-group-chat-group-1` },
    ])
    expect(await provider.readlink({ path: `${NAIDAN_SYSFS_ROOT_PATH}/hierarchy/1-chat-group-chat-group-1` })).toBe(`${NAIDAN_SYSFS_ROOT_PATH}/chat-groups/chat-group-1`)
  })
})
