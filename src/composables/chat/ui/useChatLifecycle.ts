import { reactive, toRaw } from 'vue';
import { generateId } from '@/utils/id';
import type { ChatGroupId, ChatId } from '@/models/ids';
import type { Chat, Hierarchy, HierarchyChatGroupNode, SystemPrompt } from '@/models/types';
import { storageService } from '@/services/storage';
import { useChatTools } from '@/composables/useChatTools';
import { useToast } from '@/composables/useToast';
import { ensureStrings } from '@/strings';
import {
  chatRuntimeStore,
  clearChatTmpDirectories,
  creatingChat,
  currentChatGroupRef,
  currentChatRef,
  deleteChatTmpDirectory,
  liveChatRegistry,
  loadData,
  registerLiveInstance,
  updateChatContent,
  updateChatMeta,
} from '@/composables/chat/global/chat-core-singletons';
import { useChatNavigation } from './useChatNavigation';

export interface AddToastOptions {
  message: string,
  actionLabel?: string,
  onAction?: () => void | Promise<void>,
  onClose?: ({ reason }: { reason: 'timeout' | 'dismiss' | 'action' }) => void | Promise<void>,
  duration?: number,
}

export type ChatLifecycleAdapter = {
  createNewChat({
    groupId,
    modelId,
    systemPrompt,
  }: {
    groupId: ChatGroupId | undefined,
    modelId: string | undefined,
    systemPrompt: SystemPrompt | undefined,
  }): Promise<Chat | null>,

  deleteChat({
    id,
    injectAddToast,
  }: {
    id: ChatId,
    injectAddToast: (({ message, actionLabel, onAction, onClose, duration }: AddToastOptions) => string) | undefined,
  }): Promise<void>,

  deleteAllChats(): Promise<void>,

  TEST_ONLY: Record<never, never>,
};

export function useChatLifecycle(): ChatLifecycleAdapter {
  const { addToast } = useToast();
  const { setCurrentChatId } = useChatTools();
  const chatNavigation = useChatNavigation();

  async function createNewChat({
    groupId,
    modelId,
    systemPrompt,
  }: {
    groupId: ChatGroupId | undefined,
    modelId: string | undefined,
    systemPrompt: SystemPrompt | undefined,
  }): Promise<Chat | null> {
    if (creatingChat.value) {
      return null;
    }

    currentChatGroupRef.value = null;
    creatingChat.value = true;
    const chatId = generateId<ChatId>();

    try {
      const chat: Chat = reactive({
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

      registerLiveInstance({ chat });
      await updateChatContent({
        id: chatId,
        updater: () => ({ root: chat.root, currentLeafId: chat.currentLeafId }),
      });
      await updateChatMeta({
        id: chatId,
        updater: () => chat,
      });
      await storageService.updateHierarchy({ updater: ({ current }) => {
        if (groupId !== undefined) {
          const group = current.items.find((item) => item.type === 'chat_group' && item.id === groupId) as HierarchyChatGroupNode | undefined;
          if (group !== undefined) {
            group.chat_ids.unshift(chatId);
            return current;
          }
        }

        const firstChatIndex = current.items.findIndex((item) => item.type === 'chat');
        const insertIndex = firstChatIndex !== -1 ? firstChatIndex : current.items.length;
        current.items.splice(insertIndex, 0, { type: 'chat', id: chatId });
        return current;
      } });

      setCurrentChatId({ chatId });
      currentChatRef.value = chat;
      await loadData();
      return chat;
    } finally {
      creatingChat.value = false;
    }
  }

  async function deleteChat({
    id,
    injectAddToast,
  }: {
    id: ChatId,
    injectAddToast: (({ message, actionLabel, onAction, onClose, duration }: AddToastOptions) => string) | undefined,
  }): Promise<void> {
    const chat = await storageService.loadChat({ id });
    if (chat === null) {
      return;
    }

    await storageService.updateHierarchy({ updater: ({ current }) => {
      current.items = current.items.filter((item) => {
        switch (item.type) {
        case 'chat':
          return item.id !== id;
        case 'chat_group':
          item.chat_ids = item.chat_ids.filter((chatId) => chatId !== id);
          return true;
        default: {
          const _ex: never = item;
          throw new Error(`Unhandled hierarchy node type: ${_ex}`);
        }
        }
      });
      return current;
    } });

    if (currentChatRef.value !== null && toRaw(currentChatRef.value).id === id) {
      currentChatRef.value = null;
    }
    await loadData();

    const cleanup = async () => {
      if (chatRuntimeStore.activeGenerations.has(id)) {
        chatRuntimeStore.getActiveGeneration({ chatId: id })?.controller.abort();
        chatRuntimeStore.deleteActiveGeneration({ chatId: id });
      }
      chatRuntimeStore.clearTasksForChat({ chatId: id });
      liveChatRegistry.delete(id);
      deleteChatTmpDirectory({ chatId: id });
      await storageService.deleteChat({ id });
    };

    const [message, actionLabel] = await Promise.all([
      ensureStrings.useChatLifecycle__chat_was_deleted({
        chatTitle: chat.title ?? undefined,
      }),
      ensureStrings.useChatLifecycle__undo(),
    ]);
    const toastId = (injectAddToast ?? addToast)({
      message,
      actionLabel,
      onAction: async () => {
        const originalGroupId = chat.groupId;
        await storageService.updateHierarchy({ updater: ({ current }) => {
          if (originalGroupId !== null) {
            const group = current.items.find((item) => {
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
            if (group !== undefined) {
              group.chat_ids.push(chat.id);
              return current;
            }
          }

          current.items.push({ type: 'chat', id: chat.id });
          return current;
        } });
        await loadData();
        await chatNavigation.openChat({
          chatId: chat.id,
          leafId: undefined,
        });
      },
      onClose: async ({ reason }) => {
        switch (reason) {
        case 'action':
          return;
        case 'timeout':
        case 'dismiss':
          await cleanup();
          return;
        default: {
          const _ex: never = reason;
          throw new Error(`Unhandled close reason: ${_ex}`);
        }
        }
      },
    });

    if (!toastId) {
      await cleanup();
    }
  }

  async function deleteAllChats(): Promise<void> {
    for (const [, item] of chatRuntimeStore.activeGenerations.entries()) {
      item.controller.abort();
    }
    chatRuntimeStore.clearActiveGenerations();
    chatRuntimeStore.clearActiveTaskCounts();
    liveChatRegistry.clear();
    clearChatTmpDirectories();

    const chats = await storageService.listChats();
    const chatGroups = await storageService.listChatGroups();

    await Promise.all(chats.map(async ({ id }) => {
      await storageService.deleteChat({ id });
    }));
    await Promise.all(chatGroups.map(async ({ id }) => {
      await storageService.deleteChatGroup({ id });
    }));
    await storageService.updateHierarchy({ updater: ({ current: _current }) => ({ items: [] } as Hierarchy) });

    currentChatRef.value = null;
    currentChatGroupRef.value = null;
    setCurrentChatId({ chatId: null });
    await loadData();
  }

  return {
    createNewChat,
    deleteChat,
    deleteAllChats,
    TEST_ONLY: {},
  };
}
