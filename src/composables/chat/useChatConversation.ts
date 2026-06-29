import type { Attachment, LmParameters } from '@/01-models/types';
import type { ChatId, MessageId } from '@/01-models/ids';
import { abortProcessingForChat } from '@/composables/chat/chat-scoped/chat-processing-abort';
import {
  regenerateMessageForChat,
  sendMessageForChat,
} from '@/composables/chat/chat-scoped/chat-generation-flow';

export type ChatConversationAdapter = {
  sendMessage({
    chatId,
    content,
    parentId,
    attachments,
    lmParameters,
  }: {
    chatId: ChatId,
    content: string,
    parentId: MessageId | null | undefined,
    attachments: Attachment[] | undefined,
    lmParameters: LmParameters | undefined,
  }): Promise<boolean>,

  regenerateMessage({
    chatId,
    failedMessageId,
  }: {
    chatId: ChatId,
    failedMessageId: MessageId,
  }): Promise<void>,

  abort({
    chatId,
  }: {
    chatId: ChatId,
  }): void,

  TEST_ONLY: Record<never, never>,
};

export function useChatConversation(): ChatConversationAdapter {
  async function sendMessage({
    chatId,
    content,
    parentId,
    attachments,
    lmParameters,
  }: {
    chatId: ChatId,
    content: string,
    parentId: MessageId | null | undefined,
    attachments: Attachment[] | undefined,
    lmParameters: LmParameters | undefined,
  }): Promise<boolean> {
    return await sendMessageForChat({
      chatId,
      content,
      parentId,
      attachments,
      lmParameters,
    });
  }

  async function regenerateMessage({
    chatId,
    failedMessageId,
  }: {
    chatId: ChatId,
    failedMessageId: MessageId,
  }): Promise<void> {
    await regenerateMessageForChat({
      chatId,
      failedMessageId,
    });
  }

  function abort({
    chatId,
  }: {
    chatId: ChatId,
  }) {
    abortProcessingForChat({
      chatId,
    });
  }

  return {
    sendMessage,
    regenerateMessage,
    abort,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
