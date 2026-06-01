import type { ChatGroup } from '@/models/types';
import { storageService } from '@/services/storage';
import {
  currentChatGroupRef,
  currentChatRef,
  loadData,
  updateChatMeta,
} from '@/composables/chat/global/chat-core-singletons';

export type ChatGroupsAdapter = {
  updateChatGroupMetadata({
    chatGroupId,
    updates,
  }: {
    chatGroupId: string;
    updates: Partial<Pick<ChatGroup, 'name' | 'endpoint' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>;
  }): Promise<void>;

  moveChatToGroup({
    chatId,
    chatGroupId,
  }: {
    chatId: string;
    chatGroupId: string | undefined;
  }): Promise<void>;

  TEST_ONLY: Record<string, never>;
};

export function useChatGroups(_args: Record<never, never>): ChatGroupsAdapter {
  async function updateChatGroupMetadata({
    chatGroupId,
    updates,
  }: {
    chatGroupId: string;
    updates: Partial<Pick<ChatGroup, 'name' | 'endpoint' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>;
  }): Promise<void> {
    if (currentChatGroupRef.value?.id === chatGroupId) {
      Object.assign(currentChatGroupRef.value, updates);
      currentChatGroupRef.value.updatedAt = Date.now();
    }

    await storageService.updateChatGroup(chatGroupId, (current) => {
      if (current === null) {
        throw new Error('Chat group not found');
      }

      return {
        ...current,
        ...updates,
        updatedAt: Date.now(),
      };
    });
    await loadData({});
  }

  async function moveChatToGroup({
    chatId,
    chatGroupId,
  }: {
    chatId: string;
    chatGroupId: string | undefined;
  }): Promise<void> {
    if (currentChatRef.value?.id === chatId) {
      currentChatRef.value.groupId = chatGroupId;
      currentChatRef.value.updatedAt = Date.now();
    }

    await updateChatMeta({
      id: chatId,
      updater: (current) => {
        if (current === null) {
          throw new Error('Chat not found');
        }
        return {
          ...current,
          groupId: chatGroupId,
          updatedAt: Date.now(),
        };
      },
    });

    await storageService.updateHierarchy((current) => {
      let detachedChatId: string | undefined;

      current.items = current.items.filter((item) => {
        switch (item.type) {
        case 'chat':
          if (item.id === chatId) {
            detachedChatId = item.id;
            return false;
          }
          return true;
        case 'chat_group': {
          const chatIndex = item.chat_ids.indexOf(chatId);
          if (chatIndex !== -1) {
            detachedChatId = item.chat_ids[chatIndex];
            item.chat_ids.splice(chatIndex, 1);
          }
          return true;
        }
        default: {
          const _ex: never = item;
          throw new Error(`Unhandled hierarchy node type: ${_ex}`);
        }
        }
      });

      if (detachedChatId === undefined) {
        detachedChatId = chatId;
      }

      if (chatGroupId === undefined) {
        current.items.unshift({ type: 'chat', id: detachedChatId });
        return current;
      }

      const groupNode = current.items.find((item) => item.type === 'chat_group' && item.id === chatGroupId);
      if (groupNode === undefined || groupNode.type !== 'chat_group') {
        throw new Error('Chat group not found in hierarchy');
      }
      groupNode.chat_ids.unshift(detachedChatId);
      return current;
    });
    await loadData({});
  }

  return {
    updateChatGroupMetadata,
    moveChatToGroup,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
