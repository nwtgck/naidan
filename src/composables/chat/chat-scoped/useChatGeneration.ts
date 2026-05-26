import type { Ref } from 'vue';
import type { Attachment, LmParameters } from '@/models/types';
import { useChat } from '@/composables/useChat';

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

type ChatGenerationStoreCompatibility = {
  sendMessage: ({
    content,
    parentId,
    attachments,
    chatTarget,
    lmParameters,
  }: {
    content: string;
    parentId: string | null | undefined;
    attachments: Attachment[] | undefined;
    chatTarget: undefined;
    lmParameters: LmParameters | undefined;
  }) => Promise<boolean>;
  sendMessageForChat?: ({
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
  }) => Promise<boolean>;
  regenerateMessage: ({
    failedMessageId,
  }: {
    failedMessageId: string;
  }) => Promise<void>;
  regenerateMessageForChat?: ({
    chatId,
    failedMessageId,
  }: {
    chatId: string;
    failedMessageId: string;
  }) => Promise<void>;
  abortChat: ({
    chatId,
  }: {
    chatId: string | undefined;
  }) => void;
};

export function useChatGeneration({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatGenerationAdapter {
  const chatStore = useChat() as ChatGenerationStoreCompatibility;

  function hasScopedSendMessage(store: ChatGenerationStoreCompatibility): store is ChatGenerationStoreCompatibility & {
    sendMessageForChat: ({
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
    }) => Promise<boolean>;
  } {
    return 'sendMessageForChat' in store && typeof store.sendMessageForChat === 'function';
  }

  function hasScopedRegenerateMessage(store: ChatGenerationStoreCompatibility): store is ChatGenerationStoreCompatibility & {
    regenerateMessageForChat: ({
      chatId,
      failedMessageId,
    }: {
      chatId: string;
      failedMessageId: string;
    }) => Promise<void>;
  } {
    return 'regenerateMessageForChat' in store && typeof store.regenerateMessageForChat === 'function';
  }

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
    const id = chatId.value;
    if (id === undefined) {
      return false;
    }

    if (hasScopedSendMessage(chatStore)) {
      return await chatStore.sendMessageForChat({
        chatId: id,
        content,
        parentId,
        attachments,
        lmParameters,
      });
    }

    return await chatStore.sendMessage({
      content,
      parentId,
      attachments,
      chatTarget: undefined,
      lmParameters,
    });
  }

  async function regenerateMessage({
    failedMessageId,
  }: {
    failedMessageId: string;
  }): Promise<void> {
    const id = chatId.value;
    if (id === undefined) {
      return;
    }

    if (hasScopedRegenerateMessage(chatStore)) {
      await chatStore.regenerateMessageForChat({
        chatId: id,
        failedMessageId,
      });
      return;
    }

    await chatStore.regenerateMessage({
      failedMessageId,
    });
  }

  function abort(_args: Record<never, never>) {
    chatStore.abortChat({ chatId: chatId.value });
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
