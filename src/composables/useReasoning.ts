import { computed } from 'vue';
import { useChatMetadata } from '@/composables/chat/useChatMetadata';

export function useReasoning() {
  const chatMetadata = useChatMetadata();

  return {
    getReasoningEffort: ({ chatId }: { chatId: string }) => chatMetadata.reasoningEffort({
      chatId: computed(() => chatId),
    }).value,
    updateReasoningEffort: ({ chatId, effort }: { chatId: string; effort: import('@/models/types').Reasoning['effort'] | undefined }) =>
      chatMetadata.updateReasoningEffort({ chatId, effort }),
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
