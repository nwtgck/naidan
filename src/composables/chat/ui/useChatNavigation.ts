import { useChat } from '@/composables/useChat';

export type ChatNavigationAdapter = {
  openChat({
    chatId,
  }: {
    chatId: string;
  }): ReturnType<ReturnType<typeof useChat>['openChat']>;

  openChatAtMessage({
    chatId,
    messageId,
  }: {
    chatId: string;
    messageId: string;
  }): ReturnType<ReturnType<typeof useChat>['openChatAtMessage']>;

  openChatGroup({
    groupId,
  }: {
    groupId: string | null;
  }): void;

  TEST_ONLY: Record<string, never>;
};

export function useChatNavigation(): ChatNavigationAdapter {
  const chatStore = useChat();

  function openChat({
    chatId,
  }: {
    chatId: string;
  }) {
    return chatStore.openChat({
      id: chatId,
    });
  }

  function openChatAtMessage({
    chatId,
    messageId,
  }: {
    chatId: string;
    messageId: string;
  }) {
    return chatStore.openChatAtMessage({
      chatId,
      messageId,
    });
  }

  function openChatGroup({
    groupId,
  }: {
    groupId: string | null;
  }) {
    chatStore.openChatGroup({
      id: groupId,
    });
  }

  return {
    openChat,
    openChatAtMessage,
    openChatGroup,
    TEST_ONLY: {},
  };
}
