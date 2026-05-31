import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetReasoningEffortForChatId,
  mockUpdateReasoningEffortForChatId,
} = vi.hoisted(() => ({
  mockGetReasoningEffortForChatId: vi.fn(),
  mockUpdateReasoningEffortForChatId: vi.fn(),
}));

vi.mock('./chat-metadata-helpers', () => ({
  getReasoningEffortForChatId: mockGetReasoningEffortForChatId,
  updateReasoningEffortForChatId: mockUpdateReasoningEffortForChatId,
}));

import { useChatReasoning } from './useChatReasoning';

describe('useChatReasoning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetReasoningEffortForChatId.mockReturnValue(undefined);
  });

  it('returns undefined and no-ops when chatId is undefined', () => {
    const chatReasoning = useChatReasoning({
      chatId: computed(() => undefined),
    });

    expect(chatReasoning.effort.value).toBeUndefined();

    chatReasoning.updateEffort({ effort: 'high' });

    expect(mockGetReasoningEffortForChatId).not.toHaveBeenCalled();
    expect(mockUpdateReasoningEffortForChatId).not.toHaveBeenCalled();
  });

  it('binds reasoning reads and writes to the scoped chatId', () => {
    mockGetReasoningEffortForChatId.mockReturnValue('medium');

    const chatReasoning = useChatReasoning({
      chatId: computed(() => 'chat-1'),
    });

    expect(chatReasoning.effort.value).toBe('medium');
    expect(mockGetReasoningEffortForChatId).toHaveBeenCalledWith({ chatId: 'chat-1' });

    chatReasoning.updateEffort({ effort: 'low' });

    expect(mockUpdateReasoningEffortForChatId).toHaveBeenCalledWith({
      chatId: 'chat-1',
      effort: 'low',
    });
  });
});
