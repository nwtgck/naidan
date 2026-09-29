import { chatVolatileState } from '@/composables/chat/global/chat-core-singletons';
import type { ChatId, MessageId } from '@/01-models/ids';

/** Drafts belong to the active generation, never to stored message parts. */
export function useToolCallDrafts() {
  return {
    getToolCallDrafts: ({ chatId, messageId }: { chatId: ChatId, messageId: MessageId }) => (
      chatVolatileState.getToolCallDrafts({ chatId, messageId })
    ),
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
