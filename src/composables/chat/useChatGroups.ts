import type { ChatGroup } from '@/models/types';
import { storageService } from '@/services/storage';
import {
  currentChatGroupRef,
  currentChatRef,
  loadData,
} from '@/composables/chat/global/chat-core-singletons';
import type { ChatGroupId, ChatId } from '@/models/ids';

export type ChatGroupsAdapter = {
  updateChatGroupMetadata({
    chatGroupId,
    updates,
  }: {
    chatGroupId: ChatGroupId;
    updates: Partial<Pick<ChatGroup, 'name' | 'endpoint' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>;
  }): Promise<void>;

  moveChatToGroup({
    chatId,
    chatGroupId,
  }: {
    chatId: ChatId;
    chatGroupId: ChatGroupId | undefined;
  }): Promise<void>;

  TEST_ONLY: Record<never, never>;
};

export function useChatGroups(): ChatGroupsAdapter {
  async function updateChatGroupMetadata({
    chatGroupId,
    updates,
  }: {
    chatGroupId: ChatGroupId;
    updates: Partial<Pick<ChatGroup, 'name' | 'endpoint' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>;
  }): Promise<void> {
    if (currentChatGroupRef.value?.id === chatGroupId) {
      Object.assign(currentChatGroupRef.value, updates);
      currentChatGroupRef.value.updatedAt = Date.now();
    }

    await storageService.updateChatGroup({ id: chatGroupId, updater: ({ current }) => {
      if (current === null) {
        throw new Error('Chat group not found');
      }

      return {
        ...current,
        ...updates,
        updatedAt: Date.now(),
      };
    } });
    await loadData();
  }

  async function moveChatToGroup({
    chatId,
    chatGroupId,
  }: {
    chatId: ChatId;
    chatGroupId: ChatGroupId | undefined;
  }): Promise<void> {
    const targetChatId = chatId;
    const targetGroupId = chatGroupId;

    if (currentChatRef.value?.id === targetChatId) {
      currentChatRef.value.groupId = targetGroupId;
      currentChatRef.value.updatedAt = Date.now();
    }

    await storageService.updateHierarchy({ updater: ({ current }) => {
      let detachedChatId: ChatId | undefined;

      current.items = current.items.filter((item) => {
        switch (item.type) {
        case 'chat':
          if (item.id === targetChatId) {
            detachedChatId = item.id;
            return false;
          }
          return true;
        case 'chat_group': {
          const chatIndex = item.chat_ids.indexOf(targetChatId);
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
        detachedChatId = targetChatId;
      }

      if (targetGroupId === undefined) {
        current.items.unshift({ type: 'chat', id: detachedChatId });
        return current;
      }

      const groupNode = current.items.find((item) => item.type === 'chat_group' && item.id === targetGroupId);
      if (groupNode === undefined || groupNode.type !== 'chat_group') {
        throw new Error('Chat group not found in hierarchy');
      }
      groupNode.chat_ids.unshift(detachedChatId);
      return current;
    } });
    await loadData();
  }

  return {
    updateChatGroupMetadata,
    moveChatToGroup,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
