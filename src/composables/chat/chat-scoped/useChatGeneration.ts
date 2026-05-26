import type { Ref } from 'vue';
import type { Attachment, LmParameters } from '@/models/types';
import { useChatConversationActions } from '@/composables/chat/ui/useChatConversationActions';

export type ChatGenerationAdapter = {
  sendMessage({
    content,
    parentId,
    attachments,
    lmParameters,
  }: {
    content: string;
    parentId: string | null | undefined;
    attachments: Attachment[] | undefined;
    lmParameters: LmParameters | undefined;
  }): Promise<boolean>;

  regenerateMessage({
    failedMessageId,
  }: {
    failedMessageId: string;
  }): Promise<void>;

  abort(_args: Record<never, never>): void;

  TEST_ONLY: Record<string, never>;
};

export function useChatGeneration({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatGenerationAdapter {
  const chatConversationActions = useChatConversationActions();

  async function sendMessage({
    content,
    parentId,
    attachments,
    lmParameters,
  }: {
    content: string;
    parentId: string | null | undefined;
    attachments: Attachment[] | undefined;
    lmParameters: LmParameters | undefined;
  }): Promise<boolean> {
    if (chatId.value === undefined) {
      return false;
    }

    return await chatConversationActions.sendMessage({
      chatId: chatId.value,
      content,
      parentId,
      attachments,
      lmParameters,
    });
  }

  async function regenerateMessage({
    failedMessageId,
  }: {
    failedMessageId: string;
  }): Promise<void> {
    if (chatId.value === undefined) {
      return;
    }

    await chatConversationActions.regenerateMessage({
      chatId: chatId.value,
      failedMessageId,
    });
  }

  function abort(_args: Record<never, never>) {
    chatConversationActions.abortChat({ chatId: chatId.value });
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
