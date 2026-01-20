import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useChat } from './useChat';
import type { Chat, SidebarItem, ChatSummary, Hierarchy } from '../models/types';
import { useGlobalEvents } from './useGlobalEvents';
import { nextTick, reactive, toRaw } from 'vue';

// --- Mocks ---

const { mocks } = vi.hoisted(() => ({
  mocks: {
    capturedListener: null as ((event: any) => void) | null,
    mockChatStorage: new Map<string, Chat>(),
    mockGroupStorage: new Map<string, any>(),
    mockRootItems: [] as SidebarItem[],
    mockHierarchy: { items: [] } as Hierarchy,
  }
}));

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockImplementation((l) => {
      mocks.capturedListener = l;
      return () => {};
    }),
    listChats: vi.fn().mockImplementation(() => Promise.resolve(Array.from(mocks.mockChatStorage.values()).map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, groupId: c.groupId })))),
    loadChat: vi.fn().mockImplementation((id) => Promise.resolve(mocks.mockChatStorage.get(id) || null)),
    saveChat: vi.fn(),
    loadChatMeta: vi.fn().mockImplementation((id) => Promise.resolve(mocks.mockChatStorage.get(id) || null)),
    updateChatMeta: vi.fn().mockImplementation(async  (id, updater) => {
      const current = mocks.mockChatStorage.get(id) || null;
      const updated = await updater(current);
      mocks.mockChatStorage.set(id, JSON.parse(JSON.stringify(updated)));
      return Promise.resolve();
    }),
    updateChatContent: vi.fn().mockImplementation(async (id, updater) => {
      const existing = mocks.mockChatStorage.get(id) || null;
      const updated = await updater(existing as any);
      if (existing) {
        mocks.mockChatStorage.set(id, { ...existing, ...updated });
      }
      return Promise.resolve();
    }),
    updateHierarchy: vi.fn().mockImplementation(async (updater) => {
      mocks.mockHierarchy = await updater(mocks.mockHierarchy);
      return Promise.resolve();
    }),
    loadHierarchy: vi.fn().mockImplementation(() => Promise.resolve(mocks.mockHierarchy)),
    getSidebarStructure: vi.fn().mockImplementation(() => Promise.resolve([...mocks.mockRootItems])),
    deleteChat: vi.fn().mockImplementation((id) => {
      mocks.mockChatStorage.delete(id);
      return Promise.resolve();
    }),
    updateChatGroup: vi.fn().mockImplementation(async  (id, updater) => {
      const current = mocks.mockGroupStorage.get(id) || null;
      const updated = await updater(current);
      mocks.mockGroupStorage.set(id, JSON.parse(JSON.stringify(updated)));
      return Promise.resolve();
    }),
    listChatGroups: vi.fn().mockImplementation(() => Promise.resolve(Array.from(mocks.mockGroupStorage.values()))),
    deleteChatGroup: vi.fn().mockImplementation((id) => {
      mocks.mockGroupStorage.delete(id);
      return Promise.resolve();
    }),
    canPersistBinary: true,
    getFile: vi.fn(),
    saveFile: vi.fn(),
    notify: vi.fn(),
  },
}));

vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpointType: 'openai', endpointUrl: 'http://localhost', storageType: 'local', autoTitleEnabled: false, defaultModelId: 'gpt-4', lmParameters: {}, providerProfiles: [], } },
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null },
  }),
}));

vi.mock('./useToast', () => ({ useToast: () => ({ addToast: vi.fn(), }), }));

vi.mock('../services/llm', () => ({
  OpenAIProvider: vi.fn().mockImplementation(() => ({ chat: vi.fn(), listModels: vi.fn().mockResolvedValue(['gpt-4']), })),
  OllamaProvider: vi.fn().mockImplementation(() => ({ chat: vi.fn(), listModels: vi.fn().mockResolvedValue(['gpt-4']), })),
}));

