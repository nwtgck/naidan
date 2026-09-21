import { reactive } from 'vue';
import { findNodeInBranch } from '@/logic/chat-tree';
import type { ChatId, MessageId, ToolCallId } from '@/01-models/ids';
import type { Chat } from '@/01-models/types';

export type ChatVolatileState = {
  setVolatileAssistantError({
    chatId,
    messageId,
    error,
  }: {
    chatId: ChatId,
    messageId: MessageId,
    error: string,
  }): void,

  clearVolatileAssistantError({
    chatId,
    messageId,
  }: {
    chatId: ChatId,
    messageId: MessageId,
  }): void,

  getVolatileAssistantError({ chatId, messageId }: {
    chatId: ChatId,
    messageId: MessageId,
  }): string | undefined,

  pruneVolatileAssistantErrorsForChat({
    chat,
  }: {
    chat: Chat,
  }): void,

  setVolatileToolOutput({
    toolCallId,
    output,
  }: {
    toolCallId: ToolCallId,
    output: string,
  }): void,

  appendVolatileToolOutput({
    toolCallId,
    text,
  }: {
    toolCallId: ToolCallId,
    text: string,
  }): void,

  deleteVolatileToolOutput({
    toolCallId,
  }: {
    toolCallId: ToolCallId,
  }): void,

  getVolatileToolOutput({
    toolCallId,
  }: {
    toolCallId: ToolCallId,
  }): string | undefined,

  TEST_ONLY: {
    volatileToolOutputs: Map<ToolCallId, string>,
  },
};

export function createChatVolatileState(): ChatVolatileState {
  const volatileAssistantErrors = reactive(new Map<ChatId, Map<MessageId, string>>());
  const volatileToolOutputs = reactive(new Map<ToolCallId, string>());

  function setVolatileAssistantError({
    chatId,
    messageId,
    error,
  }: {
    chatId: ChatId,
    messageId: MessageId,
    error: string,
  }) {
    const existing = volatileAssistantErrors.get(chatId);
    if (existing) {
      existing.set(messageId, error);
      return;
    }
    volatileAssistantErrors.set(chatId, new Map([[messageId, error]]));
  }

  function clearVolatileAssistantError({
    chatId,
    messageId,
  }: {
    chatId: ChatId,
    messageId: MessageId,
  }) {
    const existing = volatileAssistantErrors.get(chatId);
    if (!existing) return;

    existing.delete(messageId);
    if (existing.size === 0) {
      volatileAssistantErrors.delete(chatId);
    }
  }

  function pruneVolatileAssistantErrorsForChat({
    chat,
  }: {
    chat: Chat,
  }) {
    const errors = volatileAssistantErrors.get(chat.id);
    if (!errors || errors.size === 0) return;

    for (const messageId of errors.keys()) {
      const node = findNodeInBranch({ items: chat.root.items, targetId: messageId });
      if (!node) {
        errors.delete(messageId); continue;
      }
      switch (node.role) {
      case 'assistant': break;
      case 'user':
      case 'system':
      case 'tool': errors.delete(messageId); break;
      default: { const _ex: never = node; throw new Error(`Unhandled message: ${_ex}`); }
      }
    }
    if (errors.size === 0) volatileAssistantErrors.delete(chat.id);
  }

  // UI diagnostics stay outside the persisted message. Reloading history must
  // not turn a storage/title error into a model-generation interruption.
  function getVolatileAssistantError({ chatId, messageId }: { chatId: ChatId, messageId: MessageId }): string | undefined {
    return volatileAssistantErrors.get(chatId)?.get(messageId);
  }

  function setVolatileToolOutput({
    toolCallId,
    output,
  }: {
    toolCallId: ToolCallId,
    output: string,
  }) {
    volatileToolOutputs.set(toolCallId, output);
  }

  function appendVolatileToolOutput({
    toolCallId,
    text,
  }: {
    toolCallId: ToolCallId,
    text: string,
  }) {
    const previous = volatileToolOutputs.get(toolCallId) || '';
    volatileToolOutputs.set(toolCallId, previous + text);
  }

  function deleteVolatileToolOutput({
    toolCallId,
  }: {
    toolCallId: ToolCallId,
  }) {
    volatileToolOutputs.delete(toolCallId);
  }

  function getVolatileToolOutput({
    toolCallId,
  }: {
    toolCallId: ToolCallId,
  }) {
    return volatileToolOutputs.get(toolCallId);
  }

  return {
    setVolatileAssistantError,
    clearVolatileAssistantError,
    getVolatileAssistantError,
    pruneVolatileAssistantErrorsForChat,
    setVolatileToolOutput,
    appendVolatileToolOutput,
    deleteVolatileToolOutput,
    getVolatileToolOutput,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        volatileToolOutputs,
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
