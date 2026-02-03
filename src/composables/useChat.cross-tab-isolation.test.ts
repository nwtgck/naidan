import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { nextTick } from 'vue';

// --- Shared State across "tabs" (modules) ---
const STORAGE_KEY = '__CROSS_TAB_TEST_STORAGE__';
const shared = globalThis as any;

function resetSharedStorage() {
  shared[STORAGE_KEY] = {
    chats: new Map(),
    groups: new Map(),
    settings: { endpointType: 'openai', endpointUrl: 'http://localhost', autoTitleEnabled: false, defaultModelId: 'gpt-4' },
    hierarchy: { items: [] },
    listeners: new Set(),
  };
}

if (!shared[STORAGE_KEY]) resetSharedStorage();
const getShared = () => shared[STORAGE_KEY];

// --- Mock BroadcastChannel to bridge the "tabs" ---
class MockBroadcastChannel {
  name: string;
  onmessage: ((ev: any) => void) | null = null;
  static instances = new Set<MockBroadcastChannel>();

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.add(this);
  }

  postMessage(data: any) {
    // Simulate async delivery to other instances
    setTimeout(() => {
      MockBroadcastChannel.instances.forEach(inst => {
        if (inst !== this && inst.name === this.name) {
          inst.onmessage?.({ data } as MessageEvent);
        }
      });
    }, 0);
  }

  close() {
    MockBroadcastChannel.instances.delete(this);
  }
}