describe('useChat Cross-Tab Synchronization', () => {
  const { errorCount, clearEvents } = useGlobalEvents();
  const chatStore = useChat();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockChatStorage.clear();
    mocks.mockGroupStorage.clear();
    mocks.mockRootItems.length = 0;
    mocks.mockHierarchy = { items: [] };
    clearEvents();
    vi.useFakeTimers();
  });

  afterEach(() => { 
    expect(errorCount.value).toBe(0); 
    vi.useRealTimers();
  });

  const simulateExternalEvent = async (event: any) => {
    if (mocks.capturedListener) { 
      await mocks.capturedListener(event); 
      // Yield to event loop to allow any microtasks/promises from the listener to resolve
      await Promise.resolve();
    }
  };

  it('should update current chat title when renamed in another tab', async () => {
    const { createNewChat, currentChat } = chatStore;
    const chat = await createNewChat();
    const chatId = chat!.id;
    const updatedChat = { ...currentChat.value!, title: 'New Title' };
    mocks.mockChatStorage.set(chatId, JSON.parse(JSON.stringify(updatedChat)));
    await simulateExternalEvent({ type: 'chat_meta_and_chat_group', id: chatId });
    
    vi.advanceTimersByTime(200);
    await nextTick();
    expect(currentChat.value?.title).toBe('New Title');
  });

  it('should close current chat when deleted in another tab', async () => {
    const { createNewChat, currentChat } = chatStore;
    const chat = await createNewChat();
    const chatId = chat!.id;
    
    mocks.mockChatStorage.delete(chatId);
    await simulateExternalEvent({ type: 'chat_meta_and_chat_group', id: chatId });
    
    vi.advanceTimersByTime(200);
    await nextTick();
    
    expect(currentChat.value).toBeNull();
  });

  it('should reflect sidebar changes when reordered in another tab', async () => {
    const { rootItems, loadChats } = chatStore;
    await loadChats();
    const newItem: SidebarItem = { id: 'chat:chat-1', type: 'chat', chat: { id: 'chat-1', title: 'C1', updatedAt: Date.now(), groupId: null } };
    mocks.mockRootItems.push(newItem);
    await simulateExternalEvent({ type: 'chat_meta_and_chat_group' });
    
    vi.advanceTimersByTime(200);
    await nextTick();
    expect(rootItems.value.length).toBe(1);
  });

  it('should reload chat content when updated in another tab (if not generating)', async () => {
    const { createNewChat, currentChat } = chatStore;
    const chat = await createNewChat();
    const chatId = chat!.id;
    const updatedChat = JSON.parse(JSON.stringify(chat));
    updatedChat.root.items.push({ id: 'msg-ext', role: 'user', content: 'Ext', timestamp: Date.now(), replies: { items: [] } });
    mocks.mockChatStorage.set(chatId, updatedChat);
    await simulateExternalEvent({ type: 'chat_content', id: chatId });
    
    vi.advanceTimersByTime(200);
    await nextTick();
    expect(currentChat.value?.root.items.length).toBe(1);
  });

  it('should NOT reload chat content if we are currently generating for it', async () => {
    const { createNewChat, currentChat, activeGenerations } = chatStore;
    const chat = await createNewChat();
    const chatId = chat!.id;
    activeGenerations.set(chatId, { controller: new AbortController(), chat: chat as any });
    const updatedChat = JSON.parse(JSON.stringify(chat));
    updatedChat.root.items.push({ id: 'msg-ext', role: 'user', content: 'Ext', timestamp: Date.now(), replies: { items: [] } });
    mocks.mockChatStorage.set(chatId, updatedChat);
    await simulateExternalEvent({ type: 'chat_content', id: chatId });
    
    vi.advanceTimersByTime(200);
    await nextTick();
    expect(currentChat.value?.root.items.length).toBe(0);
    activeGenerations.delete(chatId);
  });

  it('should update metadata but preserve local messages during background generation', async () => {
    const { createNewChat, currentChat, activeGenerations } = chatStore;
    const chat = await createNewChat();
    const chatId = chat!.id;
    activeGenerations.set(chatId, { controller: new AbortController(), chat: chat as any });
    const updatedChat = JSON.parse(JSON.stringify(chat));
    updatedChat.title = 'External Title';
    mocks.mockChatStorage.set(chatId, updatedChat);
    await simulateExternalEvent({ type: 'chat_meta_and_chat_group', id: chatId });
    
    vi.advanceTimersByTime(200);
    await nextTick();
    expect(currentChat.value?.title).toBe('External Title');
    // Use toRaw to compare underlying instances since currentChat is a readonly proxy
    expect(toRaw(currentChat.value)).toBe(toRaw(chat));
    activeGenerations.delete(chatId);
  });

  it('should handle full migration event by reloading everything', async () => {
    const { createNewChat, currentChat, rootItems } = chatStore;
    await createNewChat();
    mocks.mockChatStorage.clear();
    mocks.mockRootItems.length = 0;
    const migratedChatSummary: ChatSummary = { id: 'm1', title: 'M', updatedAt: Date.now(), groupId: null };
    mocks.mockRootItems.push({ id: 'chat:m1', type: 'chat', chat: migratedChatSummary });
    await simulateExternalEvent({ type: 'migration' });
    
    vi.advanceTimersByTime(200);
    await nextTick();
    expect(rootItems.value.length).toBe(1);
    expect(currentChat.value).toBeNull();
  });

  it('should maintain the latest group ID if moved externally while generating', async () => {
    const { createNewChat, activeGenerations, updateChatMeta } = chatStore;
    const chat = await createNewChat();
    const chatId = chat!.id;
    activeGenerations.set(chatId, { controller: new AbortController(), chat: chat as any });
    
    // External tab moves chat to group-x
    mocks.mockRootItems.push({ 
      id: 'chat_group:group-x', 
      type: 'chat_group', 
      chatGroup: { 
        id: 'group-x', name: 'X', isCollapsed: false, updatedAt: 0,
        items: [{ id: `chat:${chatId}`, type: 'chat', chat: { id: chatId, title: 'T', updatedAt: 0, groupId: 'group-x' } }]
      }
    });
    
    await simulateExternalEvent({ type: 'chat_meta_and_chat_group', id: chatId });
    vi.advanceTimersByTime(200);
    await nextTick();
    
    expect(chat!.groupId).toBe('group-x');
    await (updateChatMeta as any)(chatId, () => chat as any);
    expect(mocks.mockChatStorage.get(chatId)?.groupId).toBe('group-x');
    activeGenerations.delete(chatId);
  });

  it('should maintain group ID if hierarchy changed externally without specific chat ID', async () => {
    const { createNewChat, activeGenerations, updateChatMeta } = chatStore;
    const chat = await createNewChat();
    const chatId = chat!.id;
    activeGenerations.set(chatId, { controller: new AbortController(), chat: chatStore.currentChat.value! as any });
    mocks.mockRootItems.length = 0;
    mocks.mockRootItems.push({ id: 'chat_group:ge', type: 'chat_group', chatGroup: { id: 'ge', name: 'E', items: [{ id: `chat:${chatId}`, type: 'chat', chat: { id: chatId, title: 'C', updatedAt: 0, groupId: 'ge' } }], isCollapsed: false, updatedAt: 0 } });
    await simulateExternalEvent({ type: 'chat_meta_and_chat_group' });
    
    vi.advanceTimersByTime(200);
    await nextTick();
    
    expect(chatStore.currentChat.value?.groupId).toBe('ge');
    await (updateChatMeta as any)(chatId, () => chatStore.currentChat.value! as any);
    expect(mocks.mockChatStorage.get(chatId)?.groupId).toBe('ge');
    activeGenerations.delete(chatId);
  });

  it('should update current group view when renamed in another tab', async () => {
    const { createChatGroup, currentChatGroup, __testOnlySetCurrentChatGroup } = chatStore;
    const groupId = await createChatGroup('Old');
    const group = Array.from(mocks.mockGroupStorage.values())[0];
    __testOnlySetCurrentChatGroup(reactive(group));
    const renamed = { ...group, name: 'New' };
    mocks.mockGroupStorage.set(groupId, renamed);
    await simulateExternalEvent({ type: 'chat_meta_and_chat_group', id: groupId });
    
    vi.advanceTimersByTime(200);
    await nextTick();
    expect(currentChatGroup.value?.name).toBe('New');
  });

  it('should abort active generations when a migration occurs', async () => {
    const { createNewChat, activeGenerations } = chatStore;
    const chat = await createNewChat();
    const chatId = chat!.id;
    const controller = new AbortController();
    const abortSpy = vi.spyOn(controller, 'abort');
    activeGenerations.set(chatId, { controller, chat: chat as any });
    await simulateExternalEvent({ type: 'migration' });
    
    vi.advanceTimersByTime(200);
    await nextTick();
    expect(abortSpy).toHaveBeenCalled();
    expect(activeGenerations.size).toBe(0);
  });
});
