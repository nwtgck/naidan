import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSendMessage,
  mockRegenerateMessage,
  mockNotify,
  mockAbortTitleGeneration,
  mockGetActiveContextCompaction,
  mockGetActiveGeneration,
  mockHasExternalGeneration,
  mockActiveGenerations,
} = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockRegenerateMessage: vi.fn(),
  mockNotify: vi.fn(),
  mockAbortTitleGeneration: vi.fn(),
  mockGetActiveContextCompaction: vi.fn(),
  mockGetActiveGeneration: vi.fn(),
  mockHasExternalGeneration: vi.fn(),
  mockActiveGenerations: new Map<string, unknown>(),
}));

vi.mock('@/services/storage', () => ({
  storageService: {
    notify: mockNotify,
  },
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  chatRuntimeStore: {
    activeGenerations: mockActiveGenerations,
    getActiveGeneration: mockGetActiveGeneration,
    hasExternalGeneration: mockHasExternalGeneration,
  },
  contextCompactRuntime: {
    getActiveContextCompaction: mockGetActiveContextCompaction,
  },
}));

vi.mock('@/composables/chat/chat-scoped/chat-title-helpers', () => ({
  abortTitleGenerationForChat: mockAbortTitleGeneration,
}));

vi.mock('@/composables/chat/chat-scoped/chat-generation-flow', () => ({
  sendMessageForChat: mockSendMessage,
  regenerateMessageForChat: mockRegenerateMessage,
}));

import { useChatGeneration } from './useChatGeneration';

describe('useChatGeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessage.mockResolvedValue(true);
    mockActiveGenerations.clear();
    mockGetActiveContextCompaction.mockReturnValue(undefined);
    mockGetActiveGeneration.mockReturnValue(undefined);
    mockHasExternalGeneration.mockReturnValue(false);
  });

  it('returns false and does not send when chatId is undefined', async () => {
    const chatGeneration = useChatGeneration({
      chatId: computed(() => undefined),
    });

    await expect(chatGeneration.sendMessage({
      content: 'Hello',
      parentId: undefined,
      attachments: undefined,
      lmParameters: undefined,
    })).resolves.toBe(false);

    await expect(chatGeneration.regenerateMessage({
      failedMessageId: 'assistant-1',
    })).resolves.toBeUndefined();

    chatGeneration.abort({});

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockRegenerateMessage).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockAbortTitleGeneration).not.toHaveBeenCalled();
  });

  it('binds send, regenerate, and abort to the scoped chatId', async () => {
    const mockAbort = vi.fn();
    const mockControllerAbort = vi.fn();
    mockGetActiveContextCompaction.mockReturnValue({ abort: mockAbort });
    mockActiveGenerations.set('chat-1', {});
    mockGetActiveGeneration.mockReturnValue({
      controller: {
        abort: mockControllerAbort,
      },
    });

    const chatGeneration = useChatGeneration({
      chatId: computed(() => 'chat-1'),
    });

    await expect(chatGeneration.sendMessage({
      content: 'Hello',
      parentId: null,
      attachments: [],
      lmParameters: undefined,
    })).resolves.toBe(true);

    await chatGeneration.regenerateMessage({
      failedMessageId: 'assistant-1',
    });

    chatGeneration.abort({});

    expect(mockSendMessage).toHaveBeenCalledWith({
      chatId: 'chat-1',
      content: 'Hello',
      parentId: null,
      attachments: [],
      lmParameters: undefined,
    });
    expect(mockRegenerateMessage).toHaveBeenCalledWith({
      chatId: 'chat-1',
      failedMessageId: 'assistant-1',
    });
    expect(mockAbort).toHaveBeenCalled();
    expect(mockControllerAbort).toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith({
      type: 'chat_content_generation',
      id: 'chat-1',
      status: 'abort_request',
      timestamp: expect.any(Number),
    });
    expect(mockAbortTitleGeneration).toHaveBeenCalledWith({ chatId: 'chat-1' });
  });
});
