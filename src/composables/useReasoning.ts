import {
  getReasoningEffortForChatId,
  updateReasoningEffortForChatId,
} from '@/composables/chat/chat-scoped/chat-metadata-helpers';

export function useReasoning() {
  return {
    getReasoningEffort: ({ chatId }: { chatId: string }) => getReasoningEffortForChatId({ chatId }),
    updateReasoningEffort: ({ chatId, effort }: { chatId: string; effort: import('@/models/types').Reasoning['effort'] | undefined }) =>
      updateReasoningEffortForChatId({ chatId, effort }),
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
