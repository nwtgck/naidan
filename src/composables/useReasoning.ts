import { useChat } from './useChat';

export function useReasoning() {
  const { getReasoningEffort, updateReasoningEffort } = useChat();

  return {
    getReasoningEffort,
    updateReasoningEffort,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
