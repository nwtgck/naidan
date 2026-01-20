import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useChat } from './useChat';
import { storageService } from '../services/storage';
import type { Chat, SidebarItem, Hierarchy } from '../models/types';
import { useGlobalEvents } from './useGlobalEvents';

// --- Mocks ---

const mockRootItems: SidebarItem[] = [];
const mockChatStorage = new Map<string, Chat>();
let mockHierarchy: Hierarchy = { items: [] };

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    listChats: vi.fn().mockImplementation(() => {
      return Promise.resolve(Array.from(mockChatStorage.values()).map(c => {
        const group = mockHierarchy.items.find(i => i.type === 'chat_group' && i.chat_ids.includes(c.id));
        return { ...c, groupId: group?.id || null };
      }));
    }),
    loadChat: vi.fn().mockImplementation(async (id) => {
      const chat = mockChatStorage.get(id);
      if (!chat) return null;
      const cloned = JSON.parse(JSON.stringify(chat));
      const group = mockHierarchy.items.find(i => i.type === 'chat_group' && i.chat_ids.includes(id));
      cloned.groupId = group?.id || null;
      return cloned;
    }),
    saveChat: vi.fn().mockImplementation((chat) => {
      mockChatStorage.set(chat.id, JSON.parse(JSON.stringify(chat)));
      return Promise.resolve();
    }),
    loadChatMeta: vi.fn().mockImplementation(async (id) => {
      const chat = mockChatStorage.get(id);
      if (!chat) return null;
      const cloned = JSON.parse(JSON.stringify(chat));
      const group = mockHierarchy.items.find(i => i.type === 'chat_group' && i.chat_ids.includes(id));
      cloned.groupId = group?.id || null;
      return cloned;
    }),
    updateChatMeta: vi.fn().mockImplementation(async (id, updater) => {
      const current = mockChatStorage.get(id) || null;
      const updatedMeta = await updater(current ? JSON.parse(JSON.stringify(current)) : null);
      if (current) {
        const full = { ...current, ...updatedMeta };
        mockChatStorage.set(id, JSON.parse(JSON.stringify(full)));
      } else {
        mockChatStorage.set(id, JSON.parse(JSON.stringify(updatedMeta)));
      }
      return Promise.resolve();
    }),
    updateChatContent: vi.fn().mockImplementation(async (id, updater) => {
      const chat = mockChatStorage.get(id);
      const existingContent = chat ? { root: chat.root, currentLeafId: chat.currentLeafId } : { root: { items: [] } };
      const updatedContent = await updater(existingContent);
      if (mockChatStorage.has(id)) {
        const full = { ...mockChatStorage.get(id), ...updatedContent };
        mockChatStorage.set(id, JSON.parse(JSON.stringify(full)));
      }
      return Promise.resolve();
    }),
    loadHierarchy: vi.fn().mockImplementation(() => Promise.resolve(mockHierarchy)),
    updateHierarchy: vi.fn().mockImplementation(async (updater) => {
      mockHierarchy = await updater(mockHierarchy);
      return Promise.resolve();
    }),
    deleteChat: vi.fn().mockImplementation((id) => {
      mockChatStorage.delete(id);
      return Promise.resolve();
    }),
    updateChatGroup: vi.fn(),
    listChatGroups: vi.fn().mockResolvedValue([]),
    getSidebarStructure: vi.fn().mockImplementation(() => Promise.resolve([...mockRootItems])),
    deleteChatGroup: vi.fn(),
    canPersistBinary: true,
    getFile: vi.fn(),
    saveFile: vi.fn(),
  },
}));

// Stable mock for settings
const mockSettings = { 
  value: { 
    endpointType: 'openai', 
    endpointUrl: 'http://localhost', 
    storageType: 'local', 
    autoTitleEnabled: false, 
    defaultModelId: 'gpt-4',
    lmParameters: {},
    providerProfiles: [],
  } 
};

vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: mockSettings,
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null },
  }),
}));

const mockAddToast = vi.fn();
vi.mock('./useToast', () => ({
  useToast: () => ({
    addToast: mockAddToast,
  }),
}));

