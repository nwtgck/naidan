import { computed, type ComputedRef, type Ref } from 'vue';
import { useImageGeneration } from '@/composables/useImageGeneration';

export type ChatImageProgressAdapter = {
  progress: ComputedRef<{ currentStep: number; totalSteps: number } | undefined>;
  currentStep: ComputedRef<number | undefined>;
  totalSteps: ComputedRef<number | undefined>;

  TEST_ONLY: Record<string, never>;
};

export function useChatImageProgress({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatImageProgressAdapter {
  const imageGeneration = useImageGeneration();

  const progress = computed(() => {
    const id = chatId.value;
    if (id === undefined) {
      return undefined;
    }

    return imageGeneration.imageProgressMap.value[id];
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
