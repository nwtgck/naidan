import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetReasoningEffort,
  mockUpdateReasoningEffort,
} = vi.hoisted(() => ({
  mockGetReasoningEffort: vi.fn(),
  mockUpdateReasoningEffort: vi.fn(),
}));

vi.mock('@/composables/chat/chat-current-bridge', () => ({
  createChatCurrentBridge: () => ({
    getChatTargetById: ({ id }: { id: string }) => ({ id }),
    getCurrentChat: () => null,
    triggerCurrentChat: vi.fn(),
  }),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  currentChatGroupRef: { value: null },
  currentChatRef: { value: null },
  getLiveChat: vi.fn(),
  liveChatRegistry: new Map(),
  loadData: vi.fn(),
  updateChatMeta: vi.fn(),
}));

vi.mock('@/composables/chat/services/chat-metadata-service', () => ({
  createChatMetadataService: () => ({
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
