import type { Attachment, LmParameters, MessageNode } from '@/models/types';
import { storageService } from '@/services/storage';
import {
  chatRuntimeStore,
  contextCompactRuntime,
} from '@/composables/chat/global/chat-core-singletons';
import {
  abortTitleGenerationForChat,
} from '@/composables/chat/chat-scoped/chat-title-helpers';
import {
  editCurrentChatMessage,
  editMessageForChat,
  forkChatForChat,
  forkCurrentChat,
  getSiblingsForChat,
  switchVersionForChat,
  switchVersionInCurrentChat,
} from '@/composables/chat/chat-scoped/chat-history-flow';
import {
  regenerateMessageForChat,
  regenerateMessageForCurrentChat,
  sendMessageForChat,
  sendMessageToCurrentChat,
} from '@/composables/chat/chat-scoped/chat-generation-flow';
import { useChatUiServices } from './useChatUiServices';

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

export function useChatConversationActions(): ChatConversationActionsAdapter {
  const { currentBridge } = useChatUiServices({});

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
    if (chatId !== undefined) {
      return await sendMessageForChat({
        chatId,
        content,
        parentId,
        attachments,
        lmParameters,
      });
    }

    return await sendMessageToCurrentChat({
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
    chatId: string | undefined;
    failedMessageId: string;
  }): Promise<void> {
    if (chatId !== undefined) {
      await regenerateMessageForChat({
        chatId,
        failedMessageId,
      });
      return;
    }

    await regenerateMessageForCurrentChat({
      failedMessageId,
    });
  }

  function abortChat({
    chatId,
  }: {
    chatId: string | undefined;
  }): void {
    const resolvedChatId = chatId ?? currentBridge.getCurrentChatId({}) ?? undefined;
    if (resolvedChatId === undefined) {
      return;
    }

    contextCompactRuntime.getActiveContextCompaction({ chatId: resolvedChatId })?.abort();
    if (chatRuntimeStore.activeGenerations.has(resolvedChatId)) {
      chatRuntimeStore.getActiveGeneration({ chatId: resolvedChatId })?.controller.abort();
      storageService.notify({
        type: 'chat_content_generation',
        id: resolvedChatId,
        status: 'abort_request',
        timestamp: Date.now(),
      });
    } else if (chatRuntimeStore.hasExternalGeneration({ chatId: resolvedChatId })) {
      storageService.notify({
        type: 'chat_content_generation',
        id: resolvedChatId,
        status: 'abort_request',
        timestamp: Date.now(),
      });
    }
    abortTitleGenerationForChat({ chatId: resolvedChatId });
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
    if (chatId !== undefined) {
      await editMessageForChat({
        chatId,
        messageId,
        newContent,
        lmParameters,
      });
      return;
    }

    await editCurrentChatMessage({
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
    if (chatId !== undefined) {
      await switchVersionForChat({
        chatId,
        messageId,
      });
      return;
    }

    await switchVersionInCurrentChat({
      messageId,
    });
  }

  async function forkChat({
    chatId,
    messageId,
  }: {
    chatId: string | undefined;
    messageId: string;
  }): Promise<string | null> {
    if (chatId !== undefined) {
      return await forkChatForChat({
        chatId,
        messageId,
      });
    }

    return await forkCurrentChat({
      messageId,
    });
  }

  function getSiblings({
    chatId,
    messageId,
  }: {
    chatId: string | undefined;
    messageId: string;
  }): MessageNode[] {
    return getSiblingsForChat({
      chatId,
      messageId,
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
