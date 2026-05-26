import { computed } from 'vue';
import { describe, expect, it, vi } from 'vitest';

const {
  mockIsProcessing,
  mockGetProgress,
} = vi.hoisted(() => ({
  mockIsProcessing: vi.fn(),
  mockGetProgress: vi.fn(),
}));

vi.mock('@/composables/chat/chat-core-singletons', () => ({
  chatRuntimeStore: {
    isProcessing: ({ chatId }: { chatId: string }) => mockIsProcessing(chatId),
  },
  contextCompactRuntime: {
    getProgress: ({ chatId }: { chatId: string | undefined }) => mockGetProgress(chatId),
  },
}));

import { useChatRuntime } from './useChatRuntime';

describe('useChatRuntime', () => {
  it('returns idle defaults when chatId is undefined', () => {
    mockGetProgress.mockReturnValueOnce({ phase: 'idle' });

    const chatRuntime = useChatRuntime({
      chatId: computed(() => undefined),
    });

    expect(chatRuntime.isProcessing.value).toBe(false);
    expect(chatRuntime.contextCompactProgress.value).toEqual({ phase: 'idle' });
    expect(mockIsProcessing).not.toHaveBeenCalled();
    expect(mockGetProgress).toHaveBeenCalledWith(undefined);
  });

  it('reads runtime state for the scoped chatId', () => {
    mockIsProcessing.mockReturnValueOnce(true);
    mockGetProgress.mockReturnValueOnce({
      phase: 'receiving_compact',
      compactedMessageCount: 4,
      suffixMessageCount: 2,
      outputChars: 128,
      requestPreview: '# Compact Context',
      outputPreview: 'partial',
    });

    const chatRuntime = useChatRuntime({
      chatId: computed(() => 'chat-1'),
    });

    expect(chatRuntime.isProcessing.value).toBe(true);
    expect(chatRuntime.contextCompactProgress.value).toEqual({
      phase: 'receiving_compact',
      compactedMessageCount: 4,
      suffixMessageCount: 2,
      outputChars: 128,
      requestPreview: '# Compact Context',
      outputPreview: 'partial',
    });
    expect(mockIsProcessing).toHaveBeenCalledWith('chat-1');
    expect(mockGetProgress).toHaveBeenCalledWith('chat-1');
  });
});
