import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChat } from './useChat';
import { storageService } from '../services/storage';
import { reactive, nextTick } from 'vue';
import type { Chat, MessageNode, SidebarItem } from '../models/types';

// Mock storage service
vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    deleteChat: vi.fn(),
    saveGroup: vi.fn(),
    listGroups: vi.fn().mockResolvedValue([]),
    deleteGroup: vi.fn(),
  }
}));

// Mock settings
vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpointType: 'openai', endpointUrl: 'http://localhost', storageType: 'local', autoTitleEnabled: true } }
  })
}));

// Mock LLM Provider
vi.mock('../services/llm', () => {
  class MockOpenAI {
    chat = vi.fn().mockImplementation(async (_msg: MessageNode[], _model: string, _url: string, onChunk: (chunk: string) => void) => {
      onChunk('Hello');
      await new Promise(r => setTimeout(r, 10)); // Simulate network delay
      onChunk(' World');
    });
    listModels = vi.fn().mockResolvedValue(['gpt-4']);
  }
  return {
    OpenAIProvider: MockOpenAI,
    OllamaProvider: vi.fn()
  };
});

describe('useChat Composable Logic', () => {
  const chatStore = useChat();
  const {
    deleteChat, undoDelete, deleteAllChats, lastDeletedChat,
    activeMessages, sendMessage, currentChat
  } = chatStore;

  beforeEach(() => {
    vi.clearAllMocks();
    currentChat.value = null;
  });

  it('should update activeMessages in real-time during streaming', async () => {
    // Setup initial chat
    currentChat.value = {
      id: 'chat-1',
      title: 'Test',
      root: { items: [] },
      modelId: 'gpt-4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false
    };

    // Start sending a message
    const sendPromise = sendMessage('Ping');
    
    // During streaming (after first chunk 'Hello'), check state
    await new Promise(r => setTimeout(r, 5));
    
    expect(activeMessages.value).toHaveLength(2); // User + Assistant
    expect(activeMessages.value[1]?.content).toBe('Hello');

    await sendPromise; // Finish streaming

    expect(activeMessages.value[1]?.content).toBe('Hello World');
  });

  it('should store deleted chat in lastDeletedChat for undo', async () => {
    const mockChat: Chat = { 
      id: '1', 
      title: 'Test', 
      root: { items: [] },
      modelId: 'gpt-4',
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false
    };
    vi.mocked(storageService.loadChat).mockResolvedValue(mockChat);
    vi.mocked(storageService.deleteChat).mockResolvedValue();

    await deleteChat('1');

    expect(storageService.loadChat).toHaveBeenCalledWith('1');
    expect(lastDeletedChat.value).toEqual(mockChat);
  });

  it('should restore chat on undoDelete', async () => {
    const mockChat: Chat = { 
      id: '1', 
      title: 'Test', 
      root: { items: [] },
      modelId: 'gpt-4',
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false
    };
    lastDeletedChat.value = mockChat;
    vi.mocked(storageService.saveChat).mockResolvedValue();
    vi.mocked(storageService.listChats).mockResolvedValue([]);

    await undoDelete();

    expect(storageService.saveChat).toHaveBeenCalledWith(mockChat, 0);
    expect(lastDeletedChat.value).toBeNull();
  });

  it('should delete all chats when deleteAllChats is called', async () => {
    const mockSummaries = [{ id: '1', title: 'T1', updatedAt: 0, order: 0 }, { id: '2', title: 'T2', updatedAt: 0, order: 1 }];
    vi.mocked(storageService.listChats).mockResolvedValue(mockSummaries);
    vi.mocked(storageService.deleteChat).mockResolvedValue();
    vi.mocked(storageService.listGroups).mockResolvedValue([]);

    await deleteAllChats();

    expect(storageService.deleteChat).toHaveBeenCalledTimes(2);
    expect(lastDeletedChat.value).toBeNull();
  });

  it('should rename a chat and update storage', async () => {
    const { renameChat, chats } = useChat();
    const mockChat: Chat = { 
      id: '1', 
      title: 'Old Title', 
      root: { items: [] },
      modelId: 'gpt-4',
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false
    };
    chats.value = [{ id: '1', title: 'Old Title', updatedAt: 0, order: 0 }];
    vi.mocked(storageService.loadChat).mockResolvedValue(mockChat);
    vi.mocked(storageService.saveChat).mockResolvedValue();

    await renameChat('1', 'New Title');

    expect(storageService.loadChat).toHaveBeenCalledWith('1');
    expect(storageService.saveChat).toHaveBeenCalledWith(expect.objectContaining({
      id: '1',
      title: 'New Title'
    }), 0);
  });

  it('should fork a chat up to a specific message', async () => {
    const { forkChat, currentChat, chats } = useChat();
    
    // Create a tree: m1 -> m2
    const m2: MessageNode = { id: 'm2', role: 'assistant', content: 'Msg 2', replies: { items: [] }, timestamp: 0 };
    const m1: MessageNode = { id: 'm1', role: 'user', content: 'Msg 1', replies: { items: [m2] }, timestamp: 0 };
    
    const mockChat: Chat = { 
      id: 'old-chat', 
      title: 'Original', 
      root: { items: [m1] },
      modelId: 'gpt-4',
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false
    };
    
    currentChat.value = reactive(mockChat);
    chats.value = [];
    vi.mocked(storageService.saveChat).mockResolvedValue();
    vi.mocked(storageService.listChats).mockResolvedValue([]);

    // Fork at message 'm1'
    const newId = await forkChat('m1');

    expect(newId).toBeDefined();
    expect(storageService.saveChat).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Fork of Original',
      root: { items: [expect.objectContaining({ id: 'm1' })] },
      currentLeafId: 'm1'
    }), 0);
    
    const savedChat = vi.mocked(storageService.saveChat).mock.calls[0]?.[0] as Chat;
    expect(savedChat.root.items[0]?.replies.items).toHaveLength(0); // m2 should be gone
  });

  it('should support rewriting the very first message', async () => {
    const { sendMessage, editMessage, currentChat, chats } = useChat();
    
    const chatObj: Chat = {
      id: 'chat-root-test',
      title: 'Root Test',
      root: { items: [] },
      modelId: 'gpt-4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false
    };
    currentChat.value = reactive(chatObj);
    chats.value = [{ id: 'chat-root-test', title: 'Root Test', updatedAt: Date.now(), order: 0 }];

    // 1. Send first message
    await sendMessage('First version');
    expect(currentChat.value?.root.items).toHaveLength(1);
    const firstId = currentChat.value?.root.items[0]?.id;

    // 2. Rewrite the first message
    await editMessage(firstId!, 'Second version');

    // 3. Verify
    expect(currentChat.value?.root.items).toHaveLength(2);
    expect(currentChat.value?.root.items[0]?.content).toBe('First version');
    expect(currentChat.value?.root.items[1]?.content).toBe('Second version');
    
    // The current leaf should be the assistant reply of the NEW version
    const secondVersionUserMsg = currentChat.value?.root.items[1];
    expect(currentChat.value?.currentLeafId).toBe(secondVersionUserMsg?.replies.items[0]?.id);
  });

  it('should support manual editing of assistant messages', async () => {
    const { sendMessage, editMessage, currentChat, chats } = useChat();
    
    const chatObj: Chat = {
      id: 'assistant-edit-test',
      title: 'Assistant Edit',
      root: { items: [] },
      modelId: 'gpt-4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false
    };
    currentChat.value = reactive(chatObj);
    chats.value = [{ id: 'assistant-edit-test', title: 'Assistant Edit', updatedAt: Date.now(), order: 0 }];

    // 1. Send first message pair
    await sendMessage('Hello');
    const userMsg = currentChat.value?.root.items[0];
    const assistantMsg = userMsg?.replies.items[0];
    expect(assistantMsg?.role).toBe('assistant');

    // 2. Manually edit the assistant's message
    await editMessage(assistantMsg!.id, 'Manually corrected answer');
    await nextTick();

    // 3. Verify
    // The user message should now have TWO replies (branches)
    const userMsgAfter = currentChat.value?.root.items[0];
    expect(userMsgAfter?.replies.items).toHaveLength(2);
    
    // The active path should be [Original User, Corrected Assistant]
    expect(activeMessages.value).toHaveLength(2);
    expect(activeMessages.value[1]?.role).toBe('assistant');
    expect(activeMessages.value[1]?.content).toBe('Manually corrected answer');
  });

  it('should maintain the new order after reordering items', async () => {
    const { sidebarItems, persistSidebarStructure, groups, chats } = useChat();
    
    const mockGroup = { id: 'g1', name: 'Group A', isCollapsed: false, items: [], updatedAt: 0 };
    const mockChat = { id: 'c1', title: 'Chat B', updatedAt: 0, order: 1 };
    
    groups.value = [mockGroup];
    chats.value = [mockChat];
    
    expect(sidebarItems.value[0]?.type).toBe('group');
    expect(sidebarItems.value[1]?.type).toBe('chat');

    const newItems: SidebarItem[] = [
      { id: 'chat:c1', type: 'chat' as const, chat: mockChat },
      { id: 'group:g1', type: 'group' as const, group: { ...mockGroup, items: [] } }
    ];
    
    await persistSidebarStructure(newItems);
    
    expect(groups.value[0]?.id).toBe('g1');
    const savedChat = chats.value.find(c => c.id === 'c1');
    expect(savedChat?.order).toBe(0); // Swapped, so now order 0
  });

  it('should handle moving a chat into a group', async () => {
    const { persistSidebarStructure, groups, chats } = useChat();
    
    const mockGroup = { id: 'g1', name: 'Group A', isCollapsed: false, items: [], updatedAt: 0 };
    const mockChat = { id: 'c1', title: 'Chat B', updatedAt: 0, order: 1, groupId: null };
    
    groups.value = [mockGroup];
    chats.value = [mockChat];

    const newItems: SidebarItem[] = [
      { 
        id: 'group:g1', 
        type: 'group' as const, 
        group: { 
          ...mockGroup, 
          items: [
            { id: 'chat:c1', type: 'chat' as const, chat: { ...mockChat, groupId: 'g1' } }
          ] 
        } 
      }
    ];

    await persistSidebarStructure(newItems);

    const savedChat = chats.value.find(c => c.id === 'c1');
    expect(savedChat?.groupId).toBe('g1');
    expect(savedChat?.order).toBe(0);
  });

  it('should handle reordering chats within a group', async () => {
    const { persistSidebarStructure, groups, chats } = useChat();
    
    const chat1 = { id: 'c1', title: 'C1', updatedAt: 0, order: 0, groupId: 'g1' };
    const chat2 = { id: 'c2', title: 'C2', updatedAt: 0, order: 1, groupId: 'g1' };
    const mockGroup = { 
      id: 'g1', name: 'G1', isCollapsed: false, updatedAt: 0,
      items: [
        { id: 'chat:c1', type: 'chat' as const, chat: chat1 },
        { id: 'chat:c2', type: 'chat' as const, chat: chat2 }
      ]
    };
    
    groups.value = [mockGroup];
    chats.value = [chat1, chat2];

    const newItems: SidebarItem[] = [
      { 
        id: 'group:g1', 
        type: 'group' as const, 
        group: { 
          ...mockGroup, 
          items: [
            { id: 'chat:c2', type: 'chat' as const, chat: { ...chat2 } },
            { id: 'chat:c1', type: 'chat' as const, chat: { ...chat1 } }
          ] 
        } 
      }
    ];

    await persistSidebarStructure(newItems);

    const savedC1 = chats.value.find(c => c.id === 'c1');
    const savedC2 = chats.value.find(c => c.id === 'c2');
    expect(savedC1?.order).toBe(1);
    expect(savedC2?.order).toBe(0);
    expect(savedC1?.groupId).toBe('g1');
  });

  it('should handle moving a chat out of a group to the root', async () => {
    const { persistSidebarStructure, groups, chats } = useChat();
    
    const chat1 = { id: 'c1', title: 'C1', updatedAt: 0, order: 0, groupId: 'g1' };
    const mockGroup = { 
      id: 'g1', name: 'G1', isCollapsed: false, updatedAt: 0,
      items: [{ id: 'chat:c1', type: 'chat' as const, chat: chat1 }]
    };
    
    groups.value = [mockGroup];
    chats.value = [chat1];

    const newItems: SidebarItem[] = [
      { id: 'group:g1', type: 'group' as const, group: { ...mockGroup, items: [] } },
      { id: 'chat:c1', type: 'chat' as const, chat: { ...chat1, groupId: null } }
    ];

    await persistSidebarStructure(newItems);

    const savedChat = chats.value.find(c => c.id === 'c1');
    expect(savedChat?.groupId).toBeNull();
    expect(savedChat?.order).toBe(1);
  });

  it('should handle moving a chat from one group to another', async () => {
    const { persistSidebarStructure, groups, chats } = useChat();
    
    const chat1 = { id: 'c1', title: 'C1', updatedAt: 0, order: 0, groupId: 'g1' };
    const groupA = { 
      id: 'g1', name: 'GA', isCollapsed: false, updatedAt: 0,
      items: [{ id: 'chat:c1', type: 'chat' as const, chat: chat1 }]
    };
    const groupB = { 
      id: 'g2', name: 'GB', isCollapsed: false, updatedAt: 0,
      items: []
    };
    
    groups.value = [groupA, groupB];
    chats.value = [chat1];

    const newItems: SidebarItem[] = [
      { id: 'group:g1', type: 'group' as const, group: { ...groupA, items: [] } },
      { 
        id: 'group:g2', 
        type: 'group' as const, 
        group: { 
          ...groupB, 
          items: [{ id: 'chat:c1', type: 'chat' as const, chat: { ...chat1, groupId: 'g2' } }] 
        } 
      }
    ];

    await persistSidebarStructure(newItems);

    const savedChat = chats.value.find(c => c.id === 'c1');
    expect(savedChat?.groupId).toBe('g2');
    expect(savedChat?.order).toBe(0);
  });
});