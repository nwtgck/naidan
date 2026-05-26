import { computed, type ComputedRef, type Ref } from 'vue';
import type { Reasoning } from '@/models/types';
import { useReasoning } from '@/composables/useReasoning';

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
  const reasoningStore = useReasoning();

  const effort = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return undefined;
    }

    return reasoningStore.getReasoningEffort({ chatId: id });
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

    reasoningStore.updateReasoningEffort({
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
