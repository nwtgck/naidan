import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useChat } from './useChat';
import type { Chat, SidebarItem, ChatSummary, Hierarchy } from '@/models/types';
import { useGlobalEvents } from './useGlobalEvents';
import { nextTick, reactive, toRaw } from 'vue';
import { idToRaw, toChatGroupId, toChatId } from '@/models/ids';

// --- Mocks ---

const { mocks } = vi.hoisted(() => ({
  mocks: {
    capturedListener: null as (({ event }: { event: any }) => void | Promise<void>) | null,
    mockChatStorage: new Map<string, Chat>(),
    mockGroupStorage: new Map<string, any>(),
    mockRootItems: [] as SidebarItem[],
    mockHierarchy: { items: [] } as Hierarchy,
  },
}));

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockImplementation(({ listener }) => {
      mocks.capturedListener = listener;
      return () => {};
    }),
    listChats: vi.fn().mockImplementation(() => Promise.resolve(Array.from(mocks.mockChatStorage.values()).map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, groupId: c.groupId })))),
    loadChat: vi.fn().mockImplementation(({ id }: { id: string }) => Promise.resolve(mocks.mockChatStorage.get(id) || null)),
    saveChat: vi.fn(),
    loadChatMeta: vi.fn().mockImplementation(({ id }: { id: string }) => Promise.resolve(mocks.mockChatStorage.get(id) || null)),
    updateChatMeta: vi.fn().mockImplementation(async ({ id, updater }) => {
      const current = mocks.mockChatStorage.get(id) || null;
      const updated = await updater({ current: current });
      mocks.mockChatStorage.set(id, JSON.parse(JSON.stringify(updated)));
      return Promise.resolve();
    }),
    updateChatContent: vi.fn().mockImplementation(async ({ id, updater }) => {
      const existing = mocks.mockChatStorage.get(id) || null;
      const updated = await updater({ current: existing as any });
      if (existing) {
        mocks.mockChatStorage.set(id, { ...existing, ...updated });
      }
      return Promise.resolve();
    }),
    updateHierarchy: vi.fn().mockImplementation(async ({ updater }) => {
      mocks.mockHierarchy = await updater({ current: mocks.mockHierarchy });
      return Promise.resolve();
    }),
    loadHierarchy: vi.fn().mockImplementation(() => Promise.resolve(mocks.mockHierarchy)),
    getSidebarStructure: vi.fn().mockImplementation(() => Promise.resolve([...mocks.mockRootItems])),
    deleteChat: vi.fn().mockImplementation(({ id }: { id: string }) => {
      mocks.mockChatStorage.delete(id);
      return Promise.resolve();
    }),
    updateChatGroup: vi.fn().mockImplementation(async ({ id, updater }) => {
      const current = mocks.mockGroupStorage.get(id) || null;
      const updated = await updater({ current: current });
      mocks.mockGroupStorage.set(id, JSON.parse(JSON.stringify(updated)));
      return Promise.resolve();
    }),
    listChatGroups: vi.fn().mockImplementation(() => Promise.resolve(Array.from(mocks.mockGroupStorage.values()))),
    loadChatGroup: vi.fn().mockResolvedValue(null),
    deleteChatGroup: vi.fn().mockImplementation(({ id }: { id: string }) => {
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
    settings: { value: { endpointType: 'openai', endpointUrl: 'http://localhost', storageType: 'local', autoTitleEnabled: false, defaultModelId: 'gpt-4', lmParameters: {}, providerProfiles: [] } },
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null },
  }),
}));

