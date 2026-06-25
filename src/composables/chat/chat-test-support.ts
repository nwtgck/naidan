import type { Ref } from 'vue';
import type { Chat, ChatGroup } from '@/models/types';
import type { ContextCompactProgress } from '@/services/context-compact';
import type { ChatId } from '@/models/ids';

export type ChatTestSupport = {
  __testOnlySetCurrentChat({
    chat,
  }: {
    chat: Chat | null,
  }): void,

  __testOnlySetCurrentChatGroup({
    group,
  }: {
    group: ChatGroup | null,
  }): void,

  __testOnlySetContextCompactProgress({
    chatId,
    progress,
  }: {
    chatId: ChatId,
    progress: ContextCompactProgress,
  }): void,

  clearLiveChatRegistry(): void,
};

export function createChatTestSupport({
  currentChatRef,
  currentChatGroupRef,
  registerLiveInstance,
  setContextCompactProgress,
  clearLiveChatRegistryImpl,
}: {
  currentChatRef: Ref<Chat | null>,
  currentChatGroupRef: Ref<ChatGroup | null>,
  registerLiveInstance: ({ chat }: { chat: Chat }) => void,
  setContextCompactProgress: ({
    chatId,
    progress,
  }: {
    chatId: ChatId,
    progress: ContextCompactProgress,
  }) => void,
  clearLiveChatRegistryImpl: () => void,
}): ChatTestSupport {
  function __testOnlySetCurrentChat({
    chat,
  }: {
    chat: Chat | null,
  }) {
    currentChatRef.value = chat;
    if (chat) {
      registerLiveInstance({ chat });
    }
  }

  function __testOnlySetCurrentChatGroup({
    group,
  }: {
    group: ChatGroup | null,
  }) {
    currentChatGroupRef.value = group;
  }

  function __testOnlySetContextCompactProgress({
    chatId,
    progress,
  }: {
    chatId: ChatId,
    progress: ContextCompactProgress,
  }) {
    setContextCompactProgress({
      chatId,
      progress,
    });
  }

  function clearLiveChatRegistry() {
    clearLiveChatRegistryImpl();
  }

  return {
    __testOnlySetCurrentChat,
    __testOnlySetCurrentChatGroup,
    __testOnlySetContextCompactProgress,
    clearLiveChatRegistry,
  };
}
