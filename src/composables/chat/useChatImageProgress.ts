import { computed, type ComputedRef, type Ref } from 'vue';
import { useImageGeneration } from '@/composables/useImageGeneration';
import type { ChatId } from '@/01-models/ids';

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
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {},
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
