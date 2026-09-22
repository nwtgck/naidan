import type { MessageNode } from '@/01-models/types';
import { createChatMessageSnapshot } from '@/01-models/chat-message';
import { cloneLmParameters } from '@/utils/lm-parameters';

/** Copy one node's content and metadata. The caller separately selects and links replies. */
export function copyMessageWithoutReplies({ message }: { message: MessageNode }): MessageNode {
  const content = createChatMessageSnapshot({ node: message });
  const common = { createdAt: message.createdAt, replies: { items: [] } };
  switch (content.role) {
  case 'user': return { ...common, ...content, parts: [...content.parts], modelId: undefined, lmParameters: cloneLmParameters({ lmParameters: message.lmParameters }) };
  case 'assistant': {
    switch (message.role) {
    case 'assistant': break;
    case 'user':
    case 'system':
    case 'tool': throw new Error('Snapshot role differs from its history node.');
    default: { const _ex: never = message; throw new Error(`Unhandled message: ${_ex}`); }
    }
    const interruption = (() => {
      const recorded = message.interruption;
      if (recorded === undefined) return undefined;
      switch (recorded.type) {
      case 'cancelled': return { type: 'cancelled' as const };
      case 'error': return { type: 'error' as const, message: recorded.message };
      default: { const _ex: never = recorded; throw new Error(`Unhandled interruption: ${_ex}`); }
      }
    })();
    return { ...common, ...content, parts: [...content.parts], modelId: message.modelId, lmParameters: cloneLmParameters({ lmParameters: message.lmParameters }), interruption };
  }
  case 'system': return { ...common, ...content, parts: [...content.parts], modelId: undefined, lmParameters: undefined };
  case 'tool': return { ...common, ...content, parts: [...content.parts], modelId: undefined, lmParameters: undefined };
  default: { const _ex: never = content; throw new Error(`Unhandled snapshot: ${_ex}`); }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
