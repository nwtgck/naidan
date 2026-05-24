import { MockFileSystemDirectoryHandle } from './mocks/InMemoryFileSystem'
import { Wesh } from './index'
import { NaidanSysfsProvider } from './naidan-sysfs/provider'
import { NAIDAN_SYSFS_ROOT_PATH } from './naidan-sysfs/constants'
import type { ChatContent, ChatGroup, ChatMeta, Hierarchy, SidebarItem } from '@/models/types'
import type { NaidanSysfsStorageReader } from './naidan-sysfs/types'
import type { NaidanSysfsVisibility } from './types'
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from './utils/test-stream'

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

export const mainChatMetadata: ChatMeta = {
  id: 'chat-1',
  title: 'Main Chat',
  groupId: 'chat-group-1',
  currentLeafId: 'msg_assistant_branch_a2_x1Y2z3A4b5',
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

export const siblingChatMetadata: ChatMeta = {
  ...mainChatMetadata,
  id: 'chat-2',
  title: 'Sibling Chat',
  currentLeafId: 'msg_assistant_sibling_n6O7p8Q9r0',
  updatedAt: 250,
}

export const individualChatMetadata: ChatMeta = {
  ...mainChatMetadata,
  id: 'chat-3',
  title: 'Individual Chat',
  groupId: null,
  currentLeafId: 'msg_assistant_individual_s1T2u3V4w5',
  updatedAt: 300,
}

export const mainChatContent: ChatContent = {
  currentLeafId: 'msg_assistant_branch_a2_x1Y2z3A4b5',
  root: {
    items: [
      {
        id: 'msg_user_root_a1B2c3D4e5',
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
              id: 'msg_assistant_root_f6G7h8J9k0',
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
                    id: 'msg_user_branch_a_l1M2n3P4q5',
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
                          id: 'msg_assistant_branch_a1_r6S7t8V9w0',
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
                          id: 'msg_assistant_branch_a2_x1Y2z3A4b5',
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
                    id: 'msg_user_branch_b_c6D7e8F9g0',
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
                          id: 'msg_assistant_branch_b1_h1J2k3L4m5',
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

function createLinearContent({
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
}): ChatContent {
  return {
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
  }
}

export const siblingChatContent = createLinearContent({
  leafId: 'msg_assistant_sibling_n6O7p8Q9r0',
  userId: 'msg_user_sibling_m1N2o3P4q5',
  assistantId: 'msg_assistant_sibling_n6O7p8Q9r0',
  userText: 'Sibling user',
  assistantText: 'Sibling assistant',
})

export const individualChatContent = createLinearContent({
  leafId: 'msg_assistant_individual_s1T2u3V4w5',
  userId: 'msg_user_individual_r6S7t8U9v0',
  assistantId: 'msg_assistant_individual_s1T2u3V4w5',
  userText: 'Individual user',
  assistantText: 'Individual assistant',
})

export const chatGroup: ChatGroup = {
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

export async function createMountedNaidanSysfsWesh({
  visibility,
}: {
  visibility: NaidanSysfsVisibility;
}): Promise<Wesh> {
  const rootHandle = new MockFileSystemDirectoryHandle('root')
  const wesh = new Wesh({
    rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
    initialEnv: {},
  })
  await wesh.init()

  wesh.vfs.mountVirtual({
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
          'chat-2': siblingChatContent,
          'chat-3': individualChatContent,
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

  return wesh
}

export async function executeInWesh({
  wesh,
  script,
}: {
  wesh: Wesh;
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
