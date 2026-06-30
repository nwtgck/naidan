import { computed, readonly, toRaw, triggerRef, type ComputedRef, type Ref } from 'vue';
import type { Chat, ChatGroup } from '@/01-models/types';
import type { ChatId } from '@/01-models/ids';

export type ChatCurrentBridge = {
  currentChat: ComputedRef<Chat | null>,
  currentChatGroup: ComputedRef<ChatGroup | null>,

  getCurrentChat(): Chat | null,

  getCurrentChatId(): ChatId | null,

  getChatTargetById({
    id,
  }: {
    id: ChatId,
  }): Chat | null,

  getChatTargetByOptionalId({
    chatId,
  }: {
    chatId: ChatId | undefined,
  }): Chat | null,

  triggerCurrentChat({
    chatId,
  }: {
    chatId: ChatId,
  }): void,
};

export function createChatCurrentBridge({
  currentChatRef,
  currentChatGroupRef,
  liveChatRegistry,
  getLiveChat,
}: {
  currentChatRef: Ref<Chat | null>,
  currentChatGroupRef: Ref<ChatGroup | null>,
  liveChatRegistry: Map<ChatId, Chat>,
  getLiveChat: ({ chat }: { chat: Chat }) => Chat,
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
    id: ChatId,
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
    chatId: ChatId | undefined,
  }) {
    if (chatId) {
      return liveChatRegistry.get(chatId) || null;
    }
    return currentChatRef.value;
  }

  function triggerCurrentChat({
    chatId,
  }: {
    chatId: ChatId,
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

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
