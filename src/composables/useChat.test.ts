import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useChat, findRestorationIndex, type AddToastOptions } from './useChat';
import { storageService } from '../services/storage';
import { reactive, nextTick, triggerRef } from 'vue';
import type { Chat, MessageNode, SidebarItem, ChatGroup } from '../models/types';
import { useGlobalEvents } from './useGlobalEvents';

// Mock storage service state
const mockRootItems: SidebarItem[] = [];

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    deleteChat: vi.fn(),
    saveGroup: vi.fn(),
    listGroups: vi.fn().mockResolvedValue([]),
    getSidebarStructure: vi.fn().mockImplementation(() => Promise.resolve([...mockRootItems])),
    deleteGroup: vi.fn(),
  },
}));

// Mock settings
vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpointType: 'openai', endpointUrl: 'http://localhost', storageType: 'local', autoTitleEnabled: true } },
  }),
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
    OllamaProvider: vi.fn(),
  };
});

describe('useChat Composable Logic', () => {
  const chatStore = useChat();
  const {
    activeMessages, sendMessage, currentChat, rootItems,
  } = chatStore;

  const { errorCount, clearEvents } = useGlobalEvents();

  beforeEach(() => {
    vi.clearAllMocks();
    currentChat.value = null;
    rootItems.value = [];
    mockRootItems.length = 0;
    clearEvents();
    
    // Setup persistence mocks to actually reorder mockRootItems if index is different
    vi.mocked(storageService.saveChat).mockImplementation((chat: Chat, index: number) => {
        const currentIdx = mockRootItems.findIndex(item => item.type === 'chat' && item.chat.id === chat.id);
        if (currentIdx !== -1 && currentIdx !== index) {
            const item = mockRootItems.splice(currentIdx, 1)[0]!;
            mockRootItems.splice(index, 0, item);
        } else if (currentIdx === -1) {
            mockRootItems.splice(index, 0, { id: `chat:${chat.id}`, type: 'chat', chat: { id: chat.id, title: chat.title, updatedAt: chat.updatedAt, groupId: chat.groupId } });
        }
        return Promise.resolve();
    });

    vi.mocked(storageService.saveGroup).mockImplementation((group: ChatGroup, index: number) => {
        const currentIdx = mockRootItems.findIndex(item => item.type === 'group' && item.group.id === group.id);
        if (currentIdx !== -1 && currentIdx !== index) {
            const item = mockRootItems.splice(currentIdx, 1)[0]!;
            mockRootItems.splice(index, 0, item);
        } else if (currentIdx === -1) {
            mockRootItems.splice(index, 0, { id: `group:${group.id}`, type: 'group', group });
        }
        return Promise.resolve();
    });

    vi.mocked(storageService.loadChat).mockImplementation((id) => {
        if (currentChat.value?.id === id) return Promise.resolve(currentChat.value);
        return Promise.resolve(null);
    });
  });

  afterEach(() => {
    expect(errorCount.value).toBe(0);
  });

  it('should update activeMessages in real-time during streaming', async () => {
    currentChat.value = reactive({
      id: 'chat-1', title: 'Test', root: { items: [] }, modelId: 'gpt-4',
      createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
    });
    const sendPromise = sendMessage('Ping');
    await new Promise(r => setTimeout(r, 20)); 
    triggerRef(currentChat);
    expect(['Hello', 'Hello World']).toContain(activeMessages.value[1]?.content);
    await sendPromise;
    triggerRef(currentChat);
    expect(activeMessages.value[1]?.content).toBe('Hello World');
  });

  it('should rename a chat and update storage', async () => {
    const { renameChat, rootItems } = useChat();
    const mockChat: Chat = { id: '1', title: 'Old', root: { items: [] }, modelId: 'gpt-4', createdAt: 0, updatedAt: 0, debugEnabled: false };
    rootItems.value = [{ id: 'chat:1', type: 'chat', chat: { id: '1', title: 'Old', updatedAt: 0 } }];
    mockRootItems.push(...rootItems.value);
    vi.mocked(storageService.loadChat).mockResolvedValue(mockChat);
    vi.mocked(storageService.saveChat).mockResolvedValue();
    await renameChat('1', 'New');
    expect(storageService.saveChat).toHaveBeenCalledWith(expect.objectContaining({ id: '1', title: 'New' }), 0);
  });

  it('should fork a chat up to a specific message', async () => {
    const { forkChat, currentChat, rootItems } = useChat();
    
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
      debugEnabled: false,
    };
    
    currentChat.value = reactive(mockChat);
    rootItems.value = [{ id: 'chat:old-chat', type: 'chat', chat: { id: 'old-chat', title: 'Original', updatedAt: 0 } }];
    mockRootItems.push(...rootItems.value);
    
    vi.mocked(storageService.saveChat).mockResolvedValue();
    vi.mocked(storageService.listChats).mockResolvedValue([]);

    // Fork at message 'm1'
    const newId = await forkChat('m1');

    expect(newId).toBeDefined();
    expect(storageService.saveChat).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Fork of Original',
      root: { items: [expect.objectContaining({ id: 'm1' })] },
      currentLeafId: 'm1',
    }), 0);
  });

  it('should support rewriting the very first message', async () => {
    const { sendMessage, editMessage, currentChat, rootItems } = useChat();
    
    const chatObj: Chat = {
      id: 'chat-root-test',
      title: 'Root Test',
      root: { items: [] },
      modelId: 'gpt-4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    };
    currentChat.value = reactive(chatObj);
    const initial = [{ id: 'chat:chat-root-test', type: 'chat', chat: { id: 'chat-root-test', title: 'Root Test', updatedAt: Date.now() } }] as SidebarItem[];
    rootItems.value = initial;
    mockRootItems.push(...initial);

    // 1. Send first message
    await sendMessage('First version');
    triggerRef(currentChat);
    expect(currentChat.value?.root.items).toHaveLength(1);
    const firstId = currentChat.value?.root.items[0]?.id;

    // 2. Rewrite the first message
    await editMessage(firstId!, 'Second version');
    triggerRef(currentChat);

    // 3. Verify
    expect(currentChat.value?.root.items).toHaveLength(2);
    expect(currentChat.value?.root.items[0]?.content).toBe('First version');
    expect(currentChat.value?.root.items[1]?.content).toBe('Second version');
  });

  it('should support manual editing of assistant messages', async () => {
    const { sendMessage, editMessage, currentChat, rootItems } = useChat();
    
    const chatObj: Chat = {
      id: 'assistant-edit-test',
      title: 'Assistant Edit',
      root: { items: [] },
      modelId: 'gpt-4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    };
    currentChat.value = reactive(chatObj);
    const initial = [{ id: 'chat:assistant-edit-test', type: 'chat', chat: { id: 'assistant-edit-test', title: 'Assistant Edit', updatedAt: Date.now() } }] as SidebarItem[];
    rootItems.value = initial;
    mockRootItems.push(...initial);

    // 1. Send first message pair
    await sendMessage('Hello');
    triggerRef(currentChat);
    const userMsg = currentChat.value?.root.items[0];
    const assistantMsg = userMsg?.replies.items[0];
    expect(assistantMsg?.role).toBe('assistant');

    // 2. Manually edit the assistant's message
    await editMessage(assistantMsg!.id, 'Manually corrected answer');
    await nextTick();
    triggerRef(currentChat);

    // 3. Verify
    // The user message should now have TWO replies (branches)
    const userMsgAfter = currentChat.value?.root.items[0];
    expect(userMsgAfter?.replies.items).toHaveLength(2);
    expect(activeMessages.value).toHaveLength(2);
    expect(activeMessages.value[1]?.content).toBe('Manually corrected answer');
  });

  it('should maintain the new order after reordering items', async () => {
    const { sidebarItems, persistSidebarStructure, rootItems } = useChat();
    
    const mockGroup = { id: 'g1', name: 'Group A', isCollapsed: false, items: [], updatedAt: 0 };
    const mockChat = { id: 'c1', title: 'Chat B', updatedAt: 0 };
    
    const initial: SidebarItem[] = [
      { id: 'group:g1', type: 'group', group: mockGroup },
      { id: 'chat:c1', type: 'chat', chat: mockChat },
    ];
    rootItems.value = initial;
    mockRootItems.push(...initial);
    
    expect(sidebarItems.value[0]?.type).toBe('group');
    expect(sidebarItems.value[1]?.type).toBe('chat');

    const newItems: SidebarItem[] = [
      { id: 'chat:c1', type: 'chat' as const, chat: mockChat },
      { id: 'group:g1', type: 'group' as const, group: { ...mockGroup, items: [] } },
    ];
    
    await persistSidebarStructure(newItems);
    
    expect(rootItems.value[0]?.id).toBe('chat:c1');
  });

  it('should handle moving a chat into a group', async () => {
    const { persistSidebarStructure, rootItems, chats } = useChat();
    
    const mockGroup = { id: 'g1', name: 'Group A', isCollapsed: false, items: [], updatedAt: 0 };
    const mockChat = { id: 'c1', title: 'Chat B', updatedAt: 0, groupId: null };
    
    const initial: SidebarItem[] = [
      { id: 'group:g1', type: 'group', group: mockGroup },
      { id: 'chat:c1', type: 'chat', chat: mockChat },
    ];
    rootItems.value = initial;
    mockRootItems.push(...initial);

    const newItems: SidebarItem[] = [
      { 
        id: 'group:g1', 
        type: 'group' as const, 
        group: { 
          ...mockGroup, 
          items: [
            { id: 'chat:c1', type: 'chat' as const, chat: { ...mockChat, groupId: 'g1' } },
          ], 
        }, 
      },
    ];

    await persistSidebarStructure(newItems);

    const savedChat = chats.value.find(c => c.id === 'c1');
    expect(savedChat?.groupId).toBe('g1');
  });

  it('should handle reordering chats within a group', async () => {
    const { persistSidebarStructure, rootItems, chats } = useChat();
    
    const chat1 = { id: 'c1', title: 'C1', updatedAt: 0, groupId: 'g1' };
    const chat2 = { id: 'c2', title: 'C2', updatedAt: 0, groupId: 'g1' };
    const mockGroup = { 
      id: 'g1', name: 'G1', isCollapsed: false, updatedAt: 0,
      items: [
        { id: 'chat:c1', type: 'chat' as const, chat: chat1 },
        { id: 'chat:c2', type: 'chat' as const, chat: chat2 },
      ],
    };
    
    const initial: SidebarItem[] = [{ id: 'group:g1', type: 'group', group: mockGroup }];
    rootItems.value = initial;
    mockRootItems.push(...initial);

    const newItems: SidebarItem[] = [
      { 
        id: 'group:g1', 
        type: 'group' as const, 
        group: { 
          ...mockGroup, 
          items: [
            { id: 'chat:c2', type: 'chat' as const, chat: { ...chat2 } },
            { id: 'chat:c1', type: 'chat' as const, chat: { ...chat1 } },
          ], 
        }, 
      },
    ];

    await persistSidebarStructure(newItems);

    expect(chats.value[0]?.id).toBe('c2');
    expect(chats.value[1]?.id).toBe('c1');
  });

  it('should handle moving a chat out of a group to the root', async () => {
    const { persistSidebarStructure, rootItems, chats } = useChat();
    
    const chat1 = { id: 'c1', title: 'C1', updatedAt: 0, groupId: 'g1' };
    const mockGroup = { 
      id: 'g1', name: 'G1', isCollapsed: false, updatedAt: 0,
      items: [{ id: 'chat:c1', type: 'chat' as const, chat: chat1 }],
    };
    
    const initial: SidebarItem[] = [{ id: 'group:g1', type: 'group', group: mockGroup }];
    rootItems.value = initial;
    mockRootItems.push(...initial);

    const newItems: SidebarItem[] = [
      { id: 'group:g1', type: 'group' as const, group: { ...mockGroup, items: [] } },
      { id: 'chat:c1', type: 'chat' as const, chat: { ...chat1, groupId: null } },
    ];

    await persistSidebarStructure(newItems);

    const savedChat = chats.value.find(c => c.id === 'c1');
    expect(savedChat?.groupId).toBeNull();
  });

  it('should handle moving a chat from one group to another', async () => {
    const { persistSidebarStructure, rootItems, chats } = useChat();
    
    const chat1 = { id: 'c1', title: 'C1', updatedAt: 0, groupId: 'g1' };
    const groupA = { 
      id: 'g1', name: 'GA', isCollapsed: false, updatedAt: 0,
      items: [{ id: 'chat:c1', type: 'chat' as const, chat: chat1 }],
    };
    const groupB = { 
      id: 'g2', name: 'GB', isCollapsed: false, updatedAt: 0,
      items: [],
    };
    
    const initial: SidebarItem[] = [
      { id: 'group:g1', type: 'group', group: groupA },
      { id: 'group:g2', type: 'group', group: groupB },
    ];
    rootItems.value = initial;
    mockRootItems.push(...initial);

    const newItems: SidebarItem[] = [
      { id: 'group:g1', type: 'group' as const, group: { ...groupA, items: [] } },
      { 
        id: 'group:g2', 
        type: 'group' as const, 
        group: { 
          ...groupB, 
          items: [{ id: 'chat:c1', type: 'chat' as const, chat: { ...chat1, groupId: 'g2' } }], 
        }, 
      },
    ];

    await persistSidebarStructure(newItems);

    const savedChat = chats.value.find(c => c.id === 'c1');
    expect(savedChat?.groupId).toBe('g2');
  });

  it('should insert a new chat before the first individual chat', async () => {
    // 1. Setup initial state in MOCK storage
    const initial: SidebarItem[] = [
      { id: 'group:g1', type: 'group', group: { id: 'g1', name: 'G1', isCollapsed: false, updatedAt: 0, items: [] } },
      { id: 'chat:c1', type: 'chat', chat: { id: 'c1', title: 'C1', updatedAt: 0 } },
    ];
    mockRootItems.push(...initial);
    
    // Override local mock for this specific test
    vi.mocked(storageService.saveChat).mockImplementation(() => {
        mockRootItems.length = 0;
        mockRootItems.push(...JSON.parse(JSON.stringify(rootItems.value)));
        return Promise.resolve();
    });

    const { rootItems: items } = useChat();
    await chatStore.loadChats(); 
    expect(items.value).toHaveLength(2);

    await chatStore.createNewChat();

    expect(items.value).toHaveLength(3);
    expect(items.value[0]?.type).toBe('group');
    expect(items.value[1]?.type).toBe('chat');
    expect(items.value[2]?.id).toBe('chat:c1'); 
  });

  it('should prepend a new group to the rootItems list', async () => {
    const initial: SidebarItem[] = [
      { id: 'chat:c1', type: 'chat', chat: { id: 'c1', title: 'C1', updatedAt: 0 } },
    ];
    mockRootItems.push(...initial);
    
    // Override local mock
    vi.mocked(storageService.saveGroup).mockImplementation(() => {
        mockRootItems.length = 0;
        mockRootItems.push(...JSON.parse(JSON.stringify(rootItems.value)));
        return Promise.resolve();
    });

    const { createGroup, rootItems: items } = useChat();
    await chatStore.loadChats();

    await createGroup('New Group');

    expect(items.value).toHaveLength(2);
    expect(items.value[0]?.type).toBe('group');
    const firstItem = items.value[0];
    if (firstItem?.type === 'group') {
        expect(firstItem.group.name).toBe('New Group');
    } else {
        throw new Error('First item should be a group');
    }
    expect(items.value[1]?.id).toBe('chat:c1');
  });

  it('should maintain the correct position after sending a message', async () => {
    const { sendMessage, rootItems, currentChat } = useChat();
    const c2 = { id: 'c2', title: 'C2', updatedAt: 0 };
    const initial: SidebarItem[] = [
      { id: 'group:g1', type: 'group', group: { id: 'g1', name: 'G1', isCollapsed: false, updatedAt: 0, items: [] } },
      { id: 'chat:c1', type: 'chat', chat: { id: 'c1', title: 'C1', updatedAt: 0 } },
      { id: 'chat:c2', type: 'chat', chat: c2 },
    ];
    mockRootItems.push(...initial);
    await chatStore.loadChats();
    currentChat.value = reactive({ ...c2, root: { items: [] }, modelId: 'm1', createdAt: 0, updatedAt: 0, debugEnabled: false });
    await sendMessage('Hello');
    await chatStore.loadChats();
    expect(rootItems.value[2]?.id).toBe('chat:c2');
  });

  describe('findRestorationIndex Logic (Bidirectional Context)', () => {
    const items: SidebarItem[] = [
      { id: 'i1', type: 'chat', chat: { id: 'c1', title: '1', updatedAt: 0 } },
      { id: 'i2', type: 'chat', chat: { id: 'c2', title: '2', updatedAt: 0 } },
      { id: 'i3', type: 'chat', chat: { id: 'c3', title: '3', updatedAt: 0 } },
    ];

    it('should return index after prevId if prevId is present', () => {
      expect(findRestorationIndex(items, 'i1', 'i3')).toBe(1);
      expect(findRestorationIndex(items, 'i2', 'i3')).toBe(2);
    });

    it('should return index before nextId if prevId is missing but nextId is present', () => {
      expect(findRestorationIndex(items, 'deleted-prev', 'i2')).toBe(1);
      expect(findRestorationIndex(items, null, 'i1')).toBe(0);
      expect(findRestorationIndex(items, null, 'i3')).toBe(2);
    });

    it('should return 0 (top) if both prevId and nextId are missing or not in list', () => {
      expect(findRestorationIndex(items, 'ghost-1', 'ghost-2')).toBe(0);
      expect(findRestorationIndex(items, null, null)).toBe(0);
    });

    it('should return 0 for empty list', () => {
      expect(findRestorationIndex([], 'any', 'any')).toBe(0);
    });

    it('should handle last position correctly', () => {
      expect(findRestorationIndex(items, 'i3', null)).toBe(3);
    });

    it('should restore the last item of a group correctly in an integrated flow', async () => {
      // 1. Prepare data
      const chat2Id = 'c2';
      const c1 = { id: 'c1', title: '1', updatedAt: 0, groupId: 'g1' };
      const c2 = { id: chat2Id, title: '2', updatedAt: 0, groupId: 'g1' };
      const g1 = { id: 'g1', name: 'G1', isCollapsed: false, updatedAt: 0, items: [
        { id: 'chat:c1', type: 'chat', chat: c1 },
        { id: 'chat:c2', type: 'chat', chat: c2 },
      ] as SidebarItem[] };
      
      mockRootItems.length = 0;
      mockRootItems.push({ id: 'group:g1', type: 'group', group: g1 });
      
      // Ensure mock loadChat returns the chat we are about to delete
      vi.mocked(storageService.loadChat).mockImplementation(async (id) => {
        if (id === chat2Id) return { 
          ...c2, 
          root: { items: [] }, 
          modelId: 'gpt-4', 
          createdAt: 0, 
          debugEnabled: false, 
        } as Chat;
        return null;
      });

      // Crucial: Update mockRootItems when saveChat is called during Undo
      vi.mocked(storageService.saveChat).mockImplementation(async (chat: Chat, index: number) => {
        const item: SidebarItem = { id: `chat:${chat.id}`, type: 'chat', chat: { id: chat.id, title: chat.title, updatedAt: chat.updatedAt, groupId: chat.groupId } };
        const targetList = chat.groupId 
            ? mockRootItems.find(i => i.type === 'group' && i.group.id === chat.groupId)
            : null;
        
        if (targetList && targetList.type === 'group') {
            targetList.group.items.splice(index, 0, item);
        } else {
            mockRootItems.splice(index, 0, item);
        }
        return Promise.resolve();
      });

      await chatStore.loadChats();

      // 2. Mock toast capture with proper typing
      let capturedOnAction: (() => void | Promise<void>) | undefined;
      const mockAdd = (toast: AddToastOptions) => {
        capturedOnAction = toast.onAction;
        return 'test-toast-id';
      };

      // 3. Act: Delete C2 (the last item) with injection
      const { deleteChat: delChat } = useChat();
      await delChat(chat2Id, mockAdd);
      
      // 4. Simulate storage change (item removed) and reload side panel
      const groupInStorage = mockRootItems[0];
      if (groupInStorage?.type === 'group') {
        groupInStorage.group.items = groupInStorage.group.items.filter(i => i.id !== `chat:${chat2Id}`);
      }
      await chatStore.loadChats();

      // 5. Act: Undo
      if (capturedOnAction) {
        await capturedOnAction();
      } else {
        throw new Error('onAction was not captured. deleteChat might have returned early.');
      }

      // 6. Verify: C2 should be back at the end (index 1 in the group items)
      const restoredGroup = rootItems.value[0];
      if (restoredGroup?.type === 'group') {
        expect(restoredGroup.group.items).toHaveLength(2);
        expect(restoredGroup.group.items[1]?.id).toBe(`chat:${chat2Id}`);
      }
    });
  });
});