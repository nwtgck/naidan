import { reactive } from 'vue';
import { findNodeInBranch } from '@/utils/chat-tree';
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

  applyVolatileAssistantErrorsToChat({
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

  function applyVolatileAssistantErrorsToChat({
    chat,
  }: {
    chat: Chat,
  }) {
    const errors = volatileAssistantErrors.get(chat.id);
    if (!errors || errors.size === 0) return;

    for (const [messageId, error] of errors.entries()) {
      const node = findNodeInBranch({ items: chat.root.items, targetId: messageId });
      if (!node || node.role !== 'assistant') continue;
      node.error = error;
    }
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
    applyVolatileAssistantErrorsToChat,
    setVolatileToolOutput,
    appendVolatileToolOutput,
    deleteVolatileToolOutput,
    getVolatileToolOutput,
    TEST_ONLY: {
      volatileToolOutputs,
    },
  };
}
