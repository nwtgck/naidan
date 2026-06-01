import type { Attachment, LmParameters } from '@/models/types';
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
    chatId: string;
    content: string;
    parentId: string | null | undefined;
    attachments: Attachment[] | undefined;
    lmParameters: LmParameters | undefined;
  }): Promise<boolean>;

  regenerateMessage({
    chatId,
    failedMessageId,
  }: {
    chatId: string;
    failedMessageId: string;
  }): Promise<void>;

  abort({
    chatId,
  }: {
    chatId: string;
  }): void;

  TEST_ONLY: Record<never, never>;
};

export function useChatConversation(_args: Record<never, never>): ChatConversationAdapter {
  async function sendMessage({
    chatId,
    content,
    parentId,
    attachments,
    lmParameters,
  }: {
    chatId: string;
    content: string;
    parentId: string | null | undefined;
    attachments: Attachment[] | undefined;
    lmParameters: LmParameters | undefined;
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
    chatId: string;
    failedMessageId: string;
  }): Promise<void> {
    await regenerateMessageForChat({
      chatId,
      failedMessageId,
    });
  }

  function abort({
    chatId,
  }: {
    chatId: string;
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
