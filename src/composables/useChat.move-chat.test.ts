import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChat } from './useChat';
import { reactive } from 'vue';
import type { Chat, ChatGroup, SidebarItem } from '../models/types';

const mockGetSidebarStructure = vi.fn();

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    saveChatMeta: vi.fn(),
    saveChatContent: vi.fn(),
    updateHierarchy: vi.fn().mockImplementation(async (updater) => {
      const chat = useChat();
      const currentH = {
        items: chat.rootItems.value.map(item => {
          if (item.type === 'chat') return { type: 'chat', id: item.chat.id };
          return { type: 'chat_group', id: item.chatGroup.id, chat_ids: item.chatGroup.items.map(i => i.id.replace('chat:', '')) };
        })
      };
      const updated = await updater(currentH as any);
      // Map back to sidebar structure for the test to see the changes after loadChats()
      const newSidebar = updated.items.map((node: any) => {
        if (node.type === 'chat') return { id: `chat:${node.id}`, type: 'chat', chat: { id: node.id, title: 'Chat', updatedAt: 0 } };
        return { 
          id: `chat_group:${node.id}`, 
          type: 'chat_group', 
          chatGroup: { 
            id: node.id, name: 'Group', isCollapsed: false, updatedAt: 0,
            items: node.chat_ids.map((cid: string) => ({ id: `chat:${cid}`, type: 'chat', chat: { id: cid, title: 'Chat', updatedAt: 0 } }))
          } 
        };
      });
      mockGetSidebarStructure.mockResolvedValue(newSidebar);
    }),
    deleteChat: vi.fn(),
    updateChatGroup: vi.fn(),
    listChatGroups: vi.fn().mockResolvedValue([]),
    getSidebarStructure: () => mockGetSidebarStructure(),
    deleteChatGroup: vi.fn(),
  },
}));

vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: {
      value: {
        endpointType: 'openai',
        endpointUrl: 'http://global-url',
        defaultModelId: 'global-model',
      }
    },
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null },
  }),
}));

