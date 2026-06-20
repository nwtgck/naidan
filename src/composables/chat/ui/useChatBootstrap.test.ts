import { toChatId } from '@/models/ids';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockInstallChatBootstrap,
  mockLoadData,
  mockOpenChat,
  mockFetchForChat,
} = vi.hoisted(() => ({
  mockInstallChatBootstrap: vi.fn(),
  mockLoadData: vi.fn().mockResolvedValue(undefined),
  mockOpenChat: vi.fn().mockResolvedValue(undefined),
  mockFetchForChat: vi.fn(),
}));

vi.mock('@/composables/chat/chat-bootstrap', () => ({
  installChatBootstrap: mockInstallChatBootstrap,
}));

vi.mock('@/composables/chat/chat-derived-state', () => ({
  createChatDerivedState: () => ({
    resolvedSettings: { value: undefined },
  }),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  loadData: mockLoadData,
  chatRuntimeStore: {
    activeGenerations: new Map(),
  },
  currentChatRef: { value: null },
  rootItems: { value: [] },
}));

vi.mock('@/composables/chat/useChatModels', () => ({
  useChatModels: () => ({
    availableModels: { value: [] },
    fetchingModels: { value: false },
    fetchForChat: mockFetchForChat,
    fetchForGlobalEndpoint: vi.fn(),
    fetchForEndpoint: vi.fn(),
    TEST_ONLY: {},
  }),
}));

vi.mock('@/services/transformers-js', () => ({
  transformersJsService: {
    subscribeModelList: vi.fn(),
  },
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpointType: 'openai' } },
  }),
}));

vi.mock('@/composables/chat/ui/useChatNavigation', () => ({
  useChatNavigation: () => ({
    openChat: mockOpenChat,
  }),
}));

import { useChatBootstrap } from './useChatBootstrap';

describe('useChatBootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates load and open actions', async () => {
    const chatBootstrap = useChatBootstrap();

    expect(mockInstallChatBootstrap).toHaveBeenCalledTimes(1);

    await chatBootstrap.loadChats();
    await chatBootstrap.openChat({
      chatId: toChatId({ raw: 'chat-1' }),
    });

    expect(mockLoadData).toHaveBeenCalledWith();
    expect(mockOpenChat).toHaveBeenCalledWith({
      chatId: toChatId({ raw: 'chat-1' }),
    });
  });
});
