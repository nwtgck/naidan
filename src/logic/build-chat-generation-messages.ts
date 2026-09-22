import type { ChatContent, ChatMessage } from '@/01-models/types';
import { idToRaw, toMessageId, type MessageId } from '@/01-models/ids';
import { createChatMessageSnapshot } from '@/01-models/chat-message';
import { getChatBranchIterator } from '@/logic/chat-tree';

/**
 * Captures the selected history before asynchronous input preparation begins.
 * Provider adapters resolve binary references and model-specific formats later.
 */
export function buildChatGenerationMessages({ chat, excludedMessageId, systemPromptMessages }: {
  chat: ChatContent | Readonly<ChatContent>,
  excludedMessageId: MessageId | undefined,
  systemPromptMessages: readonly string[],
}): ChatMessage[] {
  const history = Array.from(getChatBranchIterator({ chat })).filter(message => message.id !== excludedMessageId);
  const usedIds = new Set(history.map(message => idToRaw({ id: message.id })));
  const messages: ChatMessage[] = systemPromptMessages.map((text, index) => {
    // These request-local IDs are not persisted and do not become model content.
    let raw = `system_prompt_${index}`;
    while (usedIds.has(raw)) raw += '_';
    usedIds.add(raw);
    return {
      id: toMessageId({ raw }), role: 'system',
      parts: [{ type: 'text', text, completeness: 'complete' }],
    };
  });
  for (const node of history) {
    messages.push(createChatMessageSnapshot({ node }));
  }
  return messages;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
