import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toChatId } from '@/models/ids';
import type { ChatMeta } from '@/models/types';
import { useChatMetadata } from './useChatMetadata';

const mocks = vi.hoisted(() => ({
  getLiveChatById: vi.fn(),
  loadChatMeta: vi.fn(),
  loadData: vi.fn(),
  triggerCurrentChat: vi.fn(),
  updateChatMeta: vi.fn(),
  updateChatScopedSettings: vi.fn(),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  getLiveChatById: mocks.getLiveChatById,
  loadData: mocks.loadData,
  triggerCurrentChat: mocks.triggerCurrentChat,
  updateChatMeta: mocks.updateChatMeta,
  updateChatScopedSettings: mocks.updateChatScopedSettings,
}));

vi.mock('@/services/storage', () => ({
  storageService: {
    loadChatMeta: mocks.loadChatMeta,
  },
}));

function createChatMeta(): ChatMeta {
  return {
    id: toChatId({ raw: 'chat-1' }),
    title: 'Chat',
    createdAt: 1,
    updatedAt: 2,
    debugEnabled: false,
    endpoint: {
      type: 'openai',
      url: 'https://stored.example/v1',
      httpHeaders: [['X-Old', '1']],
    },
  };
}

describe('useChatMetadata scoped setting compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLiveChatById.mockReturnValue(null);
    mocks.loadChatMeta.mockResolvedValue(createChatMeta());
    mocks.updateChatScopedSettings.mockResolvedValue(undefined);
  });

  it('updates a non-live chat with an atomic endpoint override', async () => {
    const chatMetadata = useChatMetadata();
    const chatId = toChatId({ raw: 'chat-1' });

    await chatMetadata.updateSettings({
      chatId,
      updates: {
        endpoint: {
          type: 'openai',
          url: 'https://stored.example/v1',
          httpHeaders: [['X-New', '2']],
        },
      },
    });

    expect(mocks.loadChatMeta).not.toHaveBeenCalled();
    expect(mocks.updateChatScopedSettings).toHaveBeenCalledWith({
      chatId,
      changes: [{
        field: 'endpoint',
        behavior: 'override',
        value: {
          type: 'openai',
          url: 'https://stored.example/v1',
          httpHeaders: [['X-New', '2']],
        },
      }],
    });
  });

  it('updates the endpoint type and URL as one object', async () => {
    const chatMetadata = useChatMetadata();
    const chatId = toChatId({ raw: 'chat-1' });

    await chatMetadata.updateSettings({
      chatId,
      updates: {
        endpoint: {
          type: 'ollama',
          url: 'http://localhost:11434',
        },
      },
    });

    expect(mocks.loadChatMeta).not.toHaveBeenCalled();
    expect(mocks.updateChatScopedSettings).toHaveBeenCalledWith({
      chatId,
      changes: [{
        field: 'endpoint',
        behavior: 'override',
        value: {
          type: 'ollama',
          url: 'http://localhost:11434',
        },
      }],
    });
  });
});
