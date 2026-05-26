import type { Ref } from 'vue';
import type { LmParameters, MessageNode } from '@/models/types';
import { useChat } from '@/composables/useChat';

export type ChatHistoryAdapter = {
  editMessage({
    messageId,
    newContent,
    lmParameters,
  }: {
    messageId: string;
    newContent: string;
    lmParameters: LmParameters | undefined;
  }): Promise<void>;

  switchVersion({
    messageId,
  }: {
    messageId: string;
  }): Promise<void>;

  forkChat({
    messageId,
  }: {
    messageId: string;
  }): Promise<string | null>;

  getSiblings({
    messageId,
  }: {
    messageId: string;
  }): MessageNode[];

  TEST_ONLY: Record<string, never>;
};

type ChatHistoryStoreCompatibility = ReturnType<typeof useChat> & {
  forkChatForChat?: ({
    chatId,
    messageId,
  }: {
    chatId: string;
    messageId: string;
  }) => Promise<string | null>;
  editMessageForChat?: ({
    chatId,
    messageId,
    newContent,
    lmParameters,
  }: {
    chatId: string;
    messageId: string;
    newContent: string;
    lmParameters: LmParameters | undefined;
  }) => Promise<void>;
  switchVersionForChat?: ({
    chatId,
    messageId,
  }: {
    chatId: string;
    messageId: string;
  }) => Promise<void>;
};

export function useChatHistory({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatHistoryAdapter {
  const chatStore = useChat() as ChatHistoryStoreCompatibility;

  async function editMessage({
    messageId,
    newContent,
    lmParameters,
  }: {
    messageId: string;
    newContent: string;
    lmParameters: LmParameters | undefined;
  }): Promise<void> {
    const id = chatId.value;
    if (id === undefined) {
      return;
    }

    if (typeof chatStore.editMessageForChat === 'function') {
      await chatStore.editMessageForChat({
        chatId: id,
        messageId,
        newContent,
        lmParameters,
      });
      return;
    }

    await chatStore.editMessage({
      messageId,
      newContent,
      lmParameters,
    });
  }

  async function switchVersion({
    messageId,
  }: {
    messageId: string;
  }): Promise<void> {
    const id = chatId.value;
    if (id === undefined) {
      return;
    }

    if (typeof chatStore.switchVersionForChat === 'function') {
      await chatStore.switchVersionForChat({
        chatId: id,
        messageId,
      });
      return;
    }

    await chatStore.switchVersion({ messageId });
  }

  async function forkChat({
    messageId,
  }: {
    messageId: string;
  }): Promise<string | null> {
    const id = chatId.value;
    if (id !== undefined && typeof chatStore.forkChatForChat === 'function') {
      return await chatStore.forkChatForChat({
        chatId: id,
        messageId,
      });
    }

    return await chatStore.forkChat({ messageId });
  }

  function getSiblings({
    messageId,
  }: {
    messageId: string;
  }): MessageNode[] {
    return chatStore.getSiblings({
      messageId,
      chatId: chatId.value,
    });
  }

  return {
    editMessage,
    switchVersion,
    forkChat,
    getSiblings,
    TEST_ONLY: {},
  };
}
