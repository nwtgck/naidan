import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toChatId } from '@/01-models/ids';

const {
  mockImageProgressMap,
} = vi.hoisted(() => ({
  mockImageProgressMap: {
    value: new Map(),
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
    mockImageProgressMap.value = new Map();
  });

  it('reads image progress for the scoped chatId', () => {
    mockImageProgressMap.value = new Map([
      [toChatId({ raw: 'chat-1' }), { currentStep: 2, totalSteps: 8 }],
    ]);

    const chatImageProgress = useChatImageProgress({
      chatId: computed(() => toChatId({ raw: 'chat-1' })),
    });

    expect(chatImageProgress.TEST_ONLY.progress.value).toEqual({ currentStep: 2, totalSteps: 8 });
    expect(chatImageProgress.currentStep.value).toBe(2);
    expect(chatImageProgress.totalSteps.value).toBe(8);
  });

  it('returns undefined progress when the chat has no active image generation', () => {
    const chatImageProgress = useChatImageProgress({
      chatId: computed(() => toChatId({ raw: 'chat-1' })),
    });

    expect(chatImageProgress.TEST_ONLY.progress.value).toBeUndefined();
    expect(chatImageProgress.currentStep.value).toBeUndefined();
    expect(chatImageProgress.totalSteps.value).toBeUndefined();
  });
});
