import { beforeEach, describe, expect, it } from 'vitest'
import { Wesh } from './index'
import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem'
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from './utils/test-stream'
import { NaidanSysfsProvider } from './naidan-sysfs/provider'
import { NAIDAN_SYSFS_ROOT_PATH } from './naidan-sysfs/constants'
import type { ChatContent, ChatGroup, ChatMeta, Hierarchy, SidebarItem } from '@/models/types'
import type { NaidanSysfsStorageReader } from './naidan-sysfs/types'
import type { NaidanSysfsVisibility } from './types'

function createReaderStub({
  metadataById,
  contentById,
  chatGroups,
  sidebarItems,
  hierarchy,
}: {
  metadataById: Record<string, ChatMeta>;
  contentById: Record<string, ChatContent>;
  chatGroups: ChatGroup[];
  sidebarItems: SidebarItem[];
  hierarchy: Hierarchy;
}): NaidanSysfsStorageReader {
  return {
    async loadHierarchy(_args: Record<never, never>) {
      return hierarchy
    },
    async getSidebarStructure(_args: Record<never, never>) {
      return sidebarItems
    },
    async listChats(_args: Record<never, never>) {
      return Object.values(metadataById).map(({ id, title, updatedAt, groupId }) => ({
        id,
        title,
        updatedAt,
        groupId,
      }))
    },
    async listChatGroups(_args: Record<never, never>) {
      return chatGroups
    },
    async loadChatMeta({ chatId }: { chatId: string }) {
      return metadataById[chatId]
    },
    async loadChatContent({ chatId }: { chatId: string }) {
      return contentById[chatId]
    },
    async loadChat({ chatId }: { chatId: string }) {
      void chatId
      return undefined
    },
    async loadChatGroup({ chatGroupId }: { chatGroupId: string }) {
      return chatGroups.find(({ id }) => id === chatGroupId)
    },
  }
}

