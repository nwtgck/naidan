import { computed } from 'vue';
import type { ChatId } from '@/01-models/ids';
import { useChatMetadata } from '@/composables/chat/useChatMetadata';

export function useReasoning() {
  const chatMetadata = useChatMetadata();

  return {
    getReasoningEffort: ({ chatId }: { chatId: ChatId }) => chatMetadata.reasoningEffort({
      chatId: computed(() => chatId),
    }).value,
    updateReasoningEffort: ({ chatId, effort }: { chatId: ChatId, effort: import('@/01-models/types').Reasoning['effort'] | undefined }) =>
      chatMetadata.updateReasoningEffort({ chatId, effort }),
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
      },
    }) || {}),
  };
}
