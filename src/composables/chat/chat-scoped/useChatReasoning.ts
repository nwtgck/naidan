import { computed, type ComputedRef, type Ref } from 'vue';
import type { Reasoning } from '@/models/types';
import {
  getReasoningEffortForChatId,
  updateReasoningEffortForChatId,
} from './chat-metadata-helpers';

export type ChatReasoningAdapter = {
  effort: ComputedRef<Reasoning['effort'] | undefined>;

  updateEffort({
    effort,
  }: {
    effort: Reasoning['effort'] | undefined;
  }): void;

  TEST_ONLY: Record<string, never>;
};

export function useChatReasoning({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatReasoningAdapter {
  const effort = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return undefined;
    }

    return getReasoningEffortForChatId({ chatId: id });
  });

  function updateEffort({
    effort,
  }: {
    effort: Reasoning['effort'] | undefined;
  }) {
    const id = chatId.value;
    if (id === undefined) {
      return;
    }

    void updateReasoningEffortForChatId({
      chatId: id,
      effort,
    });
  }

  return {
    effort,
    updateEffort,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
