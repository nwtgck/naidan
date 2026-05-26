import type { Ref } from 'vue';
import type { Chat, ChatGroup } from '@/models/types';
import type { ContextCompactProgress } from '@/services/context-compact';

export type ChatTestSupport = {
  __testOnlySetCurrentChat({
    chat,
  }: {
    chat: Chat | null;
  }): void;

  __testOnlySetCurrentChatGroup({
    group,
  }: {
    group: ChatGroup | null;
  }): void;

  __testOnlySetContextCompactProgress({
    chatId,
    progress,
  }: {
    chatId: string;
    progress: ContextCompactProgress;
  }): void;

  clearLiveChatRegistry(_args: Record<string, never>): void;
};

export function createChatTestSupport({
  currentChatRef,
  currentChatGroupRef,
  registerLiveInstance,
  setContextCompactProgress,
  clearLiveChatRegistryImpl,
}: {
  currentChatRef: Ref<Chat | null>;
  currentChatGroupRef: Ref<ChatGroup | null>;
  registerLiveInstance: ({ chat }: { chat: Chat }) => void;
  setContextCompactProgress: ({
    chatId,
    progress,
  }: {
    chatId: string;
    progress: ContextCompactProgress;
  }) => void;
  clearLiveChatRegistryImpl: (_args: Record<string, never>) => void;
}): ChatTestSupport {
  function __testOnlySetCurrentChat({
    chat,
  }: {
    chat: Chat | null;
  }) {
    currentChatRef.value = chat;
    if (chat) {
      registerLiveInstance({ chat });
    }
  }

  function __testOnlySetCurrentChatGroup({
    group,
  }: {
    group: ChatGroup | null;
  }) {
    currentChatGroupRef.value = group;
  }

  function __testOnlySetContextCompactProgress({
    chatId,
    progress,
  }: {
    chatId: string;
    progress: ContextCompactProgress;
  }) {
    setContextCompactProgress({
      chatId,
      progress,
    });
  }

  function clearLiveChatRegistry(_args: Record<string, never>) {
    clearLiveChatRegistryImpl({});
  }

  return {
    __testOnlySetCurrentChat,
    __testOnlySetCurrentChatGroup,
    __testOnlySetContextCompactProgress,
    clearLiveChatRegistry,
  };
}
