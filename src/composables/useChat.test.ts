import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useChat, findRestorationIndex, type AddToastOptions } from './useChat';
import { storageService } from '../services/storage';
import { reactive, nextTick, triggerRef } from 'vue';
import type { Chat, MessageNode, SidebarItem, ChatGroup, Attachment, Hierarchy, HierarchyNode, HierarchyChatGroupNode, ChatContent } from '../models/types';
import { useGlobalEvents } from './useGlobalEvents';

// Mock storage service state
const mockRootItems: SidebarItem[] = [];
let mockHierarchy: Hierarchy = { items: [] };

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    saveChatMeta: vi.fn(),
    saveChatContent: vi.fn(),
    updateHierarchy: vi.fn(),
    loadHierarchy: vi.fn(),
    deleteChat: vi.fn(),
    saveChatGroup: vi.fn(),
    listChatGroups: vi.fn().mockResolvedValue([]),
    getSidebarStructure: vi.fn().mockImplementation(() => Promise.resolve([...mockRootItems])),
    deleteChatGroup: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
  },
}));

// Mock settings
vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpointType: 'openai', endpointUrl: 'http://localhost', storageType: 'local', autoTitleEnabled: true, defaultModelId: 'gpt-4' } },
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null },
  }),
}));

// Mock LLM Provider
const mockLlmChat = vi.fn().mockImplementation(async (_msg: any[], _model: string, _url: string, onChunk: (chunk: string) => void) => {
  onChunk('Hello');
  await new Promise(r => setTimeout(r, 10)); // Simulate network delay
  onChunk(' World');
});

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
    mockHierarchy = { items: [] };
    clearEvents();
    
    // Setup persistence mocks to actually update mockHierarchy
    vi.mocked(storageService.saveChatMeta).mockResolvedValue(Promise.resolve());
    vi.mocked(storageService.saveChatContent).mockResolvedValue(Promise.resolve());
    vi.mocked(storageService.saveChatGroup).mockResolvedValue(Promise.resolve());

    vi.mocked(storageService.loadHierarchy).mockImplementation(() => Promise.resolve(mockHierarchy));

    vi.mocked(storageService.updateHierarchy).mockImplementation(async (updater) => {
      mockHierarchy = await updater(mockHierarchy);
      // For tests, we also need to update mockRootItems to reflect the hierarchy
      // This is a simplification
      mockRootItems.length = 0;
      mockHierarchy.items.forEach(node => {
        if (node.type === 'chat') {
          mockRootItems.push({ id: `chat:${node.id}`, type: 'chat', chat: { id: node.id, title: 'Chat', updatedAt: 0, groupId: null } });
        } else {
          mockRootItems.push({ id: `chat_group:${node.id}`, type: 'chat_group', chatGroup: { id: node.id, name: 'Group', isCollapsed: false, updatedAt: 0, items: node.chat_ids.map(cid => ({ id: `chat:${cid}`, type: 'chat', chat: { id: cid, title: 'Chat', updatedAt: 0, groupId: node.id } })) } });
        }
      });
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
      id: 'chat-1', title: 'Test', root: { items: [] },
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
    const mockChat: Chat = { id: '1', title: 'Old', root: { items: [] }, createdAt: 0, updatedAt: 0, debugEnabled: false };
    rootItems.value = [{ id: 'chat:1', type: 'chat', chat: { id: '1', title: 'Old', updatedAt: 0 } }];
    mockRootItems.push(...rootItems.value);
    vi.mocked(storageService.loadChat).mockResolvedValue(mockChat);
    
    await renameChat('1', 'New');
    expect(storageService.saveChatMeta).toHaveBeenCalledWith(expect.objectContaining({ id: '1', title: 'New' }));
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
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false,
      modelId: 'special-model',
    };
    
    currentChat.value = reactive(mockChat);
    rootItems.value = [{ id: 'chat:old-chat', type: 'chat', chat: { id: 'old-chat', title: 'Original', updatedAt: 0 } }];
    mockRootItems.push(...rootItems.value);
    mockHierarchy.items = [{ type: 'chat', id: 'old-chat' }];
    
    vi.mocked(storageService.listChats).mockResolvedValue([]);

    // Fork at message 'm1'
    const newId = await forkChat(currentChat.value!, 'm1');

    expect(newId).toBeDefined();
    expect(storageService.saveChatMeta).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Fork of Original',
      currentLeafId: 'm1',
    }));
    expect(storageService.updateHierarchy).toHaveBeenCalled();
  });

  it('should inherit attachments and modelId during fork', async () => {
    const { forkChat, currentChat } = useChat();
    
    const att: Attachment = { id: 'a1', originalName: 't.png', mimeType: 'image/png', size: 100, uploadedAt: 0, status: 'persisted' };
    const m1: MessageNode = { 
      id: 'm1', 
      role: 'assistant', 
      content: 'Msg 1', 
      attachments: [att],
      modelId: 'special-model',
      replies: { items: [] }, 
      timestamp: 0 
    };
    
    const mockChat: Chat = { 
      id: 'old-chat', 
      title: 'Original', 
      root: { items: [m1] },
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false,
      modelId: 'special-model',
    };
    
    currentChat.value = reactive(mockChat);
    mockHierarchy.items = [{ type: 'chat', id: 'old-chat' }];
    
    const newId = await forkChat(currentChat.value!, 'm1');

    const savedContent = vi.mocked(storageService.saveChatContent).mock.calls[0]?.[1] as ChatContent;
    const clonedNode = savedContent?.root.items[0];
    expect(clonedNode?.attachments).toEqual([att]);
    
    const savedMeta = vi.mocked(storageService.saveChatMeta).mock.calls.find(call => (call[0] as Chat).id === newId)?.[0] as Chat;
    expect(savedMeta?.modelId).toBe('special-model');
  });

  it('should preserve attachments during editMessage', async () => {
    const { editMessage, currentChat } = useChat();
    
    const att: Attachment = { id: 'a1', originalName: 't.png', mimeType: 'image/png', size: 100, uploadedAt: 0, status: 'persisted' };
    const m1: MessageNode = { 
      id: 'm1', 
      role: 'assistant', 
      content: 'Original Content', 
      attachments: [att],
      modelId: 'm1',
      replies: { items: [] }, 
      timestamp: 0 
    };
    
    currentChat.value = reactive({ 
      id: 'c1', 
      title: 'T', 
      root: { items: [m1] },
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false,
    });
    
    // Edit assistant message
    await editMessage('m1', 'New Content');

    expect(currentChat.value?.root.items).toHaveLength(2);
    const newMsg = currentChat.value?.root.items[1];
    expect(newMsg?.content).toBe('New Content');
    expect(newMsg?.attachments).toEqual([att]);
  });

  it('should support rewriting the very first message', async () => {
    const { sendMessage, editMessage, currentChat, rootItems } = useChat();
    
    const chatObj: Chat = {
      id: 'chat-root-test',
      title: 'Root Test',
      root: { items: [] },
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

  it('should branch into a new version when regenerateMessage is called', async () => {
    const { sendMessage, regenerateMessage, currentChat } = useChat();
    
    currentChat.value = reactive({
      id: 'regen-test', title: 'Regen', root: { items: [] },
      createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
    });

    // 1. Send first message and get first response
    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
      onChunk('First Response');
    });
    await sendMessage('Hello');
    triggerRef(currentChat);

    const userMsg = currentChat.value?.root.items[0];
    const firstAssistantMsg = userMsg?.replies.items[0];
    expect(userMsg?.replies.items).toHaveLength(1);
    expect(firstAssistantMsg?.content).toBe('First Response');
    expect(currentChat.value.currentLeafId).toBe(firstAssistantMsg?.id);

    // 2. Regenerate
    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
      onChunk('Second Response');
    });
    await regenerateMessage(firstAssistantMsg!.id);
    triggerRef(currentChat);

    // 3. Verify branching
    expect(userMsg?.replies.items).toHaveLength(2);
    const secondAssistantMsg = userMsg?.replies.items[1];
    expect(secondAssistantMsg?.content).toBe('Second Response');
    expect(secondAssistantMsg?.id).not.toBe(firstAssistantMsg?.id);
    
    // 4. Verify current view points to the new version
    expect(currentChat.value.currentLeafId).toBe(secondAssistantMsg?.id);
    expect(activeMessages.value[1]?.content).toBe('Second Response');
  });

  it('should maintain the new order after reordering items', async () => {
    const { persistSidebarStructure, rootItems } = useChat();
    
    const mockChatGroup = { id: 'g1', name: 'Group A', isCollapsed: false, items: [], updatedAt: 0 };
    const mockChat = { id: 'c1', title: 'Chat B', updatedAt: 0 };
    
    const initial: SidebarItem[] = [
      { id: 'chat_group:g1', type: 'chat_group', chatGroup: mockChatGroup },
      { id: 'chat:c1', type: 'chat', chat: mockChat },
    ];
    rootItems.value = initial;
    mockRootItems.push(...initial);
    mockHierarchy.items = [
      { type: 'chat_group', id: 'g1', chat_ids: [] },
      { type: 'chat', id: 'c1' }
    ];

    const newItems: SidebarItem[] = [
      { id: 'chat:c1', type: 'chat' as const, chat: mockChat },
      { id: 'chat_group:g1', type: 'chat_group' as const, chatGroup: { ...mockChatGroup, items: [] } },
    ];
    
    await persistSidebarStructure(newItems);
    
    expect(mockHierarchy.items[0]?.id).toBe('c1');
  });

  it('should handle moving a chat into a chat group', async () => {
    const { persistSidebarStructure, rootItems } = useChat();
    
    const mockChatGroup = { id: 'g1', name: 'Group A', isCollapsed: false, items: [], updatedAt: 0 };
    const mockChat = { id: 'c1', title: 'Chat B', updatedAt: 0, groupId: null };
    
    const initial: SidebarItem[] = [
      { id: 'chat_group:g1', type: 'chat_group', chatGroup: mockChatGroup },
      { id: 'chat:c1', type: 'chat', chat: mockChat },
    ];
    rootItems.value = initial;
    mockRootItems.push(...initial);
    mockHierarchy.items = [
      { type: 'chat_group', id: 'g1', chat_ids: [] },
      { type: 'chat', id: 'c1' }
    ];

    const newItems: SidebarItem[] = [
      { 
        id: 'chat_group:g1', 
        type: 'chat_group' as const, 
        chatGroup: { 
          ...mockChatGroup, 
          items: [
            { id: 'chat:c1', type: 'chat' as const, chat: { ...mockChat, groupId: 'g1' } },
          ], 
        }, 
      },
    ];

    await persistSidebarStructure(newItems);
    const groupNode = mockHierarchy.items.find(i => i.id === 'g1') as HierarchyChatGroupNode;
    expect(groupNode.chat_ids).toContain('c1');
  });

  it('should handle reordering chats within a chat group', async () => {
    const { persistSidebarStructure, rootItems } = useChat();
    
    const chat1 = { id: 'c1', title: 'C1', updatedAt: 0, groupId: 'g1' };
    const chat2 = { id: 'c2', title: 'C2', updatedAt: 0, groupId: 'g1' };
    const mockChatGroup = { 
      id: 'g1', name: 'G1', isCollapsed: false, updatedAt: 0,
      items: [
        { id: 'chat:c1', type: 'chat' as const, chat: chat1 },
        { id: 'chat:c2', type: 'chat' as const, chat: chat2 },
      ],
    };
    
    const initial: SidebarItem[] = [{ id: 'chat_group:g1', type: 'chat_group', chatGroup: mockChatGroup }];
    rootItems.value = initial;
    mockRootItems.push(...initial);
    mockHierarchy.items = [{ type: 'chat_group', id: 'g1', chat_ids: ['c1', 'c2'] }];

    const newItems: SidebarItem[] = [
      { 
        id: 'chat_group:g1', 
        type: 'chat_group' as const, 
        chatGroup: { 
          ...mockChatGroup, 
          items: [
            { id: 'chat:c2', type: 'chat' as const, chat: { ...chat2 } },
            { id: 'chat:c1', type: 'chat' as const, chat: { ...chat1 } },
          ], 
        }, 
      },
    ];

    await persistSidebarStructure(newItems);
    const groupNode = mockHierarchy.items[0] as HierarchyChatGroupNode;
    expect(groupNode.chat_ids[0]).toBe('c2');
    expect(groupNode.chat_ids[1]).toBe('c1');
  });

  it('should handle moving a chat out of a chat group to the root', async () => {
    const { persistSidebarStructure, rootItems } = useChat();
    
    const chat1 = { id: 'c1', title: 'C1', updatedAt: 0, groupId: 'g1' };
    const mockChatGroup = { 
      id: 'g1', name: 'G1', isCollapsed: false, updatedAt: 0,
      items: [{ id: 'chat:c1', type: 'chat' as const, chat: chat1 }],
    };
    
    const initial: SidebarItem[] = [{ id: 'chat_group:g1', type: 'chat_group', chatGroup: mockChatGroup }];
    rootItems.value = initial;
    mockRootItems.push(...initial);
    mockHierarchy.items = [{ type: 'chat_group', id: 'g1', chat_ids: ['c1'] }];

    const newItems: SidebarItem[] = [
      { id: 'chat_group:g1', type: 'chat_group' as const, chatGroup: { ...mockChatGroup, items: [] } },
      { id: 'chat:c1', type: 'chat' as const, chat: { ...chat1, groupId: null } },
    ];

    await persistSidebarStructure(newItems);
    expect(mockHierarchy.items.find(i => i.type === 'chat' && i.id === 'c1')).toBeDefined();
  });

  it('should handle moving a chat from one chat group to another', async () => {
    const { persistSidebarStructure, rootItems } = useChat();
    
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
      { id: 'chat_group:g1', type: 'chat_group', chatGroup: groupA },
      { id: 'chat_group:g2', type: 'chat_group', chatGroup: groupB },
    ];
    rootItems.value = initial;
    mockRootItems.push(...initial);
    mockHierarchy.items = [
      { type: 'chat_group', id: 'g1', chat_ids: ['c1'] },
      { type: 'chat_group', id: 'g2', chat_ids: [] }
    ];

    const newItems: SidebarItem[] = [
      { id: 'chat_group:g1', type: 'chat_group' as const, chatGroup: { ...groupA, items: [] } },
      { 
        id: 'chat_group:g2', 
        type: 'chat_group' as const, 
        chatGroup: { 
          ...groupB, 
          items: [{ id: 'chat:c1', type: 'chat' as const, chat: { ...chat1, groupId: 'g2' } }], 
        }, 
      },
    ];

    await persistSidebarStructure(newItems);
    const groupNode = mockHierarchy.items.find(i => i.id === 'g2') as HierarchyChatGroupNode;
    expect(groupNode.chat_ids).toContain('c1');
  });

  it('should insert a new chat before the first individual chat', async () => {
    // 1. Setup initial state in MOCK storage
    const initial: SidebarItem[] = [
      { id: 'chat_group:g1', type: 'chat_group', chatGroup: { id: 'g1', name: 'G1', isCollapsed: false, updatedAt: 0, items: [] } },
      { id: 'chat:c1', type: 'chat', chat: { id: 'c1', title: 'C1', updatedAt: 0 } },
    ];
    mockRootItems.push(...initial);
    mockHierarchy.items = [
      { type: 'chat_group', id: 'g1', chat_ids: [] },
      { type: 'chat', id: 'c1' }
    ];
    
    await chatStore.loadChats(); 
    expect(rootItems.value).toHaveLength(2);

    await chatStore.createNewChat();

    expect(mockHierarchy.items).toHaveLength(3);
    expect(mockHierarchy.items[0]?.id).toBe('g1');
    expect(mockHierarchy.items[1]?.type).toBe('chat');
    expect(mockHierarchy.items[2]?.id).toBe('c1'); 
  });

  describe('New Chat Insertion Order', () => {
    it('should insert a new chat AFTER leading groups and BEFORE the first individual chat', async () => {
      const g1 = { id: 'g1', name: 'G1', isCollapsed: false, updatedAt: 0, items: [] };
      const g2 = { id: 'g2', name: 'G2', isCollapsed: false, updatedAt: 0, items: [] };
      const c1 = { id: 'c1', title: 'C1', updatedAt: 0 };
      
      const initial: SidebarItem[] = [
        { id: 'chat_group:g1', type: 'chat_group', chatGroup: g1 },
        { id: 'chat_group:g2', type: 'chat_group', chatGroup: g2 },
        { id: 'chat:c1', type: 'chat', chat: c1 },
      ];
      mockRootItems.push(...initial);
      mockHierarchy.items = [
        { type: 'chat_group', id: 'g1', chat_ids: [] },
        { type: 'chat_group', id: 'g2', chat_ids: [] },
        { type: 'chat', id: 'c1' }
      ];
      await chatStore.loadChats();

      await chatStore.createNewChat();

      expect(mockHierarchy.items).toHaveLength(4);
      expect(mockHierarchy.items[0]?.id).toBe('g1');
      expect(mockHierarchy.items[1]?.id).toBe('g2');
      expect(mockHierarchy.items[2]?.type).toBe('chat');
      expect(mockHierarchy.items[3]?.id).toBe('c1');
    });

    it('should insert at the very top if the first item is a chat', async () => {
      const c1 = { id: 'c1', title: 'C1', updatedAt: 0 };
      const g1 = { id: 'g1', name: 'G1', isCollapsed: false, updatedAt: 0, items: [] };
      
      const initial: SidebarItem[] = [
        { id: 'chat:c1', type: 'chat', chat: c1 },
        { id: 'chat_group:g1', type: 'chat_group', chatGroup: g1 },
      ];
      mockRootItems.push(...initial);
      mockHierarchy.items = [
        { type: 'chat', id: 'c1' },
        { type: 'chat_group', id: 'g1', chat_ids: [] }
      ];
      await chatStore.loadChats();

      await chatStore.createNewChat();

      expect(mockHierarchy.items[0]?.type).toBe('chat');
      expect(mockHierarchy.items[0]?.id).not.toBe('c1');
      expect(mockHierarchy.items[1]?.id).toBe('c1');
    });

    it('should insert at the end if there are only groups', async () => {
      const g1 = { id: 'g1', name: 'G1', isCollapsed: false, updatedAt: 0, items: [] };
      
      const initial: SidebarItem[] = [
        { id: 'chat_group:g1', type: 'chat_group', chatGroup: g1 },
      ];
      mockRootItems.push(...initial);
      mockHierarchy.items = [
        { type: 'chat_group', id: 'g1', chat_ids: [] }
      ];
      await chatStore.loadChats();

      await chatStore.createNewChat();

      expect(mockHierarchy.items).toHaveLength(2);
      expect(mockHierarchy.items[0]?.id).toBe('g1');
      expect(mockHierarchy.items[1]?.type).toBe('chat');
    });
  });

  it('should prepend a new chat group to the rootItems list', async () => {
    const initial: SidebarItem[] = [
      { id: 'chat:c1', type: 'chat', chat: { id: 'c1', title: 'C1', updatedAt: 0 } },
    ];
    mockRootItems.push(...initial);
    mockHierarchy.items = [{ type: 'chat', id: 'c1' }];
    
    const { createChatGroup } = useChat();
    await chatStore.loadChats();

    await createChatGroup('New Group');

    expect(mockHierarchy.items).toHaveLength(2);
    expect(mockHierarchy.items[0]?.type).toBe('chat_group');
    expect(mockHierarchy.items[1]?.id).toBe('c1');
  });

  it('should maintain the correct position after sending a message', async () => {
    const { sendMessage, currentChat } = useChat();
    const c2 = { id: 'c2', title: 'C2', updatedAt: 0 };
    mockHierarchy.items = [
      { type: 'chat_group', id: 'g1', chat_ids: [] },
      { type: 'chat', id: 'c1' },
      { type: 'chat', id: 'c2' }
    ];
    currentChat.value = reactive({ ...c2, root: { items: [] }, createdAt: 0, updatedAt: 0, debugEnabled: false });
    await sendMessage('Hello');
    expect(mockHierarchy.items[2]?.id).toBe('c2');
  });

  it('should generate a chat title based on the first message', async () => {
    const { generateChatTitle, currentChat } = useChat();
    
    const m1: MessageNode = { id: 'm1', role: 'user', content: 'What is the capital of France?', replies: { items: [] }, timestamp: 0 };
    currentChat.value = reactive({
      id: 'title-test-chat',
      title: null,
      root: { items: [m1] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    });

    // Mock the LLM provider for title generation
    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
      onChunk('Paris');
      onChunk(' Title');
    });

    const promise = generateChatTitle(currentChat.value!);
    expect(chatStore.generatingTitle.value).toBe(true);
    await promise;
    expect(chatStore.generatingTitle.value).toBe(false);
    
    expect(currentChat.value.title).toBe('Paris Title');
    expect(storageService.saveChatMeta).toHaveBeenCalled();
  });

  it('should update the title even if it is already set when generateChatTitle is called', async () => {
    const { generateChatTitle, currentChat } = useChat();
    
    const m1: MessageNode = { id: 'm1', role: 'user', content: 'Original message', replies: { items: [] }, timestamp: 0 };
    currentChat.value = reactive({
      id: 'chat-1',
      title: 'Old Title',
      root: { items: [m1] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    });

    mockLlmChat.mockImplementationOnce(async (_msg, _model, _url, onChunk) => {
      onChunk('New Better Title');
    });

    await generateChatTitle(currentChat.value!);
    
    expect(currentChat.value.title).toBe('New Better Title');
    expect(storageService.saveChatMeta).toHaveBeenCalled();
  });

  it('should set currentChat to loaded chat in openChat, or null if not found', async () => {
    const { openChat, currentChat } = useChat();
    const mockChat: Chat = { id: 'found', title: 'Found', root: { items: [] }, createdAt: 0, updatedAt: 0, debugEnabled: false };
    
    vi.mocked(storageService.loadChat).mockResolvedValueOnce(mockChat);
    await openChat('found');
    expect(currentChat.value?.id).toBe('found');

    vi.mocked(storageService.loadChat).mockResolvedValueOnce(null);
    await openChat('missing');
    expect(currentChat.value).toBeNull();
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
      mockRootItems.push({ id: 'chat_group:g1', type: 'chat_group', chatGroup: g1 });
      mockHierarchy.items = [{ type: 'chat_group', id: 'g1', chat_ids: ['c1', 'c2'] }];
      
      // Ensure mock loadChat returns the chat we are about to delete
      vi.mocked(storageService.loadChat).mockImplementation(async (id) => {
        if (id === chat2Id) return { 
          ...c2, 
          root: { items: [] }, 
          createdAt: 0, 
          debugEnabled: false, 
        } as Chat;
        return null;
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
      
      // 4. Simulate Tab B removing it from hierarchy
      await storageService.updateHierarchy((curr) => {
        const g = curr.items[0] as HierarchyChatGroupNode;
        g.chat_ids = ['c1'];
        return curr;
      });
      await chatStore.loadChats();

      // 5. Act: Undo
      if (capturedOnAction) {
        await capturedOnAction();
      } else {
        throw new Error('onAction was not captured. deleteChat might have returned early.');
      }

      // 6. Verify: C2 should be back in its group hierarchy
      const groupInHierarchy = mockHierarchy.items[0] as HierarchyChatGroupNode;
      expect(groupInHierarchy.chat_ids).toContain(chat2Id);
    });
  });
});
