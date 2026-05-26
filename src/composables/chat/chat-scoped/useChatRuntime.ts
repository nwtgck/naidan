import { computed, type ComputedRef, type Ref } from 'vue';
import type { ContextCompactProgress } from '@/services/context-compact';
import { chatRuntimeStore, contextCompactRuntime } from '@/composables/chat/chat-core-singletons';

export type ChatRuntimeAdapter = {
  isProcessing: ComputedRef<boolean>;
  contextCompactProgress: ComputedRef<ContextCompactProgress>;

  TEST_ONLY: Record<string, never>;
};

export function useChatRuntime({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatRuntimeAdapter {
  const isProcessing = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return false;
    }

    return chatRuntimeStore.isProcessing({ chatId: id });
  });

  const contextCompactProgress = computed(() => {
    return contextCompactRuntime.getProgress({ chatId: chatId.value });
  });

  return {
    isProcessing,
    contextCompactProgress,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
