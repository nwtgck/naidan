import { useChat } from './useChat';

export function useReasoning() {
  const { getReasoningEffort, updateReasoningEffort } = useChat();

  return {
    getReasoningEffort,
    updateReasoningEffort,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
