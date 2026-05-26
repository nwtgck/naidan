import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetReasoningEffort,
  mockUpdateReasoningEffort,
} = vi.hoisted(() => ({
  mockGetReasoningEffort: vi.fn(),
  mockUpdateReasoningEffort: vi.fn(),
}));

vi.mock('@/composables/useChat', () => ({
  useChat: () => ({
    getReasoningEffort: mockGetReasoningEffort,
    updateReasoningEffort: mockUpdateReasoningEffort,
  }),
}));

import { useReasoningStore } from './useReasoningStore';

describe('useReasoningStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetReasoningEffort.mockReturnValue('medium');
  });

  it('delegates reasoning access to the compat store', () => {
    const reasoningStore = useReasoningStore();

    expect(reasoningStore.getReasoningEffort({ chatId: 'chat-1' })).toBe('medium');

    reasoningStore.updateReasoningEffort({
      chatId: 'chat-1',
      effort: 'low',
    });

    expect(mockGetReasoningEffort).toHaveBeenCalledWith({ chatId: 'chat-1' });
    expect(mockUpdateReasoningEffort).toHaveBeenCalledWith({
      chatId: 'chat-1',
      effort: 'low',
    });
  });
});
