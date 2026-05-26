import type { Reasoning } from '@/models/types';
import {
  getReasoningEffortForChatId,
  updateReasoningEffortForChatId,
} from '@/composables/chat/chat-scoped/chat-metadata-helpers';

export type ReasoningStoreAdapter = {
  getReasoningEffort({
    chatId,
  }: {
    chatId: string;
  }): Reasoning['effort'] | undefined;

  updateReasoningEffort({
    chatId,
    effort,
  }: {
    chatId: string;
    effort: Reasoning['effort'];
  }): Promise<void> | void;

  TEST_ONLY: Record<string, never>;
};

export function useReasoningStore(): ReasoningStoreAdapter {
  return {
    getReasoningEffort: ({ chatId }) => getReasoningEffortForChatId({ chatId }),
    updateReasoningEffort: ({ chatId, effort }) => updateReasoningEffortForChatId({ chatId, effort }),
    TEST_ONLY: {},
  };
}