describe('useChat Comprehensive Cross-Tab Sync', () => {
  beforeEach(() => {
    resetSharedStorage();
    MockBroadcastChannel.instances.clear();
    // Safely stub BroadcastChannel for this test suite
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  afterAll(() => {
    delete shared[STORAGE_KEY];
  });

  async function createTab() {
    vi.resetModules();
    
    vi.mock('../services/storage', () => ({
      storageService: {
        init: vi.fn(),
        subscribeToChanges: vi.fn().mockImplementation((l) => {
          getShared().listeners.add(l);
          return () => getShared().listeners.delete(l);
        }),
        getSidebarStructure: vi.fn().mockImplementation(async () => {
          const s = getShared();
          return s.hierarchy.items.map((node: any) => {
            if (node.type === 'chat') {
              const chat = s.chats.get(node.id);
              return { id: `chat:${node.id}`, type: 'chat', chat: { id: node.id, title: chat?.title || null, updatedAt: chat?.updatedAt || 0, groupId: chat?.groupId || null } };
            }
            if (node.type === 'chat_group') {
              const group = s.groups.get(node.id);
              return { 
                id: `chat_group:${node.id}`, type: 'chat_group', 
                chatGroup: { 
                  ...group, 
                  items: (node.chat_ids || []).map((cid: string) => {
                    const c = s.chats.get(cid);
                    return { id: `chat:${cid}`, type: 'chat', chat: { id: cid, title: c?.title || null, updatedAt: c?.updatedAt || 0, groupId: node.id } };
                  })
                } 
              };
            }
            return node;
          });
        }),
        loadChat: vi.fn().mockImplementation(async (id) => {
          const c = getShared().chats.get(id);
          return c ? JSON.parse(JSON.stringify(c)) : null;
        }),
        loadSettings: vi.fn().mockImplementation(async () => JSON.parse(JSON.stringify(getShared().settings))),
        listChatGroups: vi.fn().mockImplementation(async () => Array.from(getShared().groups.values()).map(g => JSON.parse(JSON.stringify(g)))),
        updateChatMeta: vi.fn().mockImplementation(async (id, updater) => {
          const s = getShared();
          const current = s.chats.get(id);
          const updatedMeta = await updater(current ? JSON.parse(JSON.stringify(current)) : null);
          if (current) s.chats.set(id, { ...current, ...updatedMeta });
          else s.chats.set(id, { id, ...updatedMeta });
          s.listeners.forEach((l: any) => l({ type: 'chat_meta_and_chat_group', id, timestamp: Date.now() }));
        }),
        updateHierarchy: vi.fn().mockImplementation(async (updater) => {
          const s = getShared();
          s.hierarchy = await updater(JSON.parse(JSON.stringify(s.hierarchy)));
          s.listeners.forEach((l: any) => l({ type: 'chat_meta_and_chat_group', timestamp: Date.now() }));
        }),
        updateChatContent: vi.fn().mockImplementation(async (id, updater) => {
          const s = getShared();
          const current = s.chats.get(id);
          const existingContent = current ? { root: current.root, currentLeafId: current.currentLeafId } : { root: { items: [] } };
          const updatedContent = await updater(JSON.parse(JSON.stringify(existingContent)));
          if (current) s.chats.set(id, { ...current, ...updatedContent });
          else s.chats.set(id, { id, ...updatedContent });
          s.listeners.forEach((l: any) => l({ type: 'chat_content', id, timestamp: Date.now() }));
        }),
        updateChatGroup: vi.fn().mockImplementation(async (id, updater) => {
          const s = getShared();
          const current = s.groups.get(id);
          const updated = await updater(current ? JSON.parse(JSON.stringify(current)) : null);
          s.groups.set(id, JSON.parse(JSON.stringify(updated)));
          s.listeners.forEach((l: any) => l({ type: 'chat_meta_and_chat_group', id, timestamp: Date.now() }));
        }),
        updateSettings: vi.fn().mockImplementation(async (updater) => {
          const s = getShared();
          s.settings = await updater(JSON.parse(JSON.stringify(s.settings)));
          s.listeners.forEach((l: any) => l({ type: 'settings', timestamp: Date.now() }));
        }),
        deleteChat: vi.fn().mockImplementation(async (id) => {
          const s = getShared();
          s.chats.delete(id);
          s.listeners.forEach((l: any) => l({ type: 'chat_meta_and_chat_group', id, timestamp: Date.now() }));
        }),
        clearAll: vi.fn().mockImplementation(async () => {
          const s = getShared();
          s.chats.clear();
          s.groups.clear();
          s.hierarchy = { items: [] };
          s.listeners.forEach((l: any) => l({ type: 'migration', timestamp: Date.now() }));
        }),
        notify: vi.fn().mockImplementation((event) => {
          // Immediately notify all listeners in all simulated tabs
          getShared().listeners.forEach((l: any) => l(event));
        }),
      }
    }));

    vi.mock('./useSettings', () => ({
      useSettings: () => ({
        settings: { value: JSON.parse(JSON.stringify(getShared().settings)) },
        setIsOnboardingDismissed: vi.fn(),
        setOnboardingDraft: vi.fn(),
        setHeavyContentAlertDismissed: vi.fn(),
      }),
    }));
    vi.mock('./useToast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
    vi.mock('./useConfirm', () => ({ useConfirm: () => ({ showConfirm: vi.fn().mockResolvedValue(true) }) }));
    
    vi.mock('../services/llm', () => {
      return {
        OpenAIProvider: function() {
          return {
            chat: vi.fn().mockImplementation(async (params: { onChunk: (c: string) => void, signal?: AbortSignal }) => {
              const { onChunk, signal } = params;
              await Promise.resolve();
              // Generate enough chunks for state verification but not so many that it times out
              for (let i = 0; i < 10; i++) {
                if (signal?.aborted) {
                  const err = new Error('Aborted');
                  err.name = 'AbortError';
                  throw err;
                }
                onChunk(`chunk ${i}`);
                await new Promise(r => setTimeout(r, 100));
              }
            }),
            listModels: vi.fn().mockResolvedValue(['gpt-4'])
          };
        },
        OllamaProvider: function() {
          return { chat: vi.fn(), listModels: vi.fn() }; 
        },
      };
    });

    const { useChat } = await import('./useChat');
    const store = useChat();
    await store.loadChats();
    return store;
  }

  it('should sync title changes (chat_meta_and_chat_group)', async () => {
    const tabA = await createTab();
    const tabB = await createTab();
    const chat = await tabA.createNewChat({ groupId: undefined, modelId: 'gpt-4', systemPrompt: undefined });
    vi.advanceTimersByTime(600);
    await tabB.openChat(chat!.id);
    await tabA.renameChat(chat!.id, 'New Title');
    vi.advanceTimersByTime(600);
    await nextTick();
    expect(tabB.currentChat.value?.title).toBe('New Title');
  });

  it('should sync sidebar reordering (chat_meta_and_chat_group)', async () => {
    const tabA = await createTab();
    const tabB = await createTab();
    const chat = await tabA.createNewChat({ groupId: undefined, modelId: 'gpt-4', systemPrompt: undefined });
    vi.advanceTimersByTime(600);
    await nextTick();
    expect(tabB.rootItems.value.length).toBe(1);

    const groupId = await tabA.createChatGroup('Group');
    await tabA.moveChatToGroup(chat!.id, groupId);
    vi.advanceTimersByTime(600);
    await nextTick();

    const groupItem = tabB.rootItems.value[0];
    if (groupItem && groupItem.type === 'chat_group') {
      expect(groupItem.chatGroup.items.length).toBe(1);
    } else {
      throw new Error('Expected chat_group at index 0');
    }
  });

  it('should sync message additions (chat_content)', async () => {
    const tabA = await createTab();
    const tabB = await createTab();
    const chat = await tabA.createNewChat({ groupId: undefined, modelId: 'gpt-4', systemPrompt: undefined });
    vi.advanceTimersByTime(600);
    await tabB.openChat(chat!.id);

    const p = tabA.sendMessage('Hello');
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    
    vi.advanceTimersByTime(600);
    await nextTick();

    expect(tabB.activeMessages.value.length).toBe(2);
    expect(tabB.activeMessages.value[0]?.content).toBe('Hello');
  });

  it('should reload sidebar when settings change (settings event)', async () => {
    await createTab();
    await createTab();
    const { storageService } = await import('../services/storage');
    await storageService.updateSettings((curr: any) => ({ ...curr, someNewSetting: true }));
    vi.advanceTimersByTime(600);
    await nextTick();
    expect(vi.mocked(storageService.getSidebarStructure)).toHaveBeenCalled();
  });

  it('should clear everything and close chat on migration event', async () => {
    const tabA = await createTab();
    const tabB = await createTab();
    const chat = await tabA.createNewChat({ groupId: undefined, modelId: 'gpt-4', systemPrompt: undefined });
    vi.advanceTimersByTime(600);
    await tabB.openChat(chat!.id);
    expect(tabB.currentChat.value).not.toBeNull();

    const { storageService } = await import('../services/storage');
    await storageService.clearAll();
    vi.advanceTimersByTime(600);
    await nextTick();

    expect(tabB.currentChat.value).toBeNull();
    expect(tabB.rootItems.value.length).toBe(0);
  });

  it('should allow Tab B to see streaming content and abort generation from Tab A', async () => {
    const tabA = await createTab();
    const tabB = await createTab();
    
    const chat = await tabA.createNewChat({ groupId: undefined, modelId: 'gpt-4', systemPrompt: undefined });
    vi.advanceTimersByTime(600);
    await tabB.openChat(chat!.id);
    
    // 1. Tab A starts sending a message
    const sendPromise = tabA.sendMessage('Slow msg');
    
    await vi.advanceTimersByTimeAsync(10);
    await nextTick();

    // 2. Tab B should now see 'streaming' as true
    expect(tabB.streaming.value).toBe(true);

    // 3. Tab B requests an abort
    tabB.abortChat();
    
    await vi.advanceTimersByTimeAsync(1000);
    await sendPromise;
    
    // 4. Verification: Both stopped
    expect(tabA.streaming.value).toBe(false);
    expect(tabB.streaming.value).toBe(false);
    
    expect(tabA.activeMessages.value[1]?.content).toContain('[Generation Aborted]');
  });

  it('should sync generation state for multiple chats across tabs and support remote abort', async () => {
    const tab1 = await createTab();
    const tab2 = await createTab();
    
    // 1. Setup two chats
    const chat1 = await tab1.createNewChat({ groupId: undefined, modelId: 'gpt-4', systemPrompt: undefined });
    const chat2 = await tab2.createNewChat({ groupId: undefined, modelId: 'gpt-4', systemPrompt: undefined });
    vi.advanceTimersByTime(600);

    // 2. Both tabs open both chats (in reality they see them in sidebar)
    // We'll verify sidebar state via isTaskRunning
    
    // 3. Start generation for chat1 in tab1
    const p1 = tab1.sendMessage('Msg 1');
    await vi.advanceTimersByTimeAsync(10);
    await nextTick();

    // Verify both tabs see chat1 as running
    expect(tab1.isTaskRunning(chat1!.id)).toBe(true);
    expect(tab2.isTaskRunning(chat1!.id)).toBe(true);

    // 4. Start generation for chat2 in tab2
    const p2 = tab2.sendMessage('Msg 2');
    await vi.advanceTimersByTimeAsync(10);
    await nextTick();

    // Verify both tabs see BOTH chats as running
    expect(tab1.isTaskRunning(chat1!.id)).toBe(true);
    expect(tab1.isTaskRunning(chat2!.id)).toBe(true);
    expect(tab2.isTaskRunning(chat1!.id)).toBe(true);
    expect(tab2.isTaskRunning(chat2!.id)).toBe(true);

    // 5. Tab 1 requests abort for chat2 (which is running in Tab 2)
    tab1.abortChat(chat2!.id);
    await vi.advanceTimersByTimeAsync(200);
    await p2;

    // Verify chat2 stopped everywhere, but chat1 is still running
    expect(tab1.isTaskRunning(chat2!.id)).toBe(false);
    expect(tab2.isTaskRunning(chat2!.id)).toBe(false);
    expect(tab1.isTaskRunning(chat1!.id)).toBe(true);
    expect(tab2.isTaskRunning(chat1!.id)).toBe(true);

    // Cleanup p1
    tab1.abortChat(chat1!.id);
    await vi.advanceTimersByTimeAsync(200);
    await p1;
  });
});
