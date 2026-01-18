import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChat } from './useChat';
import { ref } from 'vue';
import { storageService } from '../services/storage';
import type { SidebarItem } from '../models/types';

// Mock storage
vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    getSidebarStructure: vi.fn(),
    saveChat: vi.fn().mockResolvedValue(undefined),
    loadChat: vi.fn(),
    saveChatGroup: vi.fn().mockResolvedValue(undefined),
    listChats: vi.fn().mockResolvedValue([]),
    listChatGroups: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: ref({}),
  }),
}));

describe('useChat Fork Insertion Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const chat = useChat();
    chat.rootItems.value = [];
    chat.currentChat.value = null;
  });

  it('should insert fork at the top of the chat block when not in a chat group', async () => {
    const chat = useChat();
    
    chat.rootItems.value = [
      { id: 'chat_group:1', type: 'chat_group', chatGroup: { id: 'g1', name: 'G1', items: [], isCollapsed: false, updatedAt: 0 } } as SidebarItem,
      { id: 'chat:a', type: 'chat', chat: { id: 'a', title: 'A', updatedAt: 0, groupId: null } } as SidebarItem,
    ];
    
    (storageService.loadChat as any).mockResolvedValue({ 
      id: 'a', title: 'A', root: { items: [{ id: 'm1', role: 'user', content: 'hi', replies: { items: [] } }] },
      updatedAt: 0, createdAt: 0, modelId: '', debugEnabled: false,
      currentLeafId: 'm1'
    });

    chat.currentChat.value = { 
      id: 'a', title: 'A', root: { items: [{ id: 'm1', role: 'user', content: 'hi', replies: { items: [] } }] },
      updatedAt: 0, createdAt: 0, modelId: '', debugEnabled: false,
      currentLeafId: 'm1'
    } as any;

    vi.spyOn(storageService, 'getSidebarStructure').mockImplementation(async () => {
      return chat.rootItems.value;
    });

    await chat.forkChat(chat.currentChat.value!, 'm1');

    // Expected: Chat Group, Fork, Chat A
    expect(chat.rootItems.value[0]?.type).toBe('chat_group');
    const item1 = chat.rootItems.value[1];
    if (item1?.type === 'chat') {
      expect(item1.chat.title).toBe('Fork of A');
    } else {
      throw new Error('Expected chat item at index 1');
    }
    
    const item2 = chat.rootItems.value[2];
    if (item2?.type === 'chat') {
      expect(item2.chat.id).toBe('a');
    } else {
      throw new Error('Expected chat item at index 2');
    }
  });

  it('should insert fork at the top of the chat group when parent is in a chat group', async () => {
    const chat = useChat();
    
    chat.rootItems.value = [
      { 
        id: 'chat_group:1', 
        type: 'chat_group', 
        chatGroup: { 
          id: 'g1', 
          name: 'G1', 
          items: [{ id: 'chat:a', type: 'chat', chat: { id: 'a', title: 'A', updatedAt: 0, groupId: 'g1' } } as SidebarItem], 
          isCollapsed: false, 
          updatedAt: 0 
        } 
      } as SidebarItem,
    ];
    
    (storageService.loadChat as any).mockResolvedValue({ 
      id: 'a', title: 'A', groupId: 'g1',
      root: { items: [{ id: 'm1', role: 'user', content: 'hi', replies: { items: [] } }] },
      updatedAt: 0, createdAt: 0, modelId: '', debugEnabled: false,
      currentLeafId: 'm1'
    });

    chat.currentChat.value = { 
      id: 'a', title: 'A', groupId: 'g1', 
      root: { items: [{ id: 'm1', role: 'user', content: 'hi', replies: { items: [] } }] },
      updatedAt: 0, createdAt: 0, modelId: '', debugEnabled: false,
      currentLeafId: 'm1'
    } as any;

    vi.spyOn(storageService, 'getSidebarStructure').mockImplementation(async () => {
      return chat.rootItems.value;
    });

    await chat.forkChat(chat.currentChat.value!, 'm1');

    // Expected: Chat Group with [Fork, Chat A]
    const groupItem = chat.rootItems.value[0];
    if (groupItem?.type === 'chat_group') {
      const firstChat = groupItem.chatGroup.items[0];
      if (firstChat?.type === 'chat') {
        expect(firstChat.chat.title).toBe('Fork of A');
      } else {
        throw new Error('Expected chat item at chat group index 0');
      }
      
      const secondChat = groupItem.chatGroup.items[1];
      if (secondChat?.type === 'chat') {
        expect(secondChat.chat.id).toBe('a');
      } else {
        throw new Error('Expected chat item at chat group index 1');
      }
    } else {
      throw new Error('Expected chat group at index 0');
    }
  });
});
