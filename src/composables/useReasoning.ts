import { ref } from 'vue';
import type { Reasoning } from '../models/types';

// Shared state across all instances to maintain consistency
const reasoningEffortMap = ref<Record<string, Reasoning['effort']>>({});

export function useReasoning() {
  const getReasoningEffort = ({ chatId }: { chatId: string }): Reasoning['effort'] => {
    return reasoningEffortMap.value[chatId];
  };

  const updateReasoningEffort = ({ chatId, effort }: {
    chatId: string,
    effort: Reasoning['effort']
  }) => {
    reasoningEffortMap.value[chatId] = effort;
  };

  return {
    getReasoningEffort,
    updateReasoningEffort,
  };
}
