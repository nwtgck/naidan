import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetReasoningEffort,
  mockUpdateReasoningEffort,
} = vi.hoisted(() => ({
  mockGetReasoningEffort: vi.fn(),
  mockUpdateReasoningEffort: vi.fn(),
}));

vi.mock('@/composables/useReasoning', () => ({
  useReasoning: () => ({
    getReasoningEffort: mockGetReasoningEffort,
    updateReasoningEffort: mockUpdateReasoningEffort,
  }),
}));

import { useChatReasoning } from './useChatReasoning';

describe('useChatReasoning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetReasoningEffort.mockReturnValue(undefined);
  });

  it('returns undefined and no-ops when chatId is undefined', () => {
    const chatReasoning = useChatReasoning({
      chatId: computed(() => undefined),
    });

    expect(chatReasoning.effort.value).toBeUndefined();

    chatReasoning.updateEffort({ effort: 'high' });

    expect(mockGetReasoningEffort).not.toHaveBeenCalled();
    expect(mockUpdateReasoningEffort).not.toHaveBeenCalled();
  });

  it('binds reasoning reads and writes to the scoped chatId', () => {
    mockGetReasoningEffort.mockReturnValue('medium');

    const chatReasoning = useChatReasoning({
      chatId: computed(() => 'chat-1'),
    });

    expect(chatReasoning.effort.value).toBe('medium');
    expect(mockGetReasoningEffort).toHaveBeenCalledWith({ chatId: 'chat-1' });

    chatReasoning.updateEffort({ effort: 'low' });

    expect(mockUpdateReasoningEffort).toHaveBeenCalledWith({
      chatId: 'chat-1',
      effort: 'low',
    });
  });
});
