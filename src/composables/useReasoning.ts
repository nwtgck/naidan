import { useReasoningStore } from '@/composables/chat/ui/useReasoningStore';

export function useReasoning() {
  const { getReasoningEffort, updateReasoningEffort } = useReasoningStore();

  return {
    getReasoningEffort,
    updateReasoningEffort,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
