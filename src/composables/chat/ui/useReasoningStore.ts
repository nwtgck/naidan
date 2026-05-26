import { useChat } from '@/composables/useChat';
import type { Reasoning } from '@/models/types';

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
  const chatStore = useChat();

  return {
    getReasoningEffort: chatStore.getReasoningEffort,
    updateReasoningEffort: chatStore.updateReasoningEffort,
    TEST_ONLY: {},
  };
}
