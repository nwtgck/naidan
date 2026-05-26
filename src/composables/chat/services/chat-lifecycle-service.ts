import { reactive, toRaw, type Ref } from 'vue';
import { generateId } from '@/utils/id';
import type { Chat, ChatGroup, Hierarchy, HierarchyChatGroupNode, SystemPrompt } from '@/models/types';

export interface AddToastOptions {
  message: string;
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
  onClose?: (reason: 'timeout' | 'dismiss' | 'action') => void | Promise<void>;
  duration?: number;
}

export type ChatLifecycleService = {
  createNewChat({
    groupId,
    modelId,
    systemPrompt,
  }: {
    groupId: string | undefined;
    modelId: string | undefined;
    systemPrompt: SystemPrompt | undefined;
  }): Promise<Chat | null>;

  deleteChat({
    id,
    injectAddToast,
  }: {
    id: string;
    injectAddToast?: (toast: AddToastOptions) => string;
  }): Promise<void>;

  deleteAllChats(_args: Record<never, never>): Promise<void>;
};

export function createChatLifecycleService({
  currentChatRef,
  currentChatGroupRef,
  creatingChatRef,
  registerLiveInstance,
  updateChatContent,
  updateChatMeta,
  updateHierarchy,
  loadData,
  loadChat,
  deleteChatFromStorage,
  listChats,
  listChatGroups,
  deleteChatGroupFromStorage,
  setCurrentChatId,
  addToast,
  openChat,
  hasActiveGeneration,
  abortActiveGeneration,
  clearTasksForChat,
  clearActiveGenerations,
  clearActiveTaskCounts,
  clearLiveChatRegistry,
  clearChatTmpDirectories,
  deleteLiveChat,
  deleteChatTmpDirectory,
}: {
  currentChatRef: Ref<Chat | null>;
  currentChatGroupRef: Ref<ChatGroup | null>;
  creatingChatRef: Ref<boolean>;
  registerLiveInstance: ({ chat }: { chat: Chat }) => void;
  updateChatContent: ({
    id,
    updater,
  }: {
    id: string;
    updater: (current: import('@/models/types').ChatContent | null) => import('@/models/types').ChatContent;
  }) => Promise<void>;
  updateChatMeta: ({
    id,
    updater,
  }: {
    id: string;
    updater: (current: Chat | null) => Chat | Promise<Chat>;
  }) => Promise<void>;
  updateHierarchy: (updater: (current: Hierarchy) => Hierarchy | Promise<Hierarchy>) => Promise<void>;
  loadData: (_args: Record<never, never>) => Promise<void>;
  loadChat: ({ id }: { id: string }) => Promise<Chat | null>;
  deleteChatFromStorage: ({ id }: { id: string }) => Promise<void>;
  listChats: (_args: Record<never, never>) => Promise<Array<{ id: string }>>;
  listChatGroups: (_args: Record<never, never>) => Promise<ChatGroup[]>;
  deleteChatGroupFromStorage: ({ id }: { id: string }) => Promise<void>;
  setCurrentChatId: ({ chatId }: { chatId: string | null }) => void;
  addToast: (toast: AddToastOptions) => string;
  openChat: ({ id }: { id: string }) => Promise<Chat | null>;
  hasActiveGeneration: ({ chatId }: { chatId: string }) => boolean;
  abortActiveGeneration: ({ chatId }: { chatId: string }) => void;
  clearTasksForChat: ({ chatId }: { chatId: string }) => void;
  clearActiveGenerations: (_args: Record<never, never>) => void;
  clearActiveTaskCounts: (_args: Record<never, never>) => void;
  clearLiveChatRegistry: (_args: Record<never, never>) => void;
  clearChatTmpDirectories: (_args: Record<never, never>) => void;
  deleteLiveChat: ({ chatId }: { chatId: string }) => void;
  deleteChatTmpDirectory: ({ chatId }: { chatId: string }) => void;
}): ChatLifecycleService {
  async function createNewChat({
    groupId,
    modelId,
    systemPrompt,
  }: {
    groupId: string | undefined;
    modelId: string | undefined;
    systemPrompt: SystemPrompt | undefined;
  }) {
    if (creatingChatRef.value) return null;
    currentChatGroupRef.value = null;
    creatingChatRef.value = true;
    const chatId = generateId();

    try {
      const chatObj: Chat = reactive({
        id: chatId,
        title: null,
        groupId: groupId ?? null,
        root: { items: [] },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        debugEnabled: false,
        modelId: modelId ?? undefined,
        systemPrompt,
      });

      registerLiveInstance({ chat: chatObj });
      await updateChatContent({
        id: chatId,
        updater: () => ({ root: chatObj.root, currentLeafId: chatObj.currentLeafId }),
      });
      await updateChatMeta({
        id: chatId,
        updater: () => chatObj,
      });

      await updateHierarchy(curr => {
        if (groupId) {
          const group = curr.items.find(item => item.type === 'chat_group' && item.id === groupId) as HierarchyChatGroupNode | undefined;
          if (group) {
            group.chat_ids.unshift(chatId);
            return curr;
          }
        }

        const firstChatIndex = curr.items.findIndex(item => item.type === 'chat');
        const insertIndex = firstChatIndex !== -1 ? firstChatIndex : curr.items.length;
        curr.items.splice(insertIndex, 0, { type: 'chat', id: chatId });
        return curr;
      });

      setCurrentChatId({ chatId });
      currentChatRef.value = chatObj;
      await loadData({});
      return chatObj;
    } finally {
      creatingChatRef.value = false;
    }
  }

  async function deleteChat({
    id,
    injectAddToast = undefined,
  }: {
    id: string;
    injectAddToast?: (toast: AddToastOptions) => string;
  }) {
    const chatData = await loadChat({ id });
    if (!chatData) return;

    await updateHierarchy(curr => {
      curr.items = curr.items.filter(item => {
        switch (item.type) {
        case 'chat':
          if (item.id === id) return false;
          break;
        case 'chat_group':
          item.chat_ids = item.chat_ids.filter(chatId => chatId !== id);
          break;
        default: {
          const _ex: never = item;
          throw new Error(`Unhandled hierarchy node type: ${_ex}`);
        }
        }
        return true;
      });
      return curr;
    });

    if (currentChatRef.value && toRaw(currentChatRef.value).id === id) {
      currentChatRef.value = null;
    }
    await loadData({});

    const cleanup = async (_args: Record<never, never>) => {
      if (hasActiveGeneration({ chatId: id })) {
        abortActiveGeneration({ chatId: id });
      }
      clearTasksForChat({ chatId: id });
      deleteLiveChat({ chatId: id });
      deleteChatTmpDirectory({ chatId: id });
      await deleteChatFromStorage({ id });
    };

    const toastId = (injectAddToast || addToast)({
      message: `Chat "${chatData.title || 'Untitled'}" deleted`,
      actionLabel: 'Undo',
      onAction: async () => {
        const originalGroupId = chatData.groupId;
        await updateHierarchy(curr => {
          if (originalGroupId) {
            const group = curr.items.find(item => {
              switch (item.type) {
              case 'chat_group':
                return item.id === originalGroupId;
              case 'chat':
                return false;
              default: {
                const _ex: never = item;
                throw new Error(`Unhandled hierarchy node type: ${_ex}`);
              }
              }
            }) as HierarchyChatGroupNode | undefined;
            if (group) {
              group.chat_ids.push(chatData.id);
              return curr;
            }
          }
          curr.items.push({ type: 'chat', id: chatData.id });
          return curr;
        });
        await loadData({});
        await openChat({ id: chatData.id });
      },
      onClose: async reason => {
        switch (reason) {
        case 'action':
          return;
        case 'timeout':
        case 'dismiss':
          await cleanup({});
          break;
        default: {
          const _ex: never = reason;
          throw new Error(`Unhandled close reason: ${_ex}`);
        }
        }
      },
    });

    if (!toastId) {
      await cleanup({});
    }
  }

  async function deleteAllChats(_args: Record<never, never>) {
    clearActiveGenerations({});
    clearActiveTaskCounts({});
    clearLiveChatRegistry({});
    clearChatTmpDirectories({});

    const chats = await listChats({});
    for (const chat of chats) {
      await deleteChatFromStorage({ id: chat.id });
    }

    const groups = await listChatGroups({});
    for (const group of groups) {
      await deleteChatGroupFromStorage({ id: group.id });
    }

    await updateHierarchy(curr => {
      curr.items = [];
      return curr;
    });
    currentChatRef.value = null;
    await loadData({});
  }

  return {
    createNewChat,
    deleteChat,
    deleteAllChats,
  };
}
