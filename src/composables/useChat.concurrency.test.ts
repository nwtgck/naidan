import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useChat } from './useChat';
import { storageService } from '../services/storage';
import type { Chat, SidebarItem } from '../models/types';
import { useGlobalEvents } from './useGlobalEvents';

// --- Mocks ---

const mockRootItems: SidebarItem[] = [];
const mockChatStorage = new Map<string, Chat>();

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    listChats: vi.fn().mockImplementation(() => Promise.resolve(Array.from(mockChatStorage.values()))),
    loadChat: vi.fn().mockImplementation((id) => Promise.resolve(mockChatStorage.get(id) || null)),
    saveChat: vi.fn().mockImplementation((chat) => {
      mockChatStorage.set(chat.id, JSON.parse(JSON.stringify(chat)));
      return Promise.resolve();
    }),
    deleteChat: vi.fn().mockImplementation((id) => {
      mockChatStorage.delete(id);
      return Promise.resolve();
    }),
    saveChatGroup: vi.fn(),
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

const mockLlmChat = vi.fn();

vi.mock('../services/llm', () => {
  return {
    OpenAIProvider: function() {
      return {
        chat: mockLlmChat,
        listModels: vi.fn().mockResolvedValue(['gpt-4']),
      };
    },
    OllamaProvider: function() {
      return {
        chat: mockLlmChat,
        listModels: vi.fn().mockResolvedValue(['gpt-4']),
      };
    },
  };
});

