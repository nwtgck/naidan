import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockImageProgressMap,
} = vi.hoisted(() => ({
  mockImageProgressMap: {
    value: {} as Record<string, { currentStep: number; totalSteps: number } | undefined>,
  },
}));

vi.mock('@/composables/useImageGeneration', () => ({
  useImageGeneration: () => ({
    imageProgressMap: mockImageProgressMap,
  }),
}));

import { useChatImageProgress } from './useChatImageProgress';

describe('useChatImageProgress', () => {
  beforeEach(() => {
    mockImageProgressMap.value = {};
  });

  it('reads image progress for the scoped chatId', () => {
    mockImageProgressMap.value = {
      'chat-1': { currentStep: 2, totalSteps: 8 },
    };

    const chatImageProgress = useChatImageProgress({
      chatId: computed(() => 'chat-1'),
    });

    expect(chatImageProgress.progress.value).toEqual({ currentStep: 2, totalSteps: 8 });
    expect(chatImageProgress.currentStep.value).toBe(2);
    expect(chatImageProgress.totalSteps.value).toBe(8);
  });

  it('returns undefined progress when the chat has no active image generation', () => {
    const chatImageProgress = useChatImageProgress({
      chatId: computed(() => 'chat-1'),
    });

    expect(chatImageProgress.progress.value).toBeUndefined();
    expect(chatImageProgress.currentStep.value).toBeUndefined();
    expect(chatImageProgress.totalSteps.value).toBeUndefined();
  });
});
