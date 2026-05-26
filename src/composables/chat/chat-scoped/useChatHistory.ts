import type { Ref } from 'vue';
import type { LmParameters, MessageNode } from '@/models/types';
import {
  editCurrentChatMessage,
  editMessageForChat,
  forkChatForChat,
  forkCurrentChat,
  getSiblingsForChat,
  switchVersionForChat,
  switchVersionInCurrentChat,
} from '@/composables/chat/chat-scoped/chat-history-flow';

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

export function useChatHistory({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatHistoryAdapter {
  async function editMessage({
    messageId,
    newContent,
    lmParameters,
  }: {
    messageId: string;
    newContent: string;
    lmParameters: LmParameters | undefined;
  }): Promise<void> {
    if (chatId.value === undefined) {
      await editCurrentChatMessage({
        messageId,
        newContent,
        lmParameters,
      });
      return;
    }

    await editMessageForChat({
      chatId: chatId.value,
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
    if (chatId.value === undefined) {
      await switchVersionInCurrentChat({
        messageId,
      });
      return;
    }

    await switchVersionForChat({
      chatId: chatId.value,
      messageId,
    });
  }

  async function forkChat({
    messageId,
  }: {
    messageId: string;
  }): Promise<string | null> {
    if (chatId.value === undefined) {
      return await forkCurrentChat({
        messageId,
      });
    }

    return await forkChatForChat({
      chatId: chatId.value,
      messageId,
    });
  }

  function getSiblings({
    messageId,
  }: {
    messageId: string;
  }): MessageNode[] {
    return getSiblingsForChat({
      chatId: chatId.value,
      messageId,
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