vi.mock('./useToast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));

vi.mock('../services/lm/openai', () => ({
  OpenAIProvider: vi.fn().mockImplementation(() => ({ chat: vi.fn(), listModels: vi.fn().mockResolvedValue(['gpt-4']) })),
}));

vi.mock('../services/lm/ollama', () => ({
  OllamaProvider: vi.fn().mockImplementation(() => ({ chat: vi.fn(), listModels: vi.fn().mockResolvedValue(['gpt-4']) })),
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
    vi.advanceTimersByTime(5000); // Ensure lastSidebarReload is effectively 'long ago'
  });

  afterEach(() => {
    expect(errorCount.value).toBe(0);
    vi.useRealTimers();
  });

  const simulateExternalEvent = async (event: any) => {
    if (mocks.capturedListener) {
      await mocks.capturedListener({ event });
      // Yield to event loop to allow any microtasks/promises from the listener to resolve
      await Promise.resolve();
    }
  };

  it('should update current chat title when renamed in another tab', async () => {
    const { createNewChat, currentChat } = chatStore;
    const chat = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const chatId = chat!.id;
    const updatedChat = { ...currentChat.value!, title: 'New Title' };
    mocks.mockChatStorage.set(idToRaw({ id: chatId }), JSON.parse(JSON.stringify(updatedChat)));
    await simulateExternalEvent({ type: 'chat_meta_and_chat_group', id: idToRaw({ id: chatId }) });

    vi.advanceTimersByTime(600);
    await nextTick();
    expect(currentChat.value?.title).toBe('New Title');
  });

  it('should close current chat when deleted in another tab', async () => {
    const { createNewChat, currentChat } = chatStore;
    const chat = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const chatId = chat!.id;

    mocks.mockChatStorage.delete(idToRaw({ id: chatId }));
    await simulateExternalEvent({ type: 'chat_meta_and_chat_group', id: idToRaw({ id: chatId }) });

    vi.advanceTimersByTime(600);
    await nextTick();

    expect(currentChat.value).toBeNull();
  });

  it('should reflect sidebar changes when reordered in another tab', async () => {
    const { rootItems, loadChats } = chatStore;
    await loadChats();
    const newItem: SidebarItem = { id: 'chat:chat-1', type: 'chat', chat: { id: toChatId({ raw: 'chat-1' }), title: 'C1', updatedAt: Date.now(), groupId: null } };
    mocks.mockRootItems.push(newItem);
    vi.advanceTimersByTime(1000); // Reset throttle state by aging the last reload
    await simulateExternalEvent({ type: 'chat_meta_and_chat_group' });

    vi.advanceTimersByTime(600);
    await nextTick();
    await Promise.resolve();
    expect(rootItems.value.length).toBe(1);
  });

  it('should reload chat content when updated in another tab (if not generating)', async () => {
    const { createNewChat, currentChat } = chatStore;
    const chat = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const chatId = chat!.id;
    const updatedChat = JSON.parse(JSON.stringify(chat));
    updatedChat.root.items.push({ id: 'msg-ext', role: 'user', content: 'Ext', timestamp: Date.now(), replies: { items: [] } });
    mocks.mockChatStorage.set(idToRaw({ id: chatId }), updatedChat);
    await simulateExternalEvent({ type: 'chat_content', id: idToRaw({ id: chatId }) });

    vi.advanceTimersByTime(600);
    await nextTick();
    expect(currentChat.value?.root.items.length).toBe(1);
  });

  it('should NOT reload chat content if we are currently generating for it', async () => {
    const { createNewChat, currentChat, TEST_ONLY } = chatStore;
    const { activeGenerations } = TEST_ONLY;
    const chat = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const chatId = chat!.id;
    activeGenerations.set(chatId, { controller: new AbortController(), chat: chat as any });
    const updatedChat = JSON.parse(JSON.stringify(chat));
    updatedChat.root.items.push({ id: 'msg-ext', role: 'user', content: 'Ext', timestamp: Date.now(), replies: { items: [] } });
    mocks.mockChatStorage.set(idToRaw({ id: chatId }), updatedChat);
    await simulateExternalEvent({ type: 'chat_content', id: idToRaw({ id: chatId }) });

    vi.advanceTimersByTime(600);
    await nextTick();
    expect(currentChat.value?.root.items.length).toBe(0);
    activeGenerations.delete(chatId);
  });

  it('should update metadata but preserve local messages during background generation', async () => {
    const { createNewChat, currentChat, TEST_ONLY } = chatStore;
    const { activeGenerations } = TEST_ONLY;
    const chat = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const chatId = chat!.id;
    activeGenerations.set(chatId, { controller: new AbortController(), chat: chat as any });
    const updatedChat = JSON.parse(JSON.stringify(chat));
    updatedChat.title = 'External Title';
    mocks.mockChatStorage.set(idToRaw({ id: chatId }), updatedChat);
    await simulateExternalEvent({ type: 'chat_meta_and_chat_group', id: idToRaw({ id: chatId }) });

    vi.advanceTimersByTime(600);
    await nextTick();
    expect(currentChat.value?.title).toBe('External Title');
    // Use toRaw to compare underlying instances since currentChat is a readonly proxy
    expect(toRaw(currentChat.value)).toBe(toRaw(chat));
    activeGenerations.delete(chatId);
  });

  it('should handle full migration event by reloading everything', async () => {
    const { createNewChat, currentChat, rootItems } = chatStore;
    await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    mocks.mockChatStorage.clear();
    mocks.mockRootItems.length = 0;
    const migratedChatSummary: ChatSummary = { id: toChatId({ raw: 'm1' }), title: 'M', updatedAt: Date.now(), groupId: null };
    mocks.mockRootItems.push({ id: 'chat:m1', type: 'chat', chat: migratedChatSummary });
    await simulateExternalEvent({ type: 'migration' });

    vi.advanceTimersByTime(600);
    await nextTick();
    expect(rootItems.value.length).toBe(1);
    expect(currentChat.value).toBeNull();
  });

  it('should maintain the latest group ID if moved externally while generating', async () => {
    const { createNewChat, TEST_ONLY, updateChatMeta } = chatStore;
    const { activeGenerations } = TEST_ONLY;
    const chat = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const chatId = chat!.id;
    activeGenerations.set(chatId, { controller: new AbortController(), chat: chat as any });

    // External tab moves chat to group-x
    mocks.mockRootItems.push({
      id: 'chat_group:group-x',
      type: 'chat_group',
      chatGroup: {
        id: toChatGroupId({ raw: 'group-x' }), name: 'X', isCollapsed: false, updatedAt: 0,
        items: [{ id: `chat:${idToRaw({ id: chatId })}`, type: 'chat', chat: { id: chatId, title: 'T', updatedAt: 0, groupId: toChatGroupId({ raw: 'group-x' }) } }],
      },
    });

    // Also update the meta in storage so loadChat returns the correct groupId
    const meta = mocks.mockChatStorage.get(idToRaw({ id: chatId }));
    if (meta) meta.groupId = toChatGroupId({ raw: 'group-x' });

    vi.advanceTimersByTime(1000);
    await simulateExternalEvent({ type: 'chat_meta_and_chat_group', id: idToRaw({ id: chatId }) });
    vi.advanceTimersByTime(1000);
    await nextTick();
    await Promise.resolve();
    await nextTick();
    await Promise.resolve();

    expect(chatStore.currentChat.value?.groupId).toBe(toChatGroupId({ raw: 'group-x' }));
    await (updateChatMeta as any)({ id: idToRaw({ id: chatId }), updater: () => chat as any });
    expect(mocks.mockChatStorage.get(idToRaw({ id: chatId }))?.groupId).toBe(toChatGroupId({ raw: 'group-x' }));
    activeGenerations.delete(chatId);
  });

  it('should maintain group ID if hierarchy changed externally without specific chat ID', async () => {
    const { createNewChat, TEST_ONLY, updateChatMeta } = chatStore;
    const { activeGenerations } = TEST_ONLY;
    const chat = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const chatId = chat!.id;
    activeGenerations.set(chatId, { controller: new AbortController(), chat: chatStore.currentChat.value! as any });
    mocks.mockRootItems.length = 0;
    mocks.mockRootItems.push({ id: 'chat_group:ge', type: 'chat_group', chatGroup: { id: toChatGroupId({ raw: 'ge' }), name: 'E', items: [{ id: `chat:${idToRaw({ id: chatId })}`, type: 'chat', chat: { id: chatId, title: 'C', updatedAt: 0, groupId: toChatGroupId({ raw: 'ge' }) } }], isCollapsed: false, updatedAt: 0 } });

    const meta = mocks.mockChatStorage.get(idToRaw({ id: chatId }));
    if (meta) meta.groupId = toChatGroupId({ raw: 'ge' });

    vi.advanceTimersByTime(2000);
    await simulateExternalEvent({ type: 'chat_meta_and_chat_group', id: idToRaw({ id: chatId }) });

    vi.advanceTimersByTime(2000);
    await nextTick();
    await Promise.resolve();
    await nextTick();
    await Promise.resolve();
    await nextTick();
    await Promise.resolve();

    expect(chatStore.currentChat.value?.groupId).toBe(toChatGroupId({ raw: 'ge' }));
    await (updateChatMeta as any)({ id: idToRaw({ id: chatId }), updater: () => chatStore.currentChat.value! as any });
    expect(mocks.mockChatStorage.get(idToRaw({ id: chatId }))?.groupId).toBe(toChatGroupId({ raw: 'ge' }));
    activeGenerations.delete(chatId);
  });

  it('should update current group view when renamed in another tab', async () => {
    const { createChatGroup, currentChatGroup, TEST_ONLY } = chatStore;
    const { __testOnlySetCurrentChatGroup } = TEST_ONLY;
    const groupId = await createChatGroup({ name: 'Old' });
    const group = Array.from(mocks.mockGroupStorage.values())[0];
    __testOnlySetCurrentChatGroup({ group: reactive(group) });
    const renamed = { ...group, name: 'New' };
    mocks.mockGroupStorage.set(idToRaw({ id: groupId }), renamed);
    await simulateExternalEvent({ type: 'chat_meta_and_chat_group', id: idToRaw({ id: groupId }) });

    vi.advanceTimersByTime(600);
    await nextTick();
    expect(currentChatGroup.value?.name).toBe('New');
  });

  it('should abort active generations when a migration occurs', async () => {
    const { createNewChat, TEST_ONLY } = chatStore;
    const { activeGenerations } = TEST_ONLY;
    const chat = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const chatId = chat!.id;
    const controller = new AbortController();
    const abortSpy = vi.spyOn(controller, 'abort');
    activeGenerations.set(chatId, { controller, chat: chat as any });
    await simulateExternalEvent({ type: 'migration' });

    vi.advanceTimersByTime(600);
    await nextTick();
    expect(abortSpy).toHaveBeenCalled();
    expect(activeGenerations.size).toBe(0);
  });
});
