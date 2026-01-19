import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useChat } from './useChat';
import { storageService } from '../services/storage';
import type { Chat, Hierarchy } from '../models/types';

/**
 * Multi-Tab Stress & Glitch Tests
 * 
 * Focus: High-frequency updates (streaming) and their impact on other tabs.
 */

const { mocks } = vi.hoisted(() => ({
  mocks: {
    mockChatStorage: new Map<string, any>(),
    mockHierarchy: { items: [] } as Hierarchy,
    mockNotify: null as any,
    mockRootItems: [] as any[],
  }
}));

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockImplementation((cb) => {
      mocks.mockNotify = cb;
      return () => {};
    }),
    listChats: vi.fn().mockImplementation(() => Promise.resolve([])),
    loadChat: vi.fn().mockImplementation(async (id) => {
      const chat = mocks.mockChatStorage.get(id);
      if (!chat) return null;
      return JSON.parse(JSON.stringify(chat));
    }),
    saveChatMeta: vi.fn().mockImplementation((meta) => {
      const existing = mocks.mockChatStorage.get(meta.id) || { root: { items: [] } };
      mocks.mockChatStorage.set(meta.id, { ...existing, ...meta });
      if (mocks.mockNotify) mocks.mockNotify({ type: 'chat_meta_and_chat_group', id: meta.id });
      return Promise.resolve();
    }),
    saveChatContent: vi.fn().mockImplementation((id, content) => {
      mocks.mockChatStorage.set(id, JSON.parse(JSON.stringify(content)));
      if (mocks.mockNotify) mocks.mockNotify({ type: 'chat_content', id });
      return Promise.resolve();
    }),
    loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
    updateHierarchy: vi.fn().mockResolvedValue(undefined),
    getSidebarStructure: vi.fn().mockImplementation(async () => {
      return [...mocks.mockRootItems];
    }),
    canPersistBinary: true,
    getFile: vi.fn(),
    saveFile: vi.fn(),
  } as any,
}));

vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpointType: 'openai', endpointUrl: 'http://localhost', storageType: 'local', autoTitleEnabled: false, defaultModelId: 'gpt-4', lmParameters: {}, providerProfiles: [] } },
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null },
  }),
}));

vi.mock('./useConfirm', () => ({ useConfirm: () => ({ showConfirm: vi.fn().mockResolvedValue(true) }) }));
vi.mock('./useToast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));

const mockLlmChat = vi.fn();
vi.mock('../services/llm', () => ({
  OpenAIProvider: function() { return { chat: (...args: any[]) => mockLlmChat(...args), listModels: vi.fn().mockResolvedValue(['gpt-4']) }; },
  OllamaProvider: function() { return { chat: vi.fn(), listModels: vi.fn() }; },
}));

describe('useChat Multi-Tab Stress Scenarios', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockChatStorage.clear();
    mocks.mockRootItems.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Stress: Tab A streaming chunks should not cause Tab B to reload Chat 100 times', async () => {
    const chatStoreA = useChat();
    const chatStoreB = useChat();

    const chat1: Chat = { 
      id: 'c1', title: 'C1', 
      root: { items: [{ id: 'm1', role: 'user', content: 'Hi', replies: { items: [{ id: 'a1', role: 'assistant', content: '', replies: { items: [] } }] }, timestamp: 0 }] },
      createdAt: 0, updatedAt: 0, debugEnabled: false, currentLeafId: 'a1'
    };
    mocks.mockChatStorage.set('c1', chat1);

    await chatStoreB.openChat('c1');
    const initialLoadCount = vi.mocked(storageService.loadChat).mock.calls.length;

    for (let i = 0; i < 50; i++) {
      const now = i * 100;
      vi.setSystemTime(now);
      if (i % 5 === 0 || i === 49) { 
        await storageService.saveChatContent('c1', chat1);
      }
    }

    vi.advanceTimersByTime(1000);
    const totalLoads = vi.mocked(storageService.loadChat).mock.calls.length - initialLoadCount;
    expect(totalLoads).toBeLessThan(15); 
  });

  it('Reliability: Tab B should not lose selection if storage is temporarily busy/null', async () => {
    const chatStoreB = useChat();
    const chat1: Chat = { id: 'c1', title: 'C1', root: { items: [] }, createdAt: 0, updatedAt: 0, debugEnabled: false };
    mocks.mockChatStorage.set('c1', chat1);

    await chatStoreB.openChat('c1');
    expect(chatStoreB.currentChat.value?.id).toBe('c1');

    vi.mocked(storageService.loadChat).mockResolvedValueOnce(null);
    await mocks.mockNotify({ type: 'chat_content', id: 'c1' });

    expect(chatStoreB.currentChat.value).not.toBeNull();
    expect(chatStoreB.currentChat.value?.id).toBe('c1');
  });

  it('Stress: should not queue multiple overlapping saveChatContent calls during streaming', async () => {
    // 1. Setup a slow save operation
    let activeSaves = 0;
    let maxConcurrentSaves = 0;
    vi.mocked(storageService.saveChatContent).mockImplementation(async () => {
      activeSaves++;
      maxConcurrentSaves = Math.max(maxConcurrentSaves, activeSaves);
      // Simulate a real delay
      await new Promise(resolve => setTimeout(resolve, 50));
      activeSaves--;
    });

    const chatStore = useChat();
    const chat: Chat = { id: 'c1', title: 'T', root: { items: [{ id: 'a1', role: 'assistant', content: '', replies: { items: [] } }] }, createdAt: 0, updatedAt: 0, debugEnabled: false };
    
    vi.useRealTimers();

    const simulateStreaming = async () => {
      let lastSave = 0;
      let isSaving = false;
      const assistantNode = chat.root.items[0];

      for (let i = 0; i < 10; i++) {
        assistantNode.content += 'word ';
        const now = Date.now();
        // Use a very short interval for the test
        if (now - lastSave > 10 && !isSaving) {
          isSaving = true;
          try {
            await storageService.saveChatContent(chat.id, chat);
            lastSave = Date.now();
          } finally {
            isSaving = false;
          }
        }
        await new Promise(r => setTimeout(r, 5));
      }
    };

    await simulateStreaming();

    expect(maxConcurrentSaves).toBe(1);
    vi.useFakeTimers();
  });

  it('Reliability: sidebar should update eventually even during continuous event stream (Starvation Test)', async () => {
    const chatStore = useChat();
    await chatStore.loadChats();
    expect(chatStore.rootItems.value).toHaveLength(0);

    mocks.mockRootItems.push({ id: 'chat:ext', type: 'chat', chat: { id: 'ext', title: 'External', updatedAt: Date.now(), groupId: null } });

    // Events every 50ms for 3 seconds. Debounce is 100ms.
    for (let i = 0; i < 60; i++) {
      vi.advanceTimersByTime(50);
      await mocks.mockNotify({ type: 'chat_meta_and_chat_group' });
      await Promise.resolve();
    }

    // Expected to fail if no "forced reload" logic exists
    expect(chatStore.rootItems.value.length).toBe(1);
  });
});
