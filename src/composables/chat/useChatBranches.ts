import type { LmParameters } from '@/models/types';
import type { ChatId, MessageId } from '@/models/ids';
import {
  editMessageForChat,
  forkChatForChat,
  switchVersionForChat,
} from '@/composables/chat/chat-scoped/chat-history-flow';

export type ChatBranchesAdapter = {
  editMessage({
    chatId,
    messageId,
    newContent,
    lmParameters,
  }: {
    chatId: ChatId,
    messageId: MessageId,
    newContent: string,
    lmParameters: LmParameters | undefined,
  }): Promise<void>,

  switchVersion({
    chatId,
    messageId,
  }: {
    chatId: ChatId,
    messageId: MessageId,
  }): Promise<void>,

  forkChat({
    chatId,
    messageId,
  }: {
    chatId: ChatId,
    messageId: MessageId,
  }): Promise<ChatId | null>,

  TEST_ONLY: Record<never, never>,
};

export function useChatBranches(): ChatBranchesAdapter {
  async function editMessage({
    chatId,
    messageId,
    newContent,
    lmParameters,
  }: {
    chatId: ChatId,
    messageId: MessageId,
    newContent: string,
    lmParameters: LmParameters | undefined,
  }): Promise<void> {
    await editMessageForChat({
      chatId,
      messageId,
      newContent,
      lmParameters,
    });
  }

  async function switchVersion({
    chatId,
    messageId,
  }: {
    chatId: ChatId,
    messageId: MessageId,
  }): Promise<void> {
    await switchVersionForChat({
      chatId,
      messageId,
    });
  }

  async function forkChat({
    chatId,
    messageId,
  }: {
    chatId: ChatId,
    messageId: MessageId,
  }): Promise<ChatId | null> {
    return await forkChatForChat({
      chatId,
      messageId,
    });
  }

  return {
    editMessage,
    switchVersion,
    forkChat,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
