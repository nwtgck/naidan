import { computed, readonly, type ComputedRef, type Ref } from 'vue';
import type { Chat, ChatGroup, MessageNode, Settings, SidebarItem } from '@/models/types';
import { getAllMessages, getChatBranchIterator } from '@/utils/chat-tree';
import { resolveChatSettings } from '@/utils/chat-settings-resolver';
import { useSettings } from '@/composables/useSettings';
import { getReadonlyChat, rootItems } from '@/composables/chat/chat-core-singletons';

export type ChatReadModelAdapter = {
  currentChat: ComputedRef<Readonly<Chat> | null>;
  currentChatGroup: ComputedRef<Readonly<ChatGroup> | null>;
  activeMessages: ComputedRef<MessageNode[]>;
  allMessages: ComputedRef<MessageNode[]>;
  resolvedSettings: ComputedRef<ReturnType<typeof resolveChatSettings> | null>;
  inheritedSettings: ComputedRef<ReturnType<typeof resolveChatSettings> | null>;
};

export function useChatReadModel({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatReadModelAdapter {
  const { settings } = useSettings();

  const chatGroups = computed(() => collectChatGroups({
    items: rootItems.value,
  }));

  const currentChat = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return null;
    }

    const chat = getReadonlyChat({ chatId: id });
    if (!chat) {
      return null;
    }

    return readonly(chat) as Readonly<Chat>;
  });

  const currentChatGroup = computed(() => {
    const groupId = currentChat.value?.groupId;
    if (groupId === undefined || groupId === null) {
      return null;
    }

    const group = chatGroups.value.find(({ id }) => id === groupId) ?? null;
    if (!group) {
      return null;
    }

    return readonly(group) as Readonly<ChatGroup>;
  });

  const activeMessages = computed(() => {
    const chat = currentChat.value;
    if (!chat) {
      return [];
    }

    return Array.from(getChatBranchIterator({ chat }));
  });

  const allMessages = computed(() => {
    const chat = currentChat.value;
    if (!chat) {
      return [];
    }

    return getAllMessages({ chat });
  });

  const resolvedSettings = computed(() => {
    const chat = currentChat.value;
    if (!chat) {
      return null;
    }

    return resolveChatSettings({
      chat,
      groups: chatGroups.value,
      globalSettings: settings.value as Settings,
    });
  });

  const inheritedSettings = computed(() => {
    const chat = currentChat.value;
    if (!chat) {
      return null;
    }

    const virtualChat: Chat = {
      ...chat,
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
    currentChat,
    currentChatGroup,
    activeMessages,
    allMessages,
    resolvedSettings,
    inheritedSettings,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}

function collectChatGroups({
  items,
}: {
  items: SidebarItem[];
}): ChatGroup[] {
  const groups: ChatGroup[] = [];

  for (const item of items) {
    switch (item.type) {
    case 'chat':
      break;
    case 'chat_group':
      groups.push(item.chatGroup);
      break;
    default: {
      const _ex: never = item;
      return _ex;
    }
    }
  }

  return groups;
}