const mainChatMetadata: ChatMeta = {
  id: 'chat-1',
  title: 'Main Chat',
  groupId: 'chat-group-1',
  currentLeafId: 'assistant-branch-a2',
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

const siblingChatMetadata: ChatMeta = {
  ...mainChatMetadata,
  id: 'chat-2',
  title: 'Sibling Chat',
  currentLeafId: 'assistant-sibling',
  updatedAt: 250,
}

const individualChatMetadata: ChatMeta = {
  ...mainChatMetadata,
  id: 'chat-3',
  title: 'Individual Chat',
  groupId: null,
  currentLeafId: 'assistant-individual',
  updatedAt: 300,
}

const mainChatContent: ChatContent = {
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

const linearContent = ({
  leafId,
  userId,
  assistantId,
  userText,
  assistantText,
}: {
  leafId: string;
  userId: string;
  assistantId: string;
  userText: string;
  assistantText: string;
}): ChatContent => ({
  currentLeafId: leafId,
  root: {
    items: [
      {
        id: userId,
        role: 'user',
        content: userText,
        timestamp: 3000,
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
              id: assistantId,
              role: 'assistant',
              content: assistantText,
              timestamp: 3001,
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
})

const chatGroup: ChatGroup = {
  id: 'chat-group-1',
  name: 'Primary Group',
  isCollapsed: false,
  updatedAt: 350,
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
    { id: 'chat:chat-1', type: 'chat', chat: { id: 'chat-1', title: 'Main Chat', updatedAt: 200, groupId: 'chat-group-1' } },
    { id: 'chat:chat-2', type: 'chat', chat: { id: 'chat-2', title: 'Sibling Chat', updatedAt: 250, groupId: 'chat-group-1' } },
  ],
}

function createSidebarItems(_args: Record<never, never>): SidebarItem[] {
  return [
    {
      id: 'chat_group:chat-group-1',
      type: 'chat_group',
      chatGroup,
    },
    {
      id: 'chat:chat-3',
      type: 'chat',
      chat: {
        id: 'chat-3',
        title: 'Individual Chat',
        updatedAt: 300,
        groupId: null,
      },
    },
  ]
}

describe('naidan sysfs integration', () => {
  let wesh: Wesh

  async function execute({
    script,
  }: {
    script: string;
  }) {
    const stdout = createTestWriteCaptureHandle()
    const stderr = createTestWriteCaptureHandle()

    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    })

    return { result, stdout, stderr }
  }

  async function createMountedWesh({
    visibility,
  }: {
    visibility: NaidanSysfsVisibility;
  }): Promise<Wesh> {
    const rootHandle = new MockFileSystemDirectoryHandle('root')
    const mountedWesh = new Wesh({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
      initialEnv: {},
    })
    await mountedWesh.init()

    mountedWesh.vfs.mountVirtual({
      path: NAIDAN_SYSFS_ROOT_PATH,
      readOnly: true,
      provider: new NaidanSysfsProvider({
        reader: createReaderStub({
          metadataById: {
            'chat-1': mainChatMetadata,
            'chat-2': siblingChatMetadata,
            'chat-3': individualChatMetadata,
          },
          contentById: {
            'chat-1': mainChatContent,
            'chat-2': linearContent({
              leafId: 'assistant-sibling',
              userId: 'user-sibling',
              assistantId: 'assistant-sibling',
              userText: 'Sibling user',
              assistantText: 'Sibling assistant',
            }),
            'chat-3': linearContent({
              leafId: 'assistant-individual',
              userId: 'user-individual',
              assistantId: 'assistant-individual',
              userText: 'Individual user',
              assistantText: 'Individual assistant',
            }),
          },
          chatGroups: [chatGroup],
          sidebarItems: createSidebarItems({}),
          hierarchy: {
            items: [
              { type: 'chat_group', id: 'chat-group-1', chat_ids: ['chat-1', 'chat-2'] },
              { type: 'chat', id: 'chat-3' },
            ],
          },
        }),
        visibility,
        currentChatId: 'chat-1',
        currentChatGroupId: 'chat-group-1',
      }),
    })

    return mountedWesh
  }

  describe('current_chat_with_chat_group', () => {
    beforeEach(async () => {
      wesh = await createMountedWesh({ visibility: 'current_chat_with_chat_group' })
    })

    it('supports ls, cat, and readlink across the naidan sysfs mount', async () => {
      const lsRoot = await execute({ script: 'ls /sys/fs/naidan' })
      expect(lsRoot.stdout.text).toContain('version')
      expect(lsRoot.stdout.text).toContain('current-chat')
      expect(lsRoot.stdout.text).toContain('chats')
      expect(lsRoot.stderr.text).toBe('')

      const version = await execute({ script: 'cat /sys/fs/naidan/version' })
      expect(version.stdout.text).toContain('.')

      const metadataMarkdown = await execute({ script: 'cat /sys/fs/naidan/chats/chat-1/metadata.md' })
      expect(metadataMarkdown.stdout.text).toContain('# Chat Metadata')
      expect(metadataMarkdown.stdout.text).toContain('[masked]')

      const metadataJson = await execute({ script: 'cat /sys/fs/naidan/chats/chat-1/metadata.json' })
      expect(metadataJson.stdout.text).toContain('"id": "chat-1"')
      expect(metadataJson.stdout.text).toContain('[masked]')

      const contentList = await execute({ script: 'ls /sys/fs/naidan/chats/chat-1/content-md' })
      expect(contentList.stdout.text).toContain('0001-user.md')
      expect(contentList.stdout.text).toContain('0002-assistant.md')

      const contentFile = await execute({ script: 'cat /sys/fs/naidan/chats/chat-1/content-md/0001-user.md' })
      expect(contentFile.stdout.text).toContain('Root user')

      const treeList = await execute({ script: 'ls /sys/fs/naidan/chats/chat-1/branches/tree-md' })
      expect(treeList.stdout.text).toContain('1-user-user-root.md')
      expect(treeList.stdout.text).toContain('3-branch-1')

      const leafMetadata = await execute({ script: 'cat /sys/fs/naidan/chats/chat-1/branches/leaves-md/assistant-branch-a2/metadata.md' })
      expect(leafMetadata.stdout.text).toContain('leafId: assistant-branch-a2')
      expect(leafMetadata.stdout.text).toContain('isCurrentLeaf: true')

      const currentChatLink = await execute({ script: 'readlink /sys/fs/naidan/current-chat' })
      expect(currentChatLink.stdout.text).toBe('/sys/fs/naidan/chats/chat-1\n')

      const currentChatGroupLink = await execute({ script: 'readlink /sys/fs/naidan/current-chat-group' })
      expect(currentChatGroupLink.stdout.text).toBe('/sys/fs/naidan/chat-groups/chat-group-1\n')

      const currentBranchLink = await execute({ script: 'readlink /sys/fs/naidan/chats/chat-1/branches/current-md' })
      expect(currentBranchLink.stdout.text).toBe('/sys/fs/naidan/chats/chat-1/branches/leaves-md/assistant-branch-a2\n')
    })

    it('allows reading sibling chats in the same chat group', async () => {
      const siblingList = await execute({ script: 'ls /sys/fs/naidan/chats' })
      expect(siblingList.stdout.text).toContain('chat-1')
      expect(siblingList.stdout.text).toContain('chat-2')

      const siblingMetadata = await execute({ script: 'cat /sys/fs/naidan/chats/chat-2/metadata.md' })
      expect(siblingMetadata.stdout.text).toContain('id: chat-2')
    })
  })

  describe('current_chat_only', () => {
    beforeEach(async () => {
      wesh = await createMountedWesh({ visibility: 'current_chat_only' })
    })

    it('shows the restricted chats directory but denies traversal', async () => {
      const groupEntries = await execute({ script: 'ls /sys/fs/naidan/chat-groups/chat-group-1' })
      expect(groupEntries.stdout.text).toContain('chats')

      const restricted = await execute({ script: 'ls /sys/fs/naidan/chat-groups/chat-group-1/chats' })
      expect(restricted.stderr.text).toContain('Permission denied')
      expect(restricted.result.exitCode).not.toBe(0)
    })
  })

  describe('all_chats', () => {
    beforeEach(async () => {
      wesh = await createMountedWesh({ visibility: 'all_chats' })
    })

    it('lists hierarchy entries and allows access to individual chats', async () => {
      const hierarchyEntries = await execute({ script: 'ls /sys/fs/naidan/hierarchy' })
      expect(hierarchyEntries.stdout.text).toContain('1-chat-group-chat-group-1')
      expect(hierarchyEntries.stdout.text).toContain('2-chat-chat-3')

      const hierarchyLink = await execute({ script: 'readlink /sys/fs/naidan/hierarchy/2-chat-chat-3' })
      expect(hierarchyLink.stdout.text).toBe('/sys/fs/naidan/chats/chat-3\n')

      const individualChat = await execute({ script: 'cat /sys/fs/naidan/chats/chat-3/metadata.md' })
      expect(individualChat.stdout.text).toContain('id: chat-3')
    })
  })
})
