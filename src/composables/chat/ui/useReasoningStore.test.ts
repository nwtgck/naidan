import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetReasoningEffortForChatId,
  mockUpdateReasoningEffortForChatId,
} = vi.hoisted(() => ({
  mockGetReasoningEffortForChatId: vi.fn(),
  mockUpdateReasoningEffortForChatId: vi.fn(),
}));

vi.mock('@/composables/chat/chat-scoped/chat-metadata-helpers', () => ({
  getReasoningEffortForChatId: mockGetReasoningEffortForChatId,
  updateReasoningEffortForChatId: mockUpdateReasoningEffortForChatId,
}));

import { useReasoningStore } from './useReasoningStore';

describe('useReasoningStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetReasoningEffortForChatId.mockReturnValue('medium');
  });

  it('delegates reasoning access to the compat store', () => {
    const reasoningStore = useReasoningStore();

    expect(reasoningStore.getReasoningEffort({ chatId: 'chat-1' })).toBe('medium');

    reasoningStore.updateReasoningEffort({
      chatId: 'chat-1',
      effort: 'low',
    });

    expect(mockGetReasoningEffortForChatId).toHaveBeenCalledWith({ chatId: 'chat-1' });
    expect(mockUpdateReasoningEffortForChatId).toHaveBeenCalledWith({
      chatId: 'chat-1',
      effort: 'low',
    });
  });
});
