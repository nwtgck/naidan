import type { Ref } from 'vue';
import type { LmParameters, MessageNode } from '@/models/types';
import { useChatConversationActions } from '@/composables/chat/ui/useChatConversationActions';

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
  const chatConversationActions = useChatConversationActions();

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
      return;
    }

    await chatConversationActions.editMessage({
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
      return;
    }

    await chatConversationActions.switchVersion({
      chatId: chatId.value,
      messageId,
    });
  }

  async function forkChat({
    messageId,
  }: {
    messageId: string;
  }): Promise<string | null> {
    return await chatConversationActions.forkChat({
      chatId: chatId.value,
      messageId,
    });
  }

  function getSiblings({
    messageId,
  }: {
    messageId: string;
  }): MessageNode[] {
    return chatConversationActions.getSiblings({
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