describe('useChat moveChatToGroup', () => {
  const chatStore = useChat();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('moves a top-level chat to a group (prepends to start)', async () => {
    const group: ChatGroup = {
      id: 'g1',
      name: 'Group 1',
      items: [
        { id: 'chat:existing', type: 'chat', chat: { id: 'existing', title: 'Existing', updatedAt: 0 } }
      ],
      updatedAt: 0,
      isCollapsed: false,
    };
    
    const sidebarItems: SidebarItem[] = [
      { id: 'chat_group:g1', type: 'chat_group', chatGroup: group },
      { id: 'chat:c1', type: 'chat', chat: { id: 'c1', title: 'Chat 1', updatedAt: 0 } }
    ];
    
    mockGetSidebarStructure.mockResolvedValue(sidebarItems);
    await chatStore.loadChats();
    
    // Move chat c1 to group g1
    await chatStore.moveChatToGroup('c1', 'g1');
    
    const rootItems = chatStore.rootItems.value;
    const g1Item = rootItems.find(i => i.id === 'chat_group:g1');
    expect(g1Item?.type).toBe('chat_group');
    const g1Items = (g1Item as any).chatGroup.items;
    
    expect(g1Items).toHaveLength(2);
    expect(g1Items[0]?.chat.id).toBe('c1'); 
    
    expect(rootItems.find(i => i.id === 'chat:c1')).toBeUndefined();
  });

  it('moves a chat from one group to another (prepends to start)', async () => {
    const group1: ChatGroup = {
      id: 'g1',
      name: 'Group 1',
      items: [
        { id: 'chat:c1', type: 'chat', chat: { id: 'c1', title: 'Chat 1', updatedAt: 0 } }
      ],
      updatedAt: 0,
      isCollapsed: false,
    };
    const group2: ChatGroup = {
      id: 'g2',
      name: 'Group 2',
      items: [
        { id: 'chat:existing', type: 'chat', chat: { id: 'existing', title: 'Existing', updatedAt: 0 } }
      ],
      updatedAt: 0,
      isCollapsed: false,
    };
    
    mockGetSidebarStructure.mockResolvedValue([
      { id: 'chat_group:g1', type: 'chat_group', chatGroup: group1 },
      { id: 'chat_group:g2', type: 'chat_group', chatGroup: group2 },
    ]);
    await chatStore.loadChats();
    
    await chatStore.moveChatToGroup('c1', 'g2');
    
    const rootItems = chatStore.rootItems.value;
    const g1Item = rootItems.find(i => i.id === 'chat_group:g1');
    const g2Item = rootItems.find(i => i.id === 'chat_group:g2');
    
    expect((g1Item as any).chatGroup.items).toHaveLength(0);
    expect((g2Item as any).chatGroup.items).toHaveLength(2);
    expect((g2Item as any).chatGroup.items[0]?.chat.id).toBe('c1');
  });

  it('moves a chat from a group to top level', async () => {
    const group1: ChatGroup = {
      id: 'g1',
      name: 'Group 1',
      items: [
        { id: 'chat:c1', type: 'chat', chat: { id: 'c1', title: 'Chat 1', updatedAt: 0 } }
      ],
      updatedAt: 0,
      isCollapsed: false,
    };
    
    mockGetSidebarStructure.mockResolvedValue([
      { id: 'chat_group:g1', type: 'chat_group', chatGroup: group1 },
      { id: 'chat:top', type: 'chat', chat: { id: 'top', title: 'Top Chat', updatedAt: 0 } }
    ]);
    await chatStore.loadChats();
    
    await chatStore.moveChatToGroup('c1', null);
    
    const rootItems = chatStore.rootItems.value;
    const g1Item = rootItems.find(i => i.id === 'chat_group:g1');
    expect((g1Item as any).chatGroup.items).toHaveLength(0);
    
    const c1AtTop = rootItems.find(i => i.id === 'chat:c1');
    expect(c1AtTop).toBeDefined();
    // Should be inserted at the beginning of the individual chats section (index 1)
    expect(rootItems[1]?.id).toBe('chat:c1');
    expect(rootItems[2]?.id).toBe('chat:top');
  });

  it('appends to the end of top level if no individual chats exist', async () => {
    const group1: ChatGroup = {
      id: 'g1', name: 'Group 1', items: [{ id: 'chat:c1', type: 'chat', chat: { id: 'c1', title: 'C1', updatedAt: 0 } }],
      updatedAt: 0, isCollapsed: false,
    };
    mockGetSidebarStructure.mockResolvedValue([{ id: 'chat_group:g1', type: 'chat_group', chatGroup: group1 }]);
    await chatStore.loadChats();
    
    await chatStore.moveChatToGroup('c1', null);
    
    const rootItems = chatStore.rootItems.value;
    expect(rootItems).toHaveLength(2);
    expect(rootItems[1]?.id).toBe('chat:c1'); // Appended since no other chats exist
  });

  it('updates currentChat.groupId if the moved chat is the current one', async () => {
    const chat: Chat = reactive({
      id: 'c1', title: 'C1', groupId: null, root: { items: [] }, createdAt: 0, updatedAt: 0, debugEnabled: false
    });
    chatStore.currentChat.value = chat;
    
    mockGetSidebarStructure.mockResolvedValue([
      { id: 'chat:c1', type: 'chat', chat: { id: 'c1', title: 'C1', updatedAt: 0 } },
      { id: 'chat_group:g1', type: 'chat_group', chatGroup: { id: 'g1', name: 'G1', items: [], updatedAt: 0, isCollapsed: false } }
    ]);
    await chatStore.loadChats();
    
    await chatStore.moveChatToGroup('c1', 'g1');
    
    expect(chat.groupId).toBe('g1');
    expect(chatStore.currentChat.value?.groupId).toBe('g1');
  });
});
