import { ref } from 'vue';
import { beforeEach, describe, expect, it } from 'vitest';
import { useImageGeneration } from '@/composables/useImageGeneration';
import { useChatImageProgress } from './useChatImageProgress';

describe('useChatImageProgress', () => {
  beforeEach(() => {
    const imageGeneration = useImageGeneration();
    imageGeneration.imageProgressMap.value = {};
  });

  it('reads image progress for the scoped chat', () => {
    const imageGeneration = useImageGeneration();
    imageGeneration.imageProgressMap.value['chat-1'] = {
      currentStep: 4,
      totalSteps: 12,
    };

    const chatId = ref('chat-1');
    const chatImageProgress = useChatImageProgress({
      chatId,
    });

    expect(chatImageProgress.progress.value).toEqual({
      currentStep: 4,
      totalSteps: 12,
    });
    expect(chatImageProgress.currentStep.value).toBe(4);
    expect(chatImageProgress.totalSteps.value).toBe(12);
  });

  it('returns undefined progress when chatId is missing', () => {
    const chatId = ref<string | undefined>(undefined);
    const chatImageProgress = useChatImageProgress({
      chatId,
    });

    expect(chatImageProgress.progress.value).toBeUndefined();
    expect(chatImageProgress.currentStep.value).toBeUndefined();
    expect(chatImageProgress.totalSteps.value).toBeUndefined();
  });
});
