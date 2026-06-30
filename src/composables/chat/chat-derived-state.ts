import { computed, toRaw, type ComputedRef, type Ref } from 'vue';
import type { Chat, ChatGroup, ChatSummary, MessageNode, Settings, SidebarItem } from '@/01-models/types';
import { getAllMessages, getChatBranchIterator } from '@/logic/chat-tree';
import { resolveChatSettings } from '@/logic/chat-settings-resolver';

export type ChatDerivedState = {
  sidebarItems: ComputedRef<SidebarItem[]>,
  chats: ComputedRef<ChatSummary[]>,
  chatGroups: ComputedRef<ChatGroup[]>,
  resolvedSettings: ComputedRef<ReturnType<typeof resolveChatSettings> | null>,
  inheritedSettings: ComputedRef<ReturnType<typeof resolveChatSettings> | null>,
  activeMessages: ComputedRef<MessageNode[]>,
  allMessages: ComputedRef<MessageNode[]>,
  hasMountsForChat({
    chat,
  }: {
    chat: Pick<Chat, 'mounts' | 'groupId'>,
  }): boolean,
};

export function createChatDerivedState({
  currentChatRef,
  rootItems,
  getSettings,
}: {
  currentChatRef: Ref<Chat | null>,
  rootItems: Ref<SidebarItem[]>,
  getSettings: () => Settings | Readonly<Settings>,
}): ChatDerivedState {
  const sidebarItems = computed(() => rootItems.value);

  const chats = computed(() => {
    const all: ChatSummary[] = [];
    const collect = ({
      items,
    }: {
      items: SidebarItem[],
    }) => {
      items.forEach(item => {
        switch (item.type) {
        case 'chat':
          all.push(item.chat);
          break;
        case 'chat_group':
          collect({ items: item.chatGroup.items });
          break;
        default: {
          const _ex: never = item;
          return _ex;
        }
        }
      });
    };
    collect({ items: rootItems.value });
    return all;
  });

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

  const resolvedSettings = computed(() => {
    if (!currentChatRef.value) return null;
    return resolveChatSettings({
      chat: toRaw(currentChatRef.value),
      groups: chatGroups.value,
      globalSettings: getSettings(),
    });
  });

  const inheritedSettings = computed(() => {
    if (!currentChatRef.value) return null;
    const chat = toRaw(currentChatRef.value);
    const virtualChat: Chat = {
      ...chat,
      modelId: undefined,
      endpoint: undefined,
      systemPrompt: undefined,
      lmParameters: undefined,
    };
    return resolveChatSettings({
      chat: virtualChat,
      groups: chatGroups.value,
      globalSettings: getSettings(),
    });
  });

  const activeMessages = computed(() => {
    if (!currentChatRef.value) return [];
    return Array.from(getChatBranchIterator({ chat: currentChatRef.value }));
  });

  const allMessages = computed(() => {
    if (!currentChatRef.value) return [];
    return getAllMessages({ chat: currentChatRef.value });
  });

  function hasMountsForChat({
    chat,
  }: {
    chat: Pick<Chat, 'mounts' | 'groupId'>,
  }) {
    const settings = getSettings();
    if (settings.mounts && settings.mounts.length > 0) return true;
    if (chat.mounts && chat.mounts.length > 0) return true;
    if (chat.groupId) {
      const group = chatGroups.value.find(item => item.id === chat.groupId);
      if (group?.mounts && group.mounts.length > 0) return true;
    }
    return false;
  }

  return {
    sidebarItems,
    chats,
    chatGroups,
    resolvedSettings,
    inheritedSettings,
    activeMessages,
    allMessages,
    hasMountsForChat,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
