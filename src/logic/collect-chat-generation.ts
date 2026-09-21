import type { ChatGenerationItem, ChatGenerationResult } from '@/01-models/lm';
import type { AssistantMessageNode } from '@/01-models/types';
import { toMessageId } from '@/01-models/ids';
import { consumeChatGeneration } from './consume-chat-generation';
import { getMessageText } from '@/01-models/message-text';

/** Drain all children even when a caller needs only the visible text, not reasoning. */
export async function collectChatGeneration({ items, abortController }: {
  items: AsyncIterable<ChatGenerationItem>,
  abortController: AbortController,
}): Promise<{ text: string, result: ChatGenerationResult }> {
  const node: AssistantMessageNode = {
    id: toMessageId({ raw: 'collected-assistant' }), role: 'assistant',
    createdAt: 0, parts: [], modelId: undefined, lmParameters: undefined,
    interruption: undefined, replies: { items: [] },
  };
  const result = await consumeChatGeneration({ node, items, abortController, onChange: () => {} });
  return { text: getMessageText({ message: node }), result };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
