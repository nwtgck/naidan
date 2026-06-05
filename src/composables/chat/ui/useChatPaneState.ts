import { computed, type ComputedRef, type Ref } from 'vue';
import type { Chat, ChatGroup, MessageNode, Settings } from '@/models/types';
import { useSettings } from '@/composables/useSettings';
import { getAllMessages, getChatBranchIterator } from '@/utils/chat-tree';
import { resolveChatSettings } from '@/utils/chat-settings-resolver';
import { getReadonlyChat, rootItems } from '@/composables/chat/global/chat-core-singletons';

export type ChatPaneStateAdapter = {
  chat: ComputedRef<Readonly<Chat> | null>;
  chatGroup: ComputedRef<Readonly<ChatGroup> | null>;
  activeMessages: ComputedRef<MessageNode[]>;
  allMessages: ComputedRef<MessageNode[]>;
  resolvedSettings: ComputedRef<ReturnType<typeof resolveChatSettings> | null>;
  inheritedSettings: ComputedRef<ReturnType<typeof resolveChatSettings> | null>;
  chatGroups: ComputedRef<ChatGroup[]>;
};

export function useChatPaneState({
  chatId,
}: {
  chatId: Readonly<Ref<string>>;
}): ChatPaneStateAdapter {
  const { settings } = useSettings();

  const chatGroups = computed(() => {
    const all: ChatGroup[] = [];
    rootItems.value.forEach(item => {
      switch (item.type) {
      case 'chat_group':
        all.push(item.chatGroup);
        break;
      case 'chat':
        break;
      default: {
        const _ex: never = item;
        return _ex;
      }
      }
    });
    return all;
  });

  const chat = computed(() => getReadonlyChat({
    chatId: chatId.value,
  }));

  const chatGroup = computed(() => {
    const groupId = chat.value?.groupId;
    if (groupId === undefined || groupId === null) {
      return null;
    }
    return chatGroups.value.find(item => item.id === groupId) ?? null;
  });

  const activeMessages = computed(() => {
    if (chat.value === null) {
      return [];
    }
    return Array.from(getChatBranchIterator({ chat: chat.value }));
  });

  const allMessages = computed(() => {
    if (chat.value === null) {
      return [];
    }
    return getAllMessages({ chat: chat.value });
  });

  const resolvedSettings = computed(() => {
    if (chat.value === null) {
      return null;
    }
    return resolveChatSettings({
      chat: chat.value,
      groups: chatGroups.value,
      globalSettings: settings.value as Settings,
    });
  });

  const inheritedSettings = computed(() => {
    if (chat.value === null) {
      return null;
    }

    const virtualChat: Chat = {
      ...chat.value,
      modelId: undefined,
      endpointType: undefined,
      endpointUrl: undefined,
      endpointHttpHeaders: undefined,
      systemPrompt: undefined,
      lmParameters: undefined,
    };

    return resolveChatSettings({
      chat: virtualChat,
      groups: chatGroups.value,
      globalSettings: settings.value as Settings,
    });
  });

  return {
    chat,
    chatGroup,
    activeMessages,
    allMessages,
    resolvedSettings,
    inheritedSettings,
    chatGroups,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
