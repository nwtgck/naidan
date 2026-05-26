import type { Attachment, LmParameters, MessageNode } from '@/models/types';
import { useChat } from '@/composables/useChat';

export type ChatConversationActionsAdapter = {
  sendMessage({
    chatId,
    content,
    parentId,
    attachments,
    lmParameters,
  }: {
    chatId: string | undefined;
    content: string;
    parentId: string | null | undefined;
    attachments: Attachment[] | undefined;
    lmParameters: LmParameters | undefined;
  }): Promise<boolean>;

  regenerateMessage({
    chatId,
    failedMessageId,
  }: {
    chatId: string | undefined;
    failedMessageId: string;
  }): Promise<void>;

  abortChat({
    chatId,
  }: {
    chatId: string | undefined;
  }): void;

  editMessage({
    chatId,
    messageId,
    newContent,
    lmParameters,
  }: {
    chatId: string | undefined;
    messageId: string;
    newContent: string;
    lmParameters: LmParameters | undefined;
  }): Promise<void>;

  switchVersion({
    chatId,
    messageId,
  }: {
    chatId: string | undefined;
    messageId: string;
  }): Promise<void>;

  forkChat({
    chatId,
    messageId,
  }: {
    chatId: string | undefined;
    messageId: string;
  }): Promise<string | null>;

  getSiblings({
    chatId,
    messageId,
  }: {
    chatId: string | undefined;
    messageId: string;
  }): MessageNode[];

  TEST_ONLY: Record<string, never>;
};

type ChatConversationStoreCompatibility = ReturnType<typeof useChat> & {
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
  regenerateMessageForChat?: ({
    chatId,
    failedMessageId,
  }: {
    chatId: string;
    failedMessageId: string;
  }) => Promise<void>;
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

export function useChatConversationActions(): ChatConversationActionsAdapter {
  const chatStore = useChat() as ChatConversationStoreCompatibility;

  async function sendMessage({
    chatId,
    content,
    parentId,
    attachments,
    lmParameters,
  }: {
    chatId: string | undefined;
    content: string;
    parentId: string | null | undefined;
    attachments: Attachment[] | undefined;
    lmParameters: LmParameters | undefined;
  }): Promise<boolean> {
    if (chatId !== undefined && typeof chatStore.sendMessageForChat === 'function') {
      return await chatStore.sendMessageForChat({
        chatId,
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
    chatId,
    failedMessageId,
  }: {
    chatId: string | undefined;
    failedMessageId: string;
  }): Promise<void> {
    if (chatId !== undefined && typeof chatStore.regenerateMessageForChat === 'function') {
      await chatStore.regenerateMessageForChat({
        chatId,
        failedMessageId,
      });
      return;
    }

    await chatStore.regenerateMessage({
      failedMessageId,
    });
  }

  function abortChat({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    chatStore.abortChat({ chatId });
  }

  async function editMessage({
    chatId,
    messageId,
    newContent,
    lmParameters,
  }: {
    chatId: string | undefined;
    messageId: string;
    newContent: string;
    lmParameters: LmParameters | undefined;
  }): Promise<void> {
    if (chatId !== undefined && typeof chatStore.editMessageForChat === 'function') {
      await chatStore.editMessageForChat({
        chatId,
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
    chatId,
    messageId,
  }: {
    chatId: string | undefined;
    messageId: string;
  }): Promise<void> {
    if (chatId !== undefined && typeof chatStore.switchVersionForChat === 'function') {
      await chatStore.switchVersionForChat({
        chatId,
        messageId,
      });
      return;
    }

    await chatStore.switchVersion({ messageId });
  }

  async function forkChat({
    chatId,
    messageId,
  }: {
    chatId: string | undefined;
    messageId: string;
  }): Promise<string | null> {
    if (chatId !== undefined && typeof chatStore.forkChatForChat === 'function') {
      return await chatStore.forkChatForChat({
        chatId,
        messageId,
      });
    }

    return await chatStore.forkChat({ messageId });
  }

  function getSiblings({
    chatId,
    messageId,
  }: {
    chatId: string | undefined;
    messageId: string;
  }): MessageNode[] {
    return chatStore.getSiblings({
      messageId,
      chatId,
    });
  }

  return {
    sendMessage,
    regenerateMessage,
    abortChat,
    editMessage,
    switchVersion,
    forkChat,
    getSiblings,
    TEST_ONLY: {},
  };
}
