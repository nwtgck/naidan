import { reactive } from 'vue';
import { findNodeInBranch } from '@/utils/chat-tree';
import type { Chat } from '@/models/types';

export type ChatVolatileState = {
  setVolatileAssistantError({
    chatId,
    messageId,
    error,
  }: {
    chatId: string;
    messageId: string;
    error: string;
  }): void;

  clearVolatileAssistantError({
    chatId,
    messageId,
  }: {
    chatId: string;
    messageId: string;
  }): void;

  applyVolatileAssistantErrorsToChat({
    chat,
  }: {
    chat: Chat;
  }): void;

  setVolatileToolOutput({
    toolCallId,
    output,
  }: {
    toolCallId: string;
    output: string;
  }): void;

  appendVolatileToolOutput({
    toolCallId,
    text,
  }: {
    toolCallId: string;
    text: string;
  }): void;

  deleteVolatileToolOutput({
    toolCallId,
  }: {
    toolCallId: string;
  }): void;

  getVolatileToolOutput({
    toolCallId,
  }: {
    toolCallId: string;
  }): string | undefined;

  TEST_ONLY: {
    volatileToolOutputs: Map<string, string>;
  };
};

export function createChatVolatileState(): ChatVolatileState {
  const volatileAssistantErrors = reactive(new Map<string, Map<string, string>>());
  const volatileToolOutputs = reactive(new Map<string, string>());

  function setVolatileAssistantError({
    chatId,
    messageId,
    error,
  }: {
    chatId: string;
    messageId: string;
    error: string;
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
    chatId: string;
    messageId: string;
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
    chat: Chat;
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
    toolCallId: string;
    output: string;
  }) {
    volatileToolOutputs.set(toolCallId, output);
  }

  function appendVolatileToolOutput({
    toolCallId,
    text,
  }: {
    toolCallId: string;
    text: string;
  }) {
    const previous = volatileToolOutputs.get(toolCallId) || '';
    volatileToolOutputs.set(toolCallId, previous + text);
  }

  function deleteVolatileToolOutput({
    toolCallId,
  }: {
    toolCallId: string;
  }) {
    volatileToolOutputs.delete(toolCallId);
  }

  function getVolatileToolOutput({
    toolCallId,
  }: {
    toolCallId: string;
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
