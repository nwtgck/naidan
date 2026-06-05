import { computed, ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextCompactProgress } from '@/services/context-compact';

const {
  mockIsChatProcessing,
  mockIsChatGeneratingTitle,
  mockGetChatContextCompactProgress,
  mockIsChatTaskRunning,
} = vi.hoisted(() => ({
  mockIsChatProcessing: vi.fn(),
  mockIsChatGeneratingTitle: vi.fn(),
  mockGetChatContextCompactProgress: vi.fn(),
  mockIsChatTaskRunning: vi.fn(),
}));

vi.mock('@/composables/chat/chat-activity-queries', () => ({
  isChatProcessing: mockIsChatProcessing,
  isChatGeneratingTitle: mockIsChatGeneratingTitle,
  getChatContextCompactProgress: mockGetChatContextCompactProgress,
  isChatTaskRunning: mockIsChatTaskRunning,
}));

import { useChatActivity } from './useChatActivity';

describe('useChatActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsChatProcessing.mockReturnValue(false);
    mockIsChatTaskRunning.mockReturnValue(false);
    mockIsChatGeneratingTitle.mockReturnValue(false);
    mockGetChatContextCompactProgress.mockReturnValue({ phase: 'idle' } satisfies ContextCompactProgress);
  });

  it('reads reactive activity state for the scoped chatId', () => {
    const chatId = ref('chat-1');
    mockIsChatProcessing.mockImplementation(({ chatId }: { chatId: string }) => chatId === 'chat-1');
    mockIsChatTaskRunning.mockImplementation(({ chatId }: { chatId: string }) => chatId === 'chat-1');
    mockIsChatGeneratingTitle.mockImplementation(({ chatId }: { chatId: string }) => chatId === 'chat-1');
    mockGetChatContextCompactProgress.mockImplementation(({ chatId }: { chatId: string }) => {
      if (chatId === 'chat-1') {
        return {
          phase: 'requesting_model',
          compactedMessageCount: 3,
          suffixMessageCount: 1,
          requestPreview: 'compact',
        } satisfies ContextCompactProgress;
      }

      return { phase: 'idle' } satisfies ContextCompactProgress;
    });

    const chatActivity = useChatActivity({
      chatId: computed(() => chatId.value),
    });

    expect(chatActivity.isProcessing.value).toBe(true);
    expect(chatActivity.isTaskRunning.value).toBe(true);
    expect(chatActivity.isGeneratingTitle.value).toBe(true);
    expect(chatActivity.contextCompactProgress.value).toEqual({
      phase: 'requesting_model',
      compactedMessageCount: 3,
      suffixMessageCount: 1,
      requestPreview: 'compact',
    });

    chatId.value = 'chat-2';

    expect(chatActivity.isProcessing.value).toBe(false);
    expect(chatActivity.isTaskRunning.value).toBe(false);
    expect(chatActivity.isGeneratingTitle.value).toBe(false);
    expect(chatActivity.contextCompactProgress.value).toEqual({
      phase: 'idle',
    });
  });
});
