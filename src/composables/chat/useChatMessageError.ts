import { computed, type ComputedRef, type Ref } from 'vue';
import type { ChatId } from '@/01-models/ids';
import type { MessageNode } from '@/01-models/types';
import { chatVolatileState } from './global/chat-core-singletons';

/** Combine display diagnostics without writing a transient failure into persisted history. */
export function useChatMessageError({ chatId, message }: {
  chatId: Readonly<Ref<ChatId>>,
  message: Readonly<Ref<MessageNode>>,
}): ComputedRef<string | undefined> {
  return computed(() => {
    const node = message.value;
    switch (node.role) {
    case 'assistant': {
      const transient = chatVolatileState.getVolatileAssistantError({ chatId: chatId.value, messageId: node.id });
      if (transient !== undefined) return transient;
      const interruption = node.interruption;
      if (interruption === undefined) return undefined;
      switch (interruption.type) {
      case 'cancelled': return undefined;
      case 'error': return interruption.message;
      default: { const _ex: never = interruption; throw new Error(`Unhandled interruption: ${_ex}`); }
      }
    }
    case 'user':
    case 'system':
    case 'tool': return undefined;
    default: { const _ex: never = node; throw new Error(`Unhandled message: ${_ex}`); }
    }
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
