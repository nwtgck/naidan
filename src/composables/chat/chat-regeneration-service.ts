import { generateId } from '@/utils/id';
import { findNodeInBranch, findParentInBranch } from '@/utils/chat-tree';
import type { AssistantMessageNode, Chat, ChatContent, LmParameters } from '@/models/types';
import { EMPTY_LM_PARAMETERS } from '@/models/types';

export type ChatRegenerationService = {
  regenerateMessageForChat({
    chatId,
    failedMessageId,
  }: {
    chatId: string;
    failedMessageId: string;
  }): Promise<void>;

  regenerateMessage({
    failedMessageId,
  }: {
    failedMessageId: string;
  }): Promise<void>;
};

export function createChatRegenerationService({
  getCurrentChat,
  getChatTarget,
  getLiveChat,
  registerLiveInstance,
  isProcessing,
  abortChat,
  startProcessing,
  finishProcessing,
  updateChatContent,
  updateChatMeta,
  triggerCurrentChat,
  generateResponse,
}: {
  getCurrentChat: () => Chat | null;
  getChatTarget: ({
    chatId,
  }: {
    chatId: string | undefined;
  }) => Chat | null;
  getLiveChat: ({ chat }: { chat: Chat | Readonly<Chat> }) => Chat;
  registerLiveInstance: ({ chat }: { chat: Chat }) => void;
  isProcessing: ({ chatId }: { chatId: string }) => boolean;
  abortChat: ({ chatId }: { chatId: string | undefined }) => void;
  startProcessing: ({ chatId }: { chatId: string }) => void;
  finishProcessing: ({ chatId }: { chatId: string }) => void;
  updateChatContent: ({
    id,
    updater,
  }: {
    id: string;
    updater: (current: ChatContent | null) => ChatContent;
  }) => Promise<void>;
  updateChatMeta: ({
    id,
    updater,
  }: {
    id: string;
    updater: (current: Chat | null) => Chat | Promise<Chat>;
  }) => Promise<void>;
  triggerCurrentChat: ({ chatId }: { chatId: string }) => void;
  generateResponse: ({
    chat,
    assistantId,
    lmParameters,
    onReady,
  }: {
    chat: Chat | Readonly<Chat>;
    assistantId: string;
    lmParameters?: LmParameters;
    onReady?: (_args: Record<never, never>) => void;
  }) => Promise<void>;
}): ChatRegenerationService {
  async function regenerateMessageForChat({
    chatId,
    failedMessageId,
  }: {
    chatId: string;
    failedMessageId: string;
  }) {
    const targetChat = getChatTarget({ chatId });
    if (!targetChat) {
      return;
    }

    await regenerateMessageForTarget({
      targetChat,
      failedMessageId,
    });
  }

  async function regenerateMessage({
    failedMessageId,
  }: {
    failedMessageId: string;
  }) {
    const currentChat = getCurrentChat();
    if (!currentChat) {
      return;
    }

    await regenerateMessageForTarget({
      targetChat: currentChat,
      failedMessageId,
    });
  }

  async function regenerateMessageForTarget({
    targetChat,
    failedMessageId,
  }: {
    targetChat: Chat;
    failedMessageId: string;
  }) {
    const chatId = targetChat.id;
    if (isProcessing({ chatId })) {
      abortChat({ chatId });
      while (isProcessing({ chatId })) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }

    const chat = getLiveChat({ chat: targetChat });
    startProcessing({ chatId: chat.id });
    registerLiveInstance({ chat });

    try {
      const failedNode = findNodeInBranch({ items: chat.root.items, targetId: failedMessageId });
      if (!failedNode || failedNode.role !== 'assistant') return;
      const parent = findParentInBranch({ items: chat.root.items, childId: failedMessageId });
      if (!parent || parent.role !== 'user') return;

      const newAssistantMessage: AssistantMessageNode = {
        id: generateId(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        modelId: failedNode.modelId,
        replies: { items: [] },
        attachments: undefined,
        thinking: undefined,
        error: undefined,
        lmParameters: failedNode.lmParameters || EMPTY_LM_PARAMETERS,
        toolCalls: undefined,
        results: undefined,
      };
      parent.replies.items.push(newAssistantMessage);
      chat.currentLeafId = newAssistantMessage.id;
      triggerCurrentChat({ chatId: chat.id });

      await updateChatContent({
        id: chat.id,
        updater: current => ({ ...current, root: chat.root, currentLeafId: chat.currentLeafId }),
      });
      await updateChatMeta({
        id: chat.id,
        updater: current => {
          if (!current) return chat;
          return { ...current, updatedAt: Date.now(), currentLeafId: chat.currentLeafId };
        },
      });

      let markGenerationReady: (() => void) | undefined;
      const generationReady = new Promise<void>(resolve => {
        markGenerationReady = resolve;
      });
      generateResponse({
        chat,
        assistantId: newAssistantMessage.id,
        lmParameters: failedNode.lmParameters,
        onReady: (_args) => {
          markGenerationReady?.();
          markGenerationReady = undefined;
        },
      }).catch(error => {
        markGenerationReady?.();
        markGenerationReady = undefined;
        console.error('Background generation failed:', error);
      });
      await generationReady;
    } finally {
      finishProcessing({ chatId: chat.id });
    }
  }

  return {
    regenerateMessageForChat,
    regenerateMessage,
  };
}
