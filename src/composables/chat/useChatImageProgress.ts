import { computed, type ComputedRef, type Ref } from 'vue';
import { useImageGeneration } from '@/composables/useImageGeneration';
import type { ChatId } from '@/models/ids';

export type ChatImageProgressAdapter = {
  progress: ComputedRef<{ currentStep: number, totalSteps: number } | undefined>,
  currentStep: ComputedRef<number | undefined>,
  totalSteps: ComputedRef<number | undefined>,

  TEST_ONLY: Record<never, never>,
};

export function useChatImageProgress({
  chatId,
}: {
  chatId: Readonly<Ref<ChatId>>,
}): ChatImageProgressAdapter {
  const imageGeneration = useImageGeneration();

  const progress = computed(() => {
    return imageGeneration.imageProgressMap.value.get(chatId.value);
  });

  const currentStep = computed(() => progress.value?.currentStep);
  const totalSteps = computed(() => progress.value?.totalSteps);

  return {
    progress,
    currentStep,
    totalSteps,
    TEST_ONLY: {},
  };
}
