import type { ChatMessage, ChatContent, MessageNode } from '@/01-models/types';
import type { MessageId } from '@/01-models/ids';
import { generateId } from '@/01-models/id';

/** Copy message content into an independent tree, never runtime state or branches. */
export function copyImportedChatHistory({ messages }: { messages: readonly ChatMessage[] }): ChatContent {
  for (const message of messages) {
    for (const part of message.parts) {
      switch (part.type) {
      case 'text': case 'reasoning':
        switch (part.completeness) {
        case 'complete': break;
        case 'partial': throw new Error('Import requires a complete conversation.');
        default: {
          const exhaustive: never = part.completeness;
          throw new Error(String(exhaustive));
        }
        }
        break;
      case 'attachment': throw new Error('External attachments require an explicit copy operation.');
      case 'tool_call': break;
      case 'tool_result':
        if (part.result.status === 'executing'
          || part.result.status === 'success' && part.result.content.type !== 'text'
          || part.result.status === 'error' && part.result.error.message.type !== 'text') {
          throw new Error('Import requires completed, materialized tool results.');
        }
        break;
      default: {
        const exhaustive: never = part;
        throw new Error(String(exhaustive));
      }
      }
    }
  }
  const nodes: MessageNode[] = messages.map(message => {
    const base = { id: generateId<MessageId>(), createdAt: Date.now(), replies: { items: [] }, lmParameters: undefined };
    switch (message.role) {
    case 'user': {
      if (message.parts.some(part => part.type === 'attachment' || part.completeness !== 'complete')) {
        throw new Error('Import requires complete text messages without external attachments.');
      }
      return { ...base, role: 'user', modelId: undefined, parts: structuredClone([...message.parts]) };
    }
    case 'system': return { ...base, role: 'system', modelId: undefined, parts: structuredClone([...message.parts]) };
    case 'assistant': return { ...base, role: 'assistant', modelId: undefined, parts: structuredClone([...message.parts]), interruption: undefined };
    case 'tool': return { ...base, role: 'tool', modelId: undefined, parts: structuredClone([...message.parts]) };
    default: {
      const exhaustive: never = message;
      throw new Error(String(exhaustive));
    }
    }
  });
  for (let index = 0; index + 1 < nodes.length; index++) {
    nodes[index]!.replies.items.push(nodes[index + 1]!);
  }
  return { root: { items: nodes.slice(0, 1) }, currentLeafId: nodes.at(-1)?.id };
}

export const TEST_ONLY = {
};