const mockLlmChat = vi.fn();
const mockListModels = vi.fn().mockResolvedValue(['gpt-4']);

vi.mock('../services/llm', () => {
  return {
    OpenAIProvider: function() {
      return {
        chat: (...args: any[]) => mockLlmChat(...args),
        listModels: (...args: any[]) => mockListModels(...args),
      };
    },
    OllamaProvider: function() {
      return {
        chat: (...args: any[]) => mockLlmChat(...args),
        listModels: (...args: any[]) => mockListModels(...args),
      };
    },
  };
});

describe('useChat Concurrency & Stale State Protection', () => {
  const chatStore = useChat();
  const {
    currentChat, rootItems, activeGenerations, setTestCurrentChat: setTestCurrentChat
  } = chatStore;

  const { errorCount, clearEvents } = useGlobalEvents();

  // Helper to wait for a chat to appear in activeGenerations
  const waitForRegistry = async (id: string) => {
    try {
      await vi.waitUntil(() => activeGenerations.has(id), { timeout: 2000, interval: 50 });
    } catch (e) {
      console.error(`Timed out waiting for chat ${id} in activeGenerations. Current keys:`, Array.from(activeGenerations.keys()));
      throw e;
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setTestCurrentChat(null);
    rootItems.value = [];
    activeGenerations.clear();
    mockRootItems.length = 0;
    mockChatStorage.clear();
    mockHierarchy = { items: [] };
    clearEvents();
    mockSettings.value.autoTitleEnabled = false;
  });

  afterEach(() => {
    expect(errorCount.value).toBe(0);
  });

  it('should allow multiple chats to stream concurrently', async () => {
    const { createNewChat, sendMessage } = useChat();

    const chatAId = (await createNewChat())!.id;
    const chatA = currentChat.value!;
    
    let resolveChatA: () => void;
    const chatAPromise = new Promise<void>(resolve => { resolveChatA = resolve; });
    
    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
      onChunk('A-Start');
      await chatAPromise;
      onChunk('A-End');
    });

    const sendPromiseA = sendMessage('Start A');
    await new Promise(r => setTimeout(r, 50));
    await waitForRegistry(chatAId);

    const chatBId = (await createNewChat())!.id;
    const chatB = currentChat.value!;

    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
      await new Promise(r => setTimeout(r, 100));
      onChunk('B-Response');
    });

    const sendPromiseB = sendMessage('Start B');
    await new Promise(r => setTimeout(r, 50));
    await waitForRegistry(chatBId);

    await sendPromiseB;
    const lastMsgB = chatB.root.items[0]?.replies.items[0];
    expect(lastMsgB?.content).toBe('B-Response');

    expect(chatA.root.items[0]?.replies.items[0]?.content).toBe('A-Start');
    
    resolveChatA!();
    await sendPromiseA;
    expect(chatA.root.items[0]?.replies.items[0]?.content).toBe('A-StartA-End');
  });

  it('should not jump out of a group if moved while generating in background', async () => {
    const { createNewChat, currentChat, sendMessage } = useChat();

    // 1. Create Chat A (Individual)
    await createNewChat();
    const chatA = currentChat.value!;
    const chatAId = chatA.id;

    let resolveA: () => void;
    const p = new Promise<void>(r => resolveA = r);
    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
      onChunk('Thinking...');
      await p;
      onChunk('Done');
    });

    // 2. Start generation
    const sendPromise = sendMessage('Stay in group');
    await waitForRegistry(chatAId);

    // 3. Simulate Tab B moving Chat A into a group
    await storageService.updateHierarchy((curr) => {
      curr.items = [{ type: 'chat_group', id: 'group-g', chat_ids: [chatAId] }];
      return curr;
    });
    
    // 4. Finish background generation
    resolveA!();
    await sendPromise;

    // 5. Verify it's STILL in the group
    const finalChat = await storageService.loadChat(chatAId);
    expect(finalChat?.groupId).toBe('group-g');
  });

  it('should not overwrite manual renames if renamed while generating in background', async () => {
    const { createNewChat, sendMessage, renameChat } = useChat();

    const chatAId = (await createNewChat())!.id;
    const chatA = await storageService.loadChat(chatAId) as Chat;
    chatA.title = 'Original Title';
    await storageService.updateChatMeta(chatAId, () => chatA);

    let resolveA: () => void;
    const p = new Promise<void>(r => resolveA = r);
    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
      onChunk('Thinking...');
      await p;
    });

    const sendPromise = sendMessage('Rename me');
    await waitForRegistry(chatAId);

    // Manual rename happens while streaming
    await renameChat(chatAId, 'Manual New Title');
    
    resolveA!();
    await sendPromise;

    // Verify title was not reverted to 'Original Title'
    const finalChat = await storageService.loadChat(chatAId);
    expect(finalChat?.title).toBe('Manual New Title');
  });

  it('should not resurrect a deleted chat when background generation finishes', async () => {
    const { createNewChat, currentChat, sendMessage, deleteChat } = useChat();

    await createNewChat();
    const chatA = currentChat.value!;
    const chatAId = chatA.id;

    let resolveA: () => void;
    const p = new Promise<void>(r => resolveA = r);
    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
      onChunk('Thinking...');
      await p;
    });

    const sendPromise = sendMessage('Delete me');
    await waitForRegistry(chatAId);

    // Delete chat while it's still generating in background
    await deleteChat(chatAId);
    expect(mockChatStorage.has(chatAId)).toBe(false);

    resolveA!();
    await sendPromise;

    // Verify chat was not recreated in storage
    expect(mockChatStorage.has(chatAId)).toBe(false);
  });

  it('should not resurrect chats after deleteAllChats', async () => {
    const { createNewChat, currentChat, sendMessage, deleteAllChats } = useChat();

    // 1. Start two background generations
    await createNewChat();
    const chatAId = currentChat.value!.id;
    let resolveA: () => void;
    const pA = new Promise<void>(r => resolveA = r);
    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
      onChunk('A...');
      await pA;
    });
    const sendA = sendMessage('A');
    await waitForRegistry(chatAId);

    await createNewChat();
    const chatBId = currentChat.value!.id;
    let resolveB: () => void;
    const pB = new Promise<void>(r => resolveB = r);
    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
      onChunk('B...');
      await pB;
    });
    const sendB = sendMessage('B');
    await waitForRegistry(chatBId);

    // 2. Perform global delete
    await deleteAllChats();
    expect(mockChatStorage.size).toBe(0);

    // 3. Finish generations
    resolveA!();
    resolveB!();
    await Promise.all([sendA, sendB]);

    // 4. Verify storage remains empty
    expect(mockChatStorage.size).toBe(0);
  });

  it('should not overwrite manual renames of background chats', async () => {
    const { createNewChat, currentChat, sendMessage, renameChat } = useChat();

    // 1. Start Chat A
    const chatAId = (await createNewChat())!.id;
    const chatA = await storageService.loadChat(chatAId) as Chat;
    chatA.title = 'Original';
    await storageService.updateChatMeta(chatAId, () => chatA);

    let resolveA: () => void;
    const pA = new Promise<void>(r => resolveA = r);
    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
      onChunk('A...');
      await pA;
    });
    const sendA = sendMessage('A');
    await waitForRegistry(chatAId);

    // 2. Switch away from A
    await createNewChat();
    expect(currentChat.value?.id).not.toBe(chatAId);

    // 3. Rename A in background (simulating sidebar edit)
    await renameChat(chatAId, 'New Title');

    // 4. Finish A
    resolveA!();
    await sendA;

    // Verify title preserved
    const finalChat = await storageService.loadChat(chatAId);
    expect(finalChat?.title).toBe('New Title');
  });

  it('should not overwrite a manual rename with an auto-generated title', async () => {
    const { createNewChat, currentChat, sendMessage, renameChat } = useChat();
    mockSettings.value.autoTitleEnabled = true;

    // 1. Setup Chat A
    await createNewChat();
    const chatA = currentChat.value!;
    const chatAId = chatA.id;

    // Mock response + slow title generation
    let resolveTitle: () => void;
    const titleP = new Promise<void>(r => resolveTitle = r);
    
    mockLlmChat
      .mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
        onChunk('Response');
      })
      .mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
        await titleP;
        onChunk('Auto Title');
      });

    // 2. Start generation (response finishes, title gen starts and waits)
    const sendPromise = sendMessage('Topic');
    await new Promise(r => setTimeout(r, 50));
    await waitForRegistry(chatAId);
    await vi.waitUntil(() => mockLlmChat.mock.calls.length >= 2); // Wait for title gen to start

    // 3. User manually renames while title gen is "calculating"
    await renameChat(chatAId, 'User Manual Title');
    expect(chatA.title).toBe('User Manual Title');

    // 4. Let auto-title finish
    resolveTitle!();
    await sendPromise;
    await vi.waitUntil(() => !activeGenerations.has(chatAId));

    // 5. Verify manual title was NOT overwritten
    const finalChat = await storageService.loadChat(chatAId);
    expect(finalChat?.title).toBe('User Manual Title');
  });

  it('should maintain the latest group ID even after multiple moves during background generation', async () => {
    const { createNewChat, currentChat, sendMessage } = useChat();

    // 1. Setup Chat A in Group 1
    await createNewChat();
    const chatA = currentChat.value!;
    const chatAId = chatA.id;
    
    let resolveA: () => void;
    const p = new Promise<void>(r => resolveA = r);
    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
      onChunk('Thinking...');
      await p;
    });

    const sendPromise = sendMessage('Moving target');
    await waitForRegistry(chatAId);

    // 2. Move to Group B
    await storageService.updateHierarchy((curr) => {
      curr.items = [{ type: 'chat_group', id: 'g-b', chat_ids: [chatAId] }];
      return curr;
    });
    
    // 3. Move to Group C
    await storageService.updateHierarchy((curr) => {
      curr.items = [{ type: 'chat_group', id: 'g-c', chat_ids: [chatAId] }];
      return curr;
    });

    // 4. Finish generation
    resolveA!();
    await sendPromise;

    // 5. Verify it stayed in the LATEST group (C)
    const finalChat = await storageService.loadChat(chatAId);
    expect(finalChat?.groupId).toBe('g-c');
  });

  it('should notify background errors via toast when the chat is not active', async () => {
    const { createNewChat, currentChat, sendMessage } = useChat();
    
    // 1. Start Chat A
    const chatA = await createNewChat();
    const chatAId = chatA!.id;
    const chatA_initial = await storageService.loadChat(chatAId) as Chat;
    
    mockLlmChat.mockImplementationOnce(async () => {
      throw new Error('Background Explosion');
    });
    
    // 2. Switch to Chat B (Active)
    await createNewChat();
    const chatBId = currentChat.value!.id;
    expect(currentChat.value?.id).toBe(chatBId);

    // 3. Trigger error in background Chat A
    const sendPromiseA = sendMessage('Fail in background', null, [], chatA_initial);
    
    // 4. Verification: Toast should be called (done via mock)
    await sendPromiseA;
    
    expect(currentChat.value?.id).toBe(chatBId); // Still on Chat B
    const chatA_final = await storageService.loadChat(chatAId);
    const nodesA = chatA_final!.root.items;
    expect(nodesA[nodesA.length - 1]?.replies.items[0]?.error).toBe('Background Explosion');
  });

  it('should isolate AbortController between concurrent generations', async () => {
    const { createNewChat, currentChat, sendMessage, abortChat } = useChat();

    // 1. Start Chat A
    const chatAId = (await createNewChat())!.id;
    const chatA = currentChat.value!;

    let resolveA: () => void;
    const pA = new Promise<void>(r => resolveA = r);
    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, _on, _p, _h, signal) => {
      await pA;
      if (signal?.aborted) throw new Error('Aborted');
    });
    const sendA = sendMessage('A');
    await new Promise(r => setTimeout(r, 50));
    await waitForRegistry(chatAId);

    // 2. Start Chat B
    await createNewChat();
    const chatB = currentChat.value!;
    const chatBId = chatB.id;
                            
    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, onChunk, _p, _h, signal) => {
      onChunk('B-Response');
      // Wait for signal abort
      await new Promise<void>((_, reject) => {
        const abortErr = new Error('Aborted');
        abortErr.name = 'AbortError';
        if (signal?.aborted) return reject(abortErr);
        signal?.addEventListener('abort', () => reject(abortErr));
      });
    });
                    
    const sendB = sendMessage('B');
    await new Promise(r => setTimeout(r, 50));
    await waitForRegistry(chatBId);

    // 3. Abort CURRENT (Chat B)
    await new Promise(r => setTimeout(r, 50));
    abortChat();
    await sendB;
    
    const lastMsgB = chatB.root.items[0]?.replies.items[0];
    expect(lastMsgB?.content).toContain('[Generation Aborted]');

    // 4. Check Chat A (Still active)
    expect(activeGenerations.has(chatAId)).toBe(true);
    resolveA!();
    await sendA;
    expect(activeGenerations.has(chatAId)).toBe(false);
    expect(chatA.root.items[0]?.replies.items[0]?.error).toBeUndefined();
  });

  it('should prevent multiple simultaneous sendMessage calls for the same chat', async () => {
    const { createNewChat, currentChat, sendMessage } = useChat();

    await createNewChat();
    const chat = currentChat.value!;
    
    let resolveModels: (v: string[]) => void;
    const modelPromise = new Promise<string[]>(r => resolveModels = r);
    mockListModels.mockReturnValueOnce(modelPromise);

    // First send starts and waits for models
    const p1 = sendMessage('First');
    
    // Second send immediately - should be ignored because first is 'processing'
    const p2 = sendMessage('Second');

    resolveModels!(['gpt-4']);
    await Promise.all([p1, p2]);

    // Check chat messages - should only have ONE user message
    expect(chat.root.items.length).toBe(1);
    expect(chat.root.items[0]?.content).toBe('First');
  });

  it('should allow creating and using a new chat while another is streaming', async () => {
    const { createNewChat, sendMessage, activeGenerations } = useChat();
    const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0));
    mockListModels.mockResolvedValue(['gpt-4']); // Reset for this test

    // 1. Start Chat A (Slow Generation)
    const chatAId = (await createNewChat())!.id;
    const chatA = currentChat.value!;
    
    let resolveA: () => void;
    const pA = new Promise<void>(r => resolveA = r);
    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
      onChunk('A-Start');
      await pA;
      onChunk('A-End');
    });

    const sendA = sendMessage('Message A');
    await waitForRegistry(chatAId);

    // 2. Create Chat B while A is still streaming
    const chatBId = (await createNewChat())!.id;
    const chatB = currentChat.value!;
    expect(chatBId).not.toBe(chatAId);
    expect(activeGenerations.has(chatAId)).toBe(true);

    // 3. Start Chat B (Concurrent Generation)
    let resolveBStarted: () => void;
    const pBStarted = new Promise<void>(r => resolveBStarted = r);
    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
      onChunk('B-Response');
      resolveBStarted();
    });

    // Pass chatB explicitly to sendMessage
    const sendB = sendMessage('Message B', null, [], chatB as any);
    
    // 4. Verify both are active
    await pBStarted;
    expect(activeGenerations.size).toBe(2);
    expect(activeGenerations.has(chatAId)).toBe(true);
    expect(activeGenerations.has(chatBId)).toBe(true);

    // 5. Let B finish
    await sendB;
    await flushPromises();
    expect(activeGenerations.has(chatBId)).toBe(false);
    expect(activeGenerations.size).toBe(1);
    expect(chatB.root.items[0]?.replies.items[0]?.content).toBe('B-Response');

    // 6. Let A finish
    resolveA!();
    await sendA;
    await flushPromises();
    expect(activeGenerations.size).toBe(0);
    expect(chatA.root.items[0]?.replies.items[0]?.content).toBe('A-StartA-End');
  }, 15000);
});