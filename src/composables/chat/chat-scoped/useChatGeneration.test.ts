import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSendMessage,
  mockRegenerateMessage,
  mockAbortChat,
} = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockRegenerateMessage: vi.fn(),
  mockAbortChat: vi.fn(),
}));

vi.mock('@/composables/chat/ui/useChatConversationActions', () => ({
  useChatConversationActions: () => ({
    abortChat: mockAbortChat,
  }),
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
    expect(mockAbortChat).toHaveBeenCalledWith({ chatId: undefined });
  });

  it('binds send, regenerate, and abort to the scoped chatId', async () => {
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
    expect(mockAbortChat).toHaveBeenCalledWith({ chatId: 'chat-1' });
  });
});
