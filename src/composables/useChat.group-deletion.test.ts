import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChat } from './useChat';
import { storageService } from '../services/storage';
import { reactive } from 'vue';
import type { Chat, SidebarItem, ChatGroup } from '../models/types';

// Mock storage service state
const mockRootItems: SidebarItem[] = [];

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    deleteChat: vi.fn(),
    saveChatGroup: vi.fn(),
    listChatGroups: vi.fn().mockResolvedValue([]),
    getSidebarStructure: vi.fn().mockImplementation(() => Promise.resolve([...mockRootItems])),
    deleteChatGroup: vi.fn(),
  },
}));

vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpointType: 'openai', endpointUrl: 'http://localhost', storageType: 'local', autoTitleEnabled: true, defaultModelId: 'gpt-4' } },
  }),
}));

vi.mock('./useToast', () => ({
  useToast: () => ({
    addToast: vi.fn(),
  }),
}));

describe('useChat Group Deletion Logic', () => {
  const chatStore = useChat();
  const { deleteChatGroup, rootItems, currentChat } = chatStore;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRootItems.length = 0;
    rootItems.value = [];
    currentChat.value = null;
  });

  it('should delete a chat group and all its contained chats', async () => {
    // Setup: Group with 2 chats
    const group: ChatGroup = { id: 'g1', name: 'Group 1', isCollapsed: false, items: [], updatedAt: 0 };
    const chat1: Chat = { id: 'c1', title: 'Chat 1', groupId: 'g1', root: { items: [] }, createdAt: 0, updatedAt: 0, debugEnabled: false };
    const chat2: Chat = { id: 'c2', title: 'Chat 2', groupId: 'g1', root: { items: [] }, createdAt: 0, updatedAt: 0, debugEnabled: false };
    
    // Populate mock storage structure
    const sidebarItem1: SidebarItem = { id: 'chat:c1', type: 'chat', chat: chat1 };
    const sidebarItem2: SidebarItem = { id: 'chat:c2', type: 'chat', chat: chat2 };
    group.items = [sidebarItem1, sidebarItem2];
    
    const groupItem: SidebarItem = { id: 'chat_group:g1', type: 'chat_group', chatGroup: group };
    mockRootItems.push(groupItem);
    
    // Mock loadChat behavior for deleteChat's verification steps
    vi.mocked(storageService.loadChat).mockImplementation(async (id) => {
      if (id === 'c1') return chat1;
      if (id === 'c2') return chat2;
      return null;
    });

    await chatStore.loadChats();
    expect(rootItems.value).toHaveLength(1);

    // Act
    await deleteChatGroup('g1');

    // Assert
    expect(vi.mocked(storageService.deleteChat)).toHaveBeenCalledWith('c1');
    expect(vi.mocked(storageService.deleteChat)).toHaveBeenCalledWith('c2');
    expect(vi.mocked(storageService.deleteChatGroup)).toHaveBeenCalledWith('g1');
  });

  it('should NOT delete chats that are outside the group', async () => {
    // Setup: Group with 1 chat, and 1 independent chat
    const group: ChatGroup = { id: 'g1', name: 'Group 1', isCollapsed: false, items: [], updatedAt: 0 };
    const chatInGroup: Chat = { id: 'c_in', title: 'Inside', groupId: 'g1', root: { items: [] }, createdAt: 0, updatedAt: 0, debugEnabled: false };
    const chatOut: Chat = { id: 'c_out', title: 'Outside', groupId: null, root: { items: [] }, createdAt: 0, updatedAt: 0, debugEnabled: false };
    
    group.items = [{ id: 'chat:c_in', type: 'chat', chat: chatInGroup }];
    mockRootItems.push({ id: 'chat_group:g1', type: 'chat_group', chatGroup: group });
    mockRootItems.push({ id: 'chat:c_out', type: 'chat', chat: chatOut });

    vi.mocked(storageService.loadChat).mockImplementation(async (id) => {
      if (id === 'c_in') return chatInGroup;
      if (id === 'c_out') return chatOut;
      return null;
    });

    await chatStore.loadChats();

    // Act
    await deleteChatGroup('g1');

    // Assert
    expect(vi.mocked(storageService.deleteChat)).toHaveBeenCalledWith('c_in');
    expect(vi.mocked(storageService.deleteChat)).not.toHaveBeenCalledWith('c_out');
    expect(vi.mocked(storageService.deleteChatGroup)).toHaveBeenCalledWith('g1');
  });

  it('should clear currentChat if the active chat was in the deleted group', async () => {
    const group: ChatGroup = { id: 'g1', name: 'Group 1', isCollapsed: false, items: [], updatedAt: 0 };
    const chat1: Chat = { id: 'c1', title: 'Chat 1', groupId: 'g1', root: { items: [] }, createdAt: 0, updatedAt: 0, debugEnabled: false };
    
    group.items = [{ id: 'chat:c1', type: 'chat', chat: chat1 }];
    mockRootItems.push({ id: 'chat_group:g1', type: 'chat_group', chatGroup: group });

    vi.mocked(storageService.loadChat).mockResolvedValue(chat1);

    await chatStore.loadChats();
    currentChat.value = reactive(chat1);

    await deleteChatGroup('g1');

    expect(currentChat.value).toBeNull();
  });

  it('should NOT clear currentChat if the active chat was outside the deleted group', async () => {
    const group: ChatGroup = { id: 'g1', name: 'Group 1', isCollapsed: false, items: [], updatedAt: 0 };
    const chatOut: Chat = { id: 'c_out', title: 'Outside', groupId: null, root: { items: [] }, createdAt: 0, updatedAt: 0, debugEnabled: false };
    
    mockRootItems.push({ id: 'chat_group:g1', type: 'chat_group', chatGroup: group });
    mockRootItems.push({ id: 'chat:c_out', type: 'chat', chat: chatOut });

    vi.mocked(storageService.loadChat).mockResolvedValue(chatOut);

    await chatStore.loadChats();
    currentChat.value = reactive(chatOut);

    await deleteChatGroup('g1');

    expect(currentChat.value).not.toBeNull();
    expect(currentChat.value?.id).toBe('c_out');
  });
});
