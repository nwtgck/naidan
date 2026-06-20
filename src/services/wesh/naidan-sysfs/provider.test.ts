import { describe, expect, it, vi } from 'vitest'
import type { BinaryObject, ChatContent, ChatGroup, ChatMeta } from '@/models/types'
import { idToRaw } from '@/models/ids'
import type { BinaryObjectId, ChatGroupId, ChatId } from '@/models/ids'
import type { NaidanSysfsStorageReader } from './types'
import { NaidanSysfsProvider } from './provider'
import { NAIDAN_SYSFS_ROOT_PATH, NAIDAN_SYSFS_VERSION_TEXT } from './constants'
import { createNaidanSysfsBinaryObject } from './binary-object-metadata'
import { toAttachmentId, toBinaryObjectId, toChatGroupId, toChatId, toMessageId, toToolCallId, toVolumeId } from '@/models/ids';

function createReaderStub({
  metadata,
  content,
  chatGroup,
  binaryObjects,
  binaryObjectBlobs,
}: {
  metadata?: ChatMeta;
  content?: ChatContent;
  chatGroup?: ChatGroup;
  binaryObjects?: BinaryObject[];
  binaryObjectBlobs?: Record<string, Blob>;
}): NaidanSysfsStorageReader {
  const objects = new Map((binaryObjects ?? []).map(object => [object.id, createNaidanSysfsBinaryObject({ object: { ...object, id: idToRaw({ id: object.id }) } })]))
  return {
    async loadHierarchy() {
      return { items: [] }
    },
    async getSidebarStructure() {
      if (chatGroup !== undefined) {
        return [{
          id: `chat_group:${idToRaw({ id: chatGroup.id })}`,
          type: 'chat_group' as const,
          chatGroup,
        }]
      }
      if (metadata !== undefined) {
        return [{
          id: `chat:${idToRaw({ id: metadata.id })}`,
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
    async listChats() {
      return chatGroup?.items.map(item => item.chat) ?? []
    },
    async listChatGroups() {
      return chatGroup === undefined ? [] : [chatGroup]
    },
    async loadChatMeta({ chatId }: { chatId: ChatId }) {
      if (chatId !== metadata?.id) {
        return undefined
      }
      return metadata
    },
    async loadChatContent({ chatId }: { chatId: ChatId }) {
      if (chatId !== metadata?.id) {
        return undefined
      }
      return content
    },
    async loadChat({ chatId }: { chatId: ChatId }) {
      if (chatId !== metadata?.id || metadata === undefined || content === undefined) {
        return undefined
      }
      return {
        id: metadata.id,
        title: metadata.title,
        groupId: metadata.groupId,
        root: content.root,
        currentLeafId: content.currentLeafId ?? metadata.currentLeafId,
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
        debugEnabled: metadata.debugEnabled,
        endpointType: metadata.endpoint?.type,
        endpointUrl: metadata.endpoint?.url,
        endpointHttpHeaders: metadata.endpoint?.httpHeaders,
        modelId: metadata.modelId,
        autoTitleEnabled: metadata.autoTitleEnabled,
        titleModelId: metadata.titleModelId,
        originChatId: metadata.originChatId,
        originMessageId: metadata.originMessageId,
        systemPrompt: metadata.systemPrompt,
        lmParameters: metadata.lmParameters,
        mounts: metadata.mounts,
        toolConfigs: metadata.toolConfigs,
      }
    },
    async loadChatGroup({ chatGroupId }: { chatGroupId: ChatGroupId }) {
      if (chatGroupId !== chatGroup?.id) {
        return undefined
      }
      return chatGroup
    },
    async *listBinaryObjects() {
      for (const object of objects.values()) {
        yield object
      }
    },
    async getBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }) {
      return objects.get(binaryObjectId)
    },
    async getBinaryObjectBlob({ binaryObjectId }: { binaryObjectId: BinaryObjectId }) {
      return binaryObjectBlobs?.[idToRaw({ id: binaryObjectId })]
    },
  }
}

const sampleMetadata: ChatMeta = {
  id: toChatId({ raw: 'chat-1' }),
  title: 'Main Chat',
  groupId: toChatGroupId({ raw: 'chat-group-1' }),
  currentLeafId: toMessageId({ raw: 'leaf-1' }),
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
  originChatId: toChatId({ raw: 'origin-chat' }),
  originMessageId: toMessageId({ raw: 'origin-message' }),
  systemPrompt: { behavior: 'append', content: 'Be concise.' },
  lmParameters: undefined,
  mounts: [{ type: 'volume', volumeId: toVolumeId({ raw: 'vol-1' }), mountPath: '/data', readOnly: true }],
}

const sampleIndividualChatMetadata: ChatMeta = {
  ...sampleMetadata,
  id: toChatId({ raw: 'chat-3' }),
  title: 'Individual Chat',
  groupId: null,
  currentLeafId: toMessageId({ raw: 'Ra2iS1T2u3V4w5X6y7Z8' }),
  updatedAt: 300,
}

const sampleContent: ChatContent = {
  currentLeafId: toMessageId({ raw: 'Wt3lL1M2n3P4q5R6s7T8' }),
  root: {
    items: [
      {
        id: toMessageId({ raw: 'Yu1lA1B2c3D4e5F6g7H8' }),
        role: 'user',
        content: 'Hello from the user',
        timestamp: 1000,
        attachments: [{
          id: toAttachmentId({ raw: 'att-1' }),
          binaryObjectId: toBinaryObjectId({ raw: 'bin-1' }),
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
              id: toMessageId({ raw: 'Za2lF6G7h8J9k0L1m2N3' }),
              role: 'assistant',
              content: 'Assistant reply',
              timestamp: 1001,
              thinking: 'internal thought',
              error: undefined,
              modelId: 'gpt-5',
              lmParameters: undefined,
              toolCalls: [{
                id: toToolCallId({ raw: 'tool-call-1' }),
                type: 'function',
                function: {
                  name: 'shell_execute',
                  arguments: '{"cmd":"echo hi"}',
                },
              }],
              replies: {
                items: [
                  {
                    id: toMessageId({ raw: 'Wt3lL1M2n3P4q5R6s7T8' }),
                    role: 'tool',
                    content: undefined,
                    attachments: undefined,
                    thinking: undefined,
                    error: undefined,
                    modelId: undefined,
                    lmParameters: undefined,
                    toolCalls: undefined,
                    results: [{
                      toolCallId: toToolCallId({ raw: 'tool-call-1' }),
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
  currentLeafId: toMessageId({ raw: 'Xa4aX1Y2z3A4b5C6d7E8' }),
  root: {
    items: [
      {
        id: toMessageId({ raw: 'Ku1rA1B2c3D4e5F6g7H8' }),
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
              id: toMessageId({ raw: 'La2rF6G7h8J9k0L1m2N3' }),
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
                    id: toMessageId({ raw: 'Mu3aL1M2n3P4q5R6s7T8' }),
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
                          id: toMessageId({ raw: 'Na4bR6S7t8V9w0X1y2Z3' }),
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
                          id: toMessageId({ raw: 'Xa4aX1Y2z3A4b5C6d7E8' }),
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
                    id: toMessageId({ raw: 'Pu3bC6D7e8F9g0H1i2J3' }),
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
                          id: toMessageId({ raw: 'Sa4cH1J2k3L4m5N6p7Q8' }),
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
  id: toChatGroupId({ raw: 'chat-group-1' }),
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
  mounts: [{ type: 'volume', volumeId: toVolumeId({ raw: 'vol-2' }), mountPath: '/shared', readOnly: true }],
  items: [
    { id: 'chat-1', type: 'chat', chat: { id: toChatId({ raw: 'chat-1' }), title: 'Main Chat', updatedAt: 200, groupId: toChatGroupId({ raw: 'chat-group-1' }) } },
    { id: 'chat-2', type: 'chat', chat: { id: toChatId({ raw: 'chat-2' }), title: 'Sibling Chat', updatedAt: 250, groupId: toChatGroupId({ raw: 'chat-group-1' }) } },
  ],
}

const sampleBinaryObject: BinaryObject = {
  id: toBinaryObjectId({ raw: 'bin-1' }),
  name: 'note.pdf',
  mimeType: 'application/pdf',
  size: 4,
  createdAt: 999,
}

const sampleBinaryObjectBytes = new Uint8Array([0x41, 0x42, 0x43, 0x44])
const sampleBinaryObjectBlob = createBlobStub({ bytes: sampleBinaryObjectBytes }) as unknown as Blob

function createBlobStub({
  bytes,
}: {
  bytes: Uint8Array;
}) {
  return {
    size: bytes.length,
    slice(start?: number, end?: number) {
      const sliced = bytes.slice(start ?? 0, end ?? bytes.length)
      return {
        arrayBuffer: async () => sliced.buffer.slice(sliced.byteOffset, sliced.byteOffset + sliced.byteLength),
      }
    },
  }
}

describe('NaidanSysfsProvider', () => {
  it('lists version at the sysfs root', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({ chatGroup: sampleChatGroup }),
      visibility: 'current_chat_only',
      binaryObjectAccess: 'data',
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
      { name: 'binary-objects', type: 'directory', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/binary-objects` },
      { name: 'current-chat-group', type: 'symlink', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/current-chat-group` },
      { name: 'chat-groups', type: 'directory', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/chat-groups` },
    ])
  })

  it('lists chat-groups without current-chat-group for main_chats when the current chat is not in a chat group', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({ metadata: sampleIndividualChatMetadata, chatGroup: sampleChatGroup }),
      visibility: 'main_chats',
      binaryObjectAccess: 'data',
      currentChatId: 'chat-3',
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
      { name: 'hierarchy', type: 'directory', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/hierarchy` },
      { name: 'binary-objects', type: 'directory', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/binary-objects` },
      { name: 'chat-groups', type: 'directory', fullPath: `${NAIDAN_SYSFS_ROOT_PATH}/chat-groups` },
    ])
  })

  it('opens version as a generated text file', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({ chatGroup: sampleChatGroup }),
      visibility: 'current_chat_only',
      binaryObjectAccess: 'data',
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
      binaryObjectAccess: 'data',
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
      binaryObjectAccess: 'data',
      currentChatId: 'chat-1',
      currentChatGroupId: 'chat-group-1',
    })

    await provider.stat({ path: `${NAIDAN_SYSFS_ROOT_PATH}/version` })
    const entries = []
    for await (const entry of provider.readDir({ path: NAIDAN_SYSFS_ROOT_PATH })) {
      entries.push(entry)
    }

    expect(entries).toHaveLength(7)
    expect(loadHierarchy).not.toHaveBeenCalled()
  })

  it('hides binary-objects when binaryObjectAccess is none', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({ chatGroup: sampleChatGroup }),
      visibility: 'current_chat_only',
      binaryObjectAccess: 'none',
      currentChatId: 'chat-1',
      currentChatGroupId: 'chat-group-1',
    })

    const entries = []
    for await (const entry of provider.readDir({ path: NAIDAN_SYSFS_ROOT_PATH })) {
      entries.push(entry.name)
    }

    expect(entries).not.toContain('binary-objects')
    await expect(async () => {
      for await (const _entry of provider.readDir({ path: `${NAIDAN_SYSFS_ROOT_PATH}/binary-objects` })) {
        void _entry
      }
    }).rejects.toThrow(/Path not found/i)
  })

  it('lists binary objects and renders metadata when binaryObjectAccess is metadata_only', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({
        binaryObjects: [sampleBinaryObject],
      }),
      visibility: 'current_chat_only',
      binaryObjectAccess: 'metadata_only',
      currentChatId: 'chat-1',
      currentChatGroupId: 'chat-group-1',
    })

    const rootEntries = []
    for await (const entry of provider.readDir({ path: `${NAIDAN_SYSFS_ROOT_PATH}/binary-objects` })) {
      rootEntries.push(entry.name)
    }
    expect(rootEntries).toEqual(['by-id'])

    const byIdEntries = []
    for await (const entry of provider.readDir({ path: `${NAIDAN_SYSFS_ROOT_PATH}/binary-objects/by-id` })) {
      byIdEntries.push(entry.name)
    }
    expect(byIdEntries).toEqual(['bin-1'])

    const objectEntries = []
    for await (const entry of provider.readDir({ path: `${NAIDAN_SYSFS_ROOT_PATH}/binary-objects/by-id/bin-1` })) {
      objectEntries.push(entry.name)
    }
    expect(objectEntries).toEqual(['metadata.json', 'metadata.md'])

    const handle = await provider.open({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/binary-objects/by-id/bin-1/metadata.json`,
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
      mode: undefined,
    })
    const buffer = new Uint8Array(1024)
    const result = await handle.read({ buffer })
    const text = new TextDecoder().decode(buffer.subarray(0, result.bytesRead))

    expect(text).toContain('"id": "bin-1"')
    expect(text).toContain('"name": "note.pdf"')
    expect(text).not.toContain('paths')

    await expect(provider.open({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/binary-objects/by-id/bin-1/data`,
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
      mode: undefined,
    })).rejects.toThrow(/Path not found/i)
  })

  it('reads binary object data when binaryObjectAccess is data', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({
        binaryObjects: [sampleBinaryObject],
        binaryObjectBlobs: { 'bin-1': sampleBinaryObjectBlob },
      }),
      visibility: 'current_chat_only',
      binaryObjectAccess: 'data',
      currentChatId: 'chat-1',
      currentChatGroupId: 'chat-group-1',
    })

    const handle = await provider.open({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/binary-objects/by-id/bin-1/data`,
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
      mode: undefined,
    })

    const partialBuffer = new Uint8Array(2)
    const partial = await handle.read({ buffer: partialBuffer, position: 1 })
    expect(partial.bytesRead).toBe(2)
    expect(Array.from(partialBuffer)).toEqual([0x42, 0x43])

    const stat = await handle.stat()
    expect(stat.size).toBe(4)

    await expect(handle.write({ buffer: new Uint8Array(0) })).rejects.toThrow('File is read-only')
    await expect(handle.truncate({ size: 1 })).rejects.toThrow('File is read-only')
  })

  it('resolves current-chat to the current chat directory', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({ metadata: sampleMetadata }),
      visibility: 'current_chat_only',
      binaryObjectAccess: 'data',
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
      binaryObjectAccess: 'data',
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
      binaryObjectAccess: 'data',
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
      binaryObjectAccess: 'data',
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
      '1-user-Yu1lA1B2c3D4e5F6g7H8.md',
      '2-assistant-Za2lF6G7h8J9k0L1m2N3.md',
      '3-tool-Wt3lL1M2n3P4q5R6s7T8.md',
    ])
    expect(jsonEntries.map(entry => entry.name)).toEqual([
      '1-user-Yu1lA1B2c3D4e5F6g7H8.json',
      '2-assistant-Za2lF6G7h8J9k0L1m2N3.json',
      '3-tool-Wt3lL1M2n3P4q5R6s7T8.json',
    ])
  })

  it('loads a chat once while iterating and opening direct content entries', async () => {
    const reader = createReaderStub({ metadata: sampleMetadata, content: sampleContent })
    const loadChat = vi.spyOn(reader, 'loadChat')
    const provider = new NaidanSysfsProvider({
      reader,
      visibility: 'current_chat_only',
      binaryObjectAccess: 'data',
      currentChatId: 'chat-1',
      currentChatGroupId: 'chat-group-1',
    })

    const directory = await provider.resolveEntryRef({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/content-md`,
      finalSymlinkTreatment: 'follow',
    })
    expect(directory.type).toBe('directory')
    if (directory.type !== 'directory') {
      throw new Error('Expected content-md to resolve as a directory')
    }

    const children = []
    for await (const child of directory.readDir()) {
      children.push(child)
    }
    expect(children).toHaveLength(3)
    expect(loadChat).toHaveBeenCalledTimes(1)

    const first = children[0]
    expect(first?.type).toBe('file')
    if (first?.type !== 'file') {
      throw new Error('Expected the first content entry to be a file')
    }
    const handle = await first.open({
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
      mode: undefined,
    })
    const buffer = new Uint8Array(4096)
    const result = await handle.read({ buffer })
    expect(new TextDecoder().decode(buffer.subarray(0, result.bytesRead))).toContain('Hello from the user')
    expect(loadChat).toHaveBeenCalledTimes(1)
  })

  it('renders content-md with hidden attachments and visible tool results', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({ metadata: sampleMetadata, content: sampleContent }),
      visibility: 'current_chat_only',
      binaryObjectAccess: 'data',
      currentChatId: 'chat-1',
      currentChatGroupId: 'chat-group-1',
    })

    const handle = await provider.open({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/content-md/1-user-Yu1lA1B2c3D4e5F6g7H8.md`,
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
      mode: undefined,
    })
    const buffer = new Uint8Array(4096)
    const result = await handle.read({ buffer })
    const text = new TextDecoder().decode(buffer.subarray(0, result.bytesRead))

    expect(text).toContain('Hello from the user')
    expect(text).toContain('binary hidden')

    const toolHandle = await provider.open({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/content-md/3-tool-Wt3lL1M2n3P4q5R6s7T8.md`,
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
      binaryObjectAccess: 'data',
      currentChatId: 'chat-1',
      currentChatGroupId: 'chat-group-1',
    })

    const handle = await provider.open({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/content-json/2-assistant-Za2lF6G7h8J9k0L1m2N3.json`,
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
      binaryObjectAccess: 'data',
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
      .toBe(`${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/branches/leaves-md/Xa4aX1Y2z3A4b5C6d7E8`)

    const treeEntries = []
    for await (const entry of provider.readDir({ path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/branches/tree-md` })) {
      treeEntries.push(entry)
    }
    expect(treeEntries.map(entry => entry.name)).toEqual([
      '1-user-Ku1rA1B2c3D4e5F6g7H8.md',
      '2-assistant-La2rF6G7h8J9k0L1m2N3.md',
      '3-branch-1',
      '3-branch-2',
    ])

    const branchAEntries = []
    for await (const entry of provider.readDir({ path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/branches/tree-md/3-branch-1` })) {
      branchAEntries.push(entry)
    }
    expect(branchAEntries.map(entry => entry.name)).toEqual([
      '3-user-Mu3aL1M2n3P4q5R6s7T8.md',
      '4-branch-1',
      '4-branch-2',
    ])

    expect(await provider.readlink({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/branches/tree-md/3-branch-1/4-branch-2/branch`,
    })).toBe(`${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/branches/leaves-md/Xa4aX1Y2z3A4b5C6d7E8`)

    const leavesEntries = []
    for await (const entry of provider.readDir({ path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/branches/leaves-md` })) {
      leavesEntries.push(entry)
    }
    expect(leavesEntries.map(entry => entry.name)).toEqual([
      'Na4bR6S7t8V9w0X1y2Z3',
      'Xa4aX1Y2z3A4b5C6d7E8',
      'Sa4cH1J2k3L4m5N6p7Q8',
    ])

    const leafEntries = []
    for await (const entry of provider.readDir({ path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/branches/leaves-md/Xa4aX1Y2z3A4b5C6d7E8` })) {
      leafEntries.push(entry)
    }
    expect(leafEntries.map(entry => entry.name)).toEqual([
      'metadata.md',
      'content',
    ])

    const metadataHandle = await provider.open({
      path: `${NAIDAN_SYSFS_ROOT_PATH}/chats/chat-1/branches/leaves-json/Xa4aX1Y2z3A4b5C6d7E8/metadata.json`,
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
      mode: undefined,
    })
    const metadataBuffer = new Uint8Array(4096)
    const metadataResult = await metadataHandle.read({ buffer: metadataBuffer })
    const metadataText = new TextDecoder().decode(metadataBuffer.subarray(0, metadataResult.bytesRead))
    expect(metadataText).toContain('"leafId": "Xa4aX1Y2z3A4b5C6d7E8"')
    expect(metadataText).toContain('"isCurrentLeaf": true')
  })

  it('resolves current-chat-group and exposes a restricted chats directory in current_chat_only', async () => {
    const provider = new NaidanSysfsProvider({
      reader: createReaderStub({ metadata: sampleMetadata, chatGroup: sampleChatGroup }),
      visibility: 'current_chat_only',
      binaryObjectAccess: 'data',
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
      binaryObjectAccess: 'data',
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
      binaryObjectAccess: 'data',
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
      binaryObjectAccess: 'data',
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
