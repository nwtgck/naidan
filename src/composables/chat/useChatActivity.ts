import { computed, type ComputedRef, type Ref } from 'vue';
import type { ContextCompactProgress } from '@/services/context-compact';
import type { ChatId } from '@/models/ids';
import {
  getChatContextCompactProgress,
  isChatGeneratingTitle,
  isChatProcessing,
  isChatTaskRunning,
} from '@/composables/chat/chat-activity-queries';

export type ChatActivityAdapter = {
  isProcessing: ComputedRef<boolean>,
  isTaskRunning: ComputedRef<boolean>,
  isGeneratingTitle: ComputedRef<boolean>,
  contextCompactProgress: ComputedRef<ContextCompactProgress>,

  TEST_ONLY: Record<never, never>,
};

export function useChatActivity({
  chatId,
}: {
  chatId: Readonly<Ref<ChatId>>,
}): ChatActivityAdapter {
  const isProcessingState = computed(() => {
    return isChatProcessing({
      chatId: chatId.value,
    });
  });

  const isTaskRunningState = computed(() => {
    return isChatTaskRunning({
      chatId: chatId.value,
    });
  });

  const isGeneratingTitleState = computed(() => {
    return isChatGeneratingTitle({
      chatId: chatId.value,
    });
  });

  const contextCompactProgressState = computed<ContextCompactProgress>(() => {
    return getChatContextCompactProgress({
      chatId: chatId.value,
    });
  });

  return {
    isProcessing: isProcessingState,
    isTaskRunning: isTaskRunningState,
    isGeneratingTitle: isGeneratingTitleState,
    contextCompactProgress: contextCompactProgressState,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