describe('useChat Concurrency & Stale State Protection', () => {
  const chatStore = useChat();
  const {
    currentChat, rootItems, activeGenerations,
  } = chatStore;

  const { errorCount, clearEvents } = useGlobalEvents();

  beforeEach(() => {
    vi.clearAllMocks();
    currentChat.value = null;
    rootItems.value = [];
    mockRootItems.length = 0;
    mockChatStorage.clear();
    clearEvents();
    mockSettings.value.autoTitleEnabled = false;
  });

  afterEach(() => {
    expect(errorCount.value).toBe(0);
  });

  it('should allow multiple chats to stream concurrently', async () => {
    const { createNewChat, currentChat, sendMessage } = useChat();

    await createNewChat(); 
    const chatA = currentChat.value!;
    const chatAId = chatA.id;
    
    let resolveChatA: () => void;
    const chatAPromise = new Promise<void>(resolve => { resolveChatA = resolve; });
    
    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
      onChunk('A-Start');
      await chatAPromise;
      onChunk('A-End');
    });

    const sendPromiseA = sendMessage('Start A');
    await vi.waitUntil(() => activeGenerations.has(chatAId));

    await createNewChat();
    const chatB = currentChat.value!;
    const chatBId = chatB.id;

    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
      await new Promise(r => setTimeout(r, 100));
      onChunk('B-Response');
    });

    const sendPromiseB = sendMessage('Start B');
    await vi.waitUntil(() => activeGenerations.has(chatBId));

    await sendPromiseB;
    const lastMsgB = chatB.root.items[0]?.replies.items[0];
    expect(lastMsgB?.content).toBe('B-Response');

    expect(chatA.root.items[0]?.replies.items[0]?.content).toBe('A-Start');
    
    resolveChatA!();
    await sendPromiseA;
    expect(chatA.root.items[0]?.replies.items[0]?.content).toBe('A-StartA-End');
  });

  it('should not jump out of a group if moved while generating in background', async () => {
    const { createNewChat, currentChat, sendMessage, persistSidebarStructure, activeGenerations } = useChat();

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
    await vi.waitUntil(() => activeGenerations.has(chatAId));

    // 3. Simulate Sidebar moving Chat A into a group
    // In our simplified mock, persistSidebarStructure updates storage
    const groupG = { id: 'group-g', name: 'G', items: [], isCollapsed: false, updatedAt: Date.now() };
    const newStructure: SidebarItem[] = [
      { 
        id: 'chat_group:group-g', 
        type: 'chat_group' as const, 
        chatGroup: { 
          ...groupG, 
          items: [{ id: `chat:${chatAId}`, type: 'chat' as const, chat: { id: chatAId, title: 'A', updatedAt: Date.now(), groupId: 'group-g' } }] 
        } 
      }
    ];
    
    await persistSidebarStructure(newStructure);
    
    // Verify it is in the group in storage
    const storedChat = mockChatStorage.get(chatAId);
    expect(storedChat?.groupId).toBe('group-g');

    // 4. Finish background generation
    resolveA!();
    await sendPromise;

    // 5. Verify it's STILL in the group
    // EXPECTED TO FAIL until fixed
    expect(mockChatStorage.get(chatAId)?.groupId).toBe('group-g');
  });

  it('should not overwrite manual renames if renamed while generating in background', async () => {
    const { createNewChat, currentChat, sendMessage, renameChat, activeGenerations } = useChat();

    await createNewChat();
    const chatA = currentChat.value!;
    const chatAId = chatA.id;
    chatA.title = 'Original Title';
    await storageService.saveChat(chatA, 0);

    let resolveA: () => void;
    const p = new Promise<void>(r => resolveA = r);
    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
      onChunk('Thinking...');
      await p;
    });

    const sendPromise = sendMessage('Rename me');
    await vi.waitUntil(() => activeGenerations.has(chatAId));

    // Manual rename happens while streaming
    await renameChat(chatAId, 'Manual New Title');
    expect(mockChatStorage.get(chatAId)?.title).toBe('Manual New Title');

    resolveA!();
    await sendPromise;

    // Verify title was not reverted to 'Original Title'
    // EXPECTED TO FAIL until fixed
    expect(mockChatStorage.get(chatAId)?.title).toBe('Manual New Title');
  });

  it('should not resurrect a deleted chat when background generation finishes', async () => {
    const { createNewChat, currentChat, sendMessage, deleteChat, activeGenerations } = useChat();

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
    await vi.waitUntil(() => activeGenerations.has(chatAId));

    // Delete chat while it's still generating in background
    await deleteChat(chatAId);
    expect(mockChatStorage.has(chatAId)).toBe(false);

    resolveA!();
    await sendPromise;

    // Verify chat was not recreated in storage
    expect(mockChatStorage.has(chatAId)).toBe(false);
  });

  it('should not resurrect chats after deleteAllChats', async () => {
    const { createNewChat, currentChat, sendMessage, deleteAllChats, activeGenerations } = useChat();

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
    await vi.waitUntil(() => activeGenerations.has(chatAId));

    await createNewChat();
    const chatBId = currentChat.value!.id;
    let resolveB: () => void;
    const pB = new Promise<void>(r => resolveB = r);
    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
      onChunk('B...');
      await pB;
    });
    const sendB = sendMessage('B');
    await vi.waitUntil(() => activeGenerations.has(chatBId));

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
    const { createNewChat, currentChat, sendMessage, renameChat, activeGenerations } = useChat();

    // 1. Start Chat A
    await createNewChat();
    const chatA = currentChat.value!;
    const chatAId = chatA.id;
    chatA.title = 'Original';
    await storageService.saveChat(chatA, 0);

    let resolveA: () => void;
    const pA = new Promise<void>(r => resolveA = r);
    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
      onChunk('A...');
      await pA;
    });
    const sendA = sendMessage('A');
    await vi.waitUntil(() => activeGenerations.has(chatAId));

    // 2. Switch away from A
    await createNewChat();
    expect(currentChat.value?.id).not.toBe(chatAId);

    // 3. Rename A in background (simulating sidebar edit)
    await renameChat(chatAId, 'New Title');
    expect(mockChatStorage.get(chatAId)?.title).toBe('New Title');

    // 4. Finish A
    resolveA!();
    await sendA;

    // Verify title preserved
    expect(mockChatStorage.get(chatAId)?.title).toBe('New Title');
  });

  it('should not overwrite a manual rename with an auto-generated title', async () => {
    const { createNewChat, currentChat, sendMessage, renameChat, activeGenerations } = useChat();
    mockSettings.value.autoTitleEnabled = true;

    // 1. Setup Chat A
    await createNewChat();
    const chatA = currentChat.value!;
    const chatAId = chatA.id;
    chatA.title = null;

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
    await vi.waitUntil(() => mockLlmChat.mock.calls.length >= 2); // Wait for title gen to start

    // 3. User manually renames while title gen is "calculating"
    await renameChat(chatAId, 'User Manual Title');
    expect(chatA.title).toBe('User Manual Title');

    // 4. Let auto-title finish
    resolveTitle!();
    await sendPromise;
    await vi.waitUntil(() => !activeGenerations.has(chatAId));

    // 5. Verify manual title was NOT overwritten
    expect(chatA.title).toBe('User Manual Title');
    expect(mockChatStorage.get(chatAId)?.title).toBe('User Manual Title');
  });

  it('should maintain the latest group ID even after multiple moves during background generation', async () => {
    const { createNewChat, currentChat, sendMessage, persistSidebarStructure, activeGenerations } = useChat();

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
    await vi.waitUntil(() => activeGenerations.has(chatAId));

    // 2. Move to Group B
    const structureB: SidebarItem[] = [
      { id: 'g-b', type: 'chat_group', chatGroup: { id: 'g-b', name: 'B', items: [{ id: `chat:${chatAId}`, type: 'chat', chat: { id: chatAId, title: 'A', updatedAt: 0, groupId: 'g-b' } }], isCollapsed: false, updatedAt: 0 } }
    ];
    await persistSidebarStructure(structureB);
    expect(chatA.groupId).toBe('g-b');

    // 3. Move to Group C
    const structureC: SidebarItem[] = [
      { id: 'g-c', type: 'chat_group', chatGroup: { id: 'g-c', name: 'C', items: [{ id: `chat:${chatAId}`, type: 'chat', chat: { id: chatAId, title: 'A', updatedAt: 0, groupId: 'g-c' } }], isCollapsed: false, updatedAt: 0 } }
    ];
    await persistSidebarStructure(structureC);
    expect(chatA.groupId).toBe('g-c');

    // 4. Finish generation
    resolveA!();
    await sendPromise;

    // 5. Verify it stayed in the LATEST group (C)
    expect(chatA.groupId).toBe('g-c');
    expect(mockChatStorage.get(chatAId)?.groupId).toBe('g-c');
  });
});