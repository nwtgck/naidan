import { computed, readonly, toRaw, triggerRef, type ComputedRef, type Ref } from 'vue';
import type { Chat, ChatGroup } from '@/models/types';

export type ChatCurrentBridge = {
  currentChat: ComputedRef<Chat | null>;
  currentChatGroup: ComputedRef<ChatGroup | null>;

  getCurrentChat(): Chat | null;

  getCurrentChatId(): string | null;

  getChatTargetById({
    id,
  }: {
    id: string;
  }): Chat | null;

  getChatTargetByOptionalId({
    chatId,
  }: {
    chatId: string | undefined;
  }): Chat | null;

  triggerCurrentChat({
    chatId,
  }: {
    chatId: string;
  }): void;
};

export function createChatCurrentBridge({
  currentChatRef,
  currentChatGroupRef,
  liveChatRegistry,
  getLiveChat,
}: {
  currentChatRef: Ref<Chat | null>;
  currentChatGroupRef: Ref<ChatGroup | null>;
  liveChatRegistry: Map<string, Chat>;
  getLiveChat: ({ chat }: { chat: Chat }) => Chat;
}): ChatCurrentBridge {
  const currentChat = computed(() => currentChatRef.value ? readonly(currentChatRef.value) as Chat : null);
  const currentChatGroup = computed(() => currentChatGroupRef.value ? readonly(currentChatGroupRef.value) as ChatGroup : null);

  function getCurrentChat() {
    if (!currentChatRef.value) {
      return null;
    }
    return getLiveChat({ chat: currentChatRef.value });
  }

  function getCurrentChatId() {
    if (!currentChatRef.value) {
      return null;
    }
    return toRaw(currentChatRef.value).id;
  }

  function getChatTargetById({
    id,
  }: {
    id: string;
  }) {
    const liveChat = liveChatRegistry.get(id);
    if (liveChat) return liveChat;
    if (currentChatRef.value && toRaw(currentChatRef.value).id === id) {
      return currentChatRef.value;
    }
    return null;
  }

  function getChatTargetByOptionalId({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    if (chatId) {
      return liveChatRegistry.get(chatId) || null;
    }
    return currentChatRef.value;
  }

  function triggerCurrentChat({
    chatId,
  }: {
    chatId: string;
  }) {
    if (currentChatRef.value && toRaw(currentChatRef.value).id === chatId) {
      triggerRef(currentChatRef);
    }
  }

  return {
    currentChat,
    currentChatGroup,
    getCurrentChat,
    getCurrentChatId,
    getChatTargetById,
    getChatTargetByOptionalId,
    triggerCurrentChat,
  };
}
