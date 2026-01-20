import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { nextTick } from 'vue';

// --- Shared State across "tabs" (modules) ---
// Using a string key because Symbols are recreated on module reload.
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

class MockBroadcastChannel {
  name: string;
  onmessage: ((ev: any) => void) | null = null;
  static instances = new Set<MockBroadcastChannel>();
  constructor(name: string) { this.name = name; MockBroadcastChannel.instances.add(this); }
  postMessage(data: any) {
    setTimeout(() => {
      MockBroadcastChannel.instances.forEach(inst => {
        if (inst !== this && inst.name === this.name) {
          inst.onmessage?.({ data } as MessageEvent);
        }
      });
    }, 0);
  }
  close() { MockBroadcastChannel.instances.delete(this); }
}

describe('useChat Comprehensive Cross-Tab Sync', () => {
  beforeEach(() => {
    resetSharedStorage();
    MockBroadcastChannel.instances.clear();
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  afterAll(() => { delete shared[STORAGE_KEY]; });

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
          if (current) {
            s.chats.set(id, { ...current, ...updatedMeta });
          } else {
            s.chats.set(id, { id, ...updatedMeta });
          }
          s.listeners.forEach((l: any) => l({ type: 'chat_meta_and_chat_group', id }));
        }),
        updateHierarchy: vi.fn().mockImplementation(async (updater) => {
          const s = getShared();
          s.hierarchy = await updater(JSON.parse(JSON.stringify(s.hierarchy)));
          s.listeners.forEach((l: any) => l({ type: 'chat_meta_and_chat_group' }));
        }),
        updateChatContent: vi.fn().mockImplementation(async (id, updater) => {
          const s = getShared();
          const current = s.chats.get(id);
          const existingContent = current ? { root: current.root, currentLeafId: current.currentLeafId } : { root: { items: [] } };
          const updatedContent = await updater(JSON.parse(JSON.stringify(existingContent)));
          if (current) {
            s.chats.set(id, { ...current, ...updatedContent });
          } else {
            s.chats.set(id, { id, ...updatedContent });
          }
          s.listeners.forEach((l: any) => l({ type: 'chat_content', id }));
        }),
        updateChatGroup: vi.fn().mockImplementation(async (id, updater) => {
          const s = getShared();
          const current = s.groups.get(id);
          const updated = await updater(current ? JSON.parse(JSON.stringify(current)) : null);
          s.groups.set(id, JSON.parse(JSON.stringify(updated)));
          s.listeners.forEach((l: any) => l({ type: 'chat_meta_and_chat_group', id }));
        }),
        updateSettings: vi.fn().mockImplementation(async (updater) => {
          const s = getShared();
          s.settings = await updater(JSON.parse(JSON.stringify(s.settings)));
          s.listeners.forEach((l: any) => l({ type: 'settings' }));
        }),
        deleteChat: vi.fn().mockImplementation(async (id) => {
          const s = getShared();
          s.chats.delete(id);
          s.listeners.forEach((l: any) => l({ type: 'chat_meta_and_chat_group', id }));
        }),
        clearAll: vi.fn().mockImplementation(async () => {
          const s = getShared();
          s.chats.clear();
          s.groups.clear();
          s.hierarchy = { items: [] };
          s.listeners.forEach((l: any) => l({ type: 'migration' }));
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
    vi.mock('../services/llm', () => ({
      OpenAIProvider: function() { return { chat: vi.fn().mockImplementation((_m, _mo, _u, onChunk) => onChunk('OK')), listModels: vi.fn().mockResolvedValue(['gpt-4']) }; },
      OllamaProvider: function() { return { chat: vi.fn(), listModels: vi.fn() }; },
    }));

    const { useChat } = await import('./useChat');
    const store = useChat();
    await store.loadChats();
    return store;
  }

  it('should sync title changes (chat_meta_and_chat_group)', async () => {
    const tabA = await createTab();
    const tabB = await createTab();
    const chat = await tabA.createNewChat(null, 'gpt-4');
    vi.advanceTimersByTime(300);
    await tabB.openChat(chat!.id);
    await tabA.renameChat(chat!.id, 'New Title');
    vi.advanceTimersByTime(300);
    await nextTick();
    expect(tabB.currentChat.value?.title).toBe('New Title');
  });

  it('should sync sidebar reordering (chat_meta_and_chat_group)', async () => {
    const tabA = await createTab();
    const tabB = await createTab();
    const chat = await tabA.createNewChat(null, 'gpt-4');
    vi.advanceTimersByTime(300);
    await nextTick();
    expect(tabB.rootItems.value.length).toBe(1);

    const groupId = await tabA.createChatGroup('Group');
    await tabA.moveChatToGroup(chat!.id, groupId);
    vi.advanceTimersByTime(300);
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
    const chat = await tabA.createNewChat(null, 'gpt-4');
    vi.advanceTimersByTime(300);
    await tabB.openChat(chat!.id);

    await tabA.sendMessage('Hello from Tab A');
    vi.advanceTimersByTime(300);
    await nextTick();

    expect(tabB.activeMessages.value.length).toBe(2);
    expect(tabB.activeMessages.value[0]?.content).toBe('Hello from Tab A');
  });

  it('should reload sidebar when settings change (settings event)', async () => {
    await createTab();
    await createTab();
    const { storageService } = await import('../services/storage');
    await storageService.updateSettings((curr: any) => ({ ...curr, someNewSetting: true }));
    vi.advanceTimersByTime(300);
    await nextTick();
    expect(vi.mocked(storageService.getSidebarStructure)).toHaveBeenCalled();
  });

  it('should clear everything and close chat on migration event', async () => {
    const tabA = await createTab();
    const tabB = await createTab();
    const chat = await tabA.createNewChat(null, 'gpt-4');
    vi.advanceTimersByTime(300);
    await tabB.openChat(chat!.id);
    expect(tabB.currentChat.value).not.toBeNull();

    const { storageService } = await import('../services/storage');
    await storageService.clearAll();
    vi.advanceTimersByTime(300);
    await nextTick();

    expect(tabB.currentChat.value).toBeNull();
    expect(tabB.rootItems.value.length).toBe(0);
  });

  it('should allow Tab B to see streaming content from Tab A (chat_content sync)', async () => {
    const tabA = await createTab();
    const tabB = await createTab();
    
    const chat = await tabA.createNewChat(null, 'gpt-4');
    vi.advanceTimersByTime(300);
    await tabB.openChat(chat!.id);
    
    // Simulate Tab A appending chunks to a message
    const { storageService } = await import('../services/storage');
    
    // 1. Initial message node
    await storageService.updateChatContent(chat!.id, (curr: any) => {
      curr.root.items.push({ id: 'msg-1', role: 'assistant', content: 'He', timestamp: Date.now(), replies: { items: [] } });
      curr.currentLeafId = 'msg-1';
      return curr;
    });

    vi.advanceTimersByTime(300);
    await nextTick();
    expect(tabB.activeMessages.value[0]?.content).toBe('He');

    // 2. Append chunk
    await storageService.updateChatContent(chat!.id, (curr: any) => {
      curr.root.items[0].content += 'llo';
      return curr;
    });

    vi.advanceTimersByTime(300);
    await nextTick();
    
    // Tab B should have updated content even though it's not the one generating
    expect(tabB.activeMessages.value[0]?.content).toBe('Hello');
  });
});
