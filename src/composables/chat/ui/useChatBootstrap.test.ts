import { toChatId } from '@/01-models/ids';
import type { SidebarItem } from '@/01-models/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockInstallChatBootstrap,
  mockLoadData,
  mockOpenChat,
  mockFetchForChat,
  mockReplaceSidebarItems,
} = vi.hoisted(() => ({
  mockInstallChatBootstrap: vi.fn(),
  mockLoadData: vi.fn().mockResolvedValue(undefined),
  mockOpenChat: vi.fn().mockResolvedValue(undefined),
  mockFetchForChat: vi.fn(),
  mockReplaceSidebarItems: vi.fn(),
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
  replaceSidebarItems: mockReplaceSidebarItems,
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

vi.mock('@/features/transformers-js', () => ({
  transformersJsService: {
    subscribeModelList: vi.fn(),
  },
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpoint: { type: 'openai', url: '' } } },
  }),
}));

vi.mock('@/composables/chat/ui/useChatNavigation', () => ({
  useChatNavigation: () => ({
    openChat: mockOpenChat,
  }),
}));

import { loadChatsForAppStartup, useChatBootstrap } from './useChatBootstrap';

describe('useChatBootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hydrates chat data without activating runtime listeners', async () => {
    await loadChatsForAppStartup({ initialSidebar: undefined });

    expect(mockLoadData).toHaveBeenCalledWith();
    expect(mockInstallChatBootstrap).not.toHaveBeenCalled();
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

  it('reuses the initial sidebar snapshot without evaluating runtime listeners or reading it twice', async () => {
    const initialSidebar: SidebarItem[] = [];
    await loadChatsForAppStartup({ initialSidebar });
    expect(mockReplaceSidebarItems).toHaveBeenCalledExactlyOnceWith({ items: initialSidebar });
    expect(mockLoadData).not.toHaveBeenCalled();
    expect(mockInstallChatBootstrap).not.toHaveBeenCalled();
  });
});
