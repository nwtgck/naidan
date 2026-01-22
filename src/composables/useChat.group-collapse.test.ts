import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChat } from './useChat';
import { storageService } from '../services/storage';
import { reactive } from 'vue';
import type { SidebarItem, ChatGroup } from '../models/types';

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
    updateChatGroup: vi.fn(),
    listChatGroups: vi.fn().mockResolvedValue([]),
    updateHierarchy: vi.fn().mockImplementation((updater) => updater({ items: [] })),
    getSidebarStructure: vi.fn().mockImplementation(() => Promise.resolve([...mockRootItems])),
    deleteChatGroup: vi.fn(),
    notify: vi.fn(),
  },
}));

vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpointType: 'openai', endpointUrl: 'http://localhost', storageType: 'local', autoTitleEnabled: true, defaultModelId: 'gpt-4' } },
  }),
}));

describe('useChat Group Collapse', () => {
  const chatStore = useChat();
  const { setChatGroupCollapsed, rootItems, currentChatGroup, __testOnly } = chatStore;
  const { __testOnlySetCurrentChatGroup } = __testOnly;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRootItems.length = 0;
    rootItems.value = [];
    __testOnlySetCurrentChatGroup(null);
    
    vi.mocked(storageService.updateChatGroup).mockResolvedValue(undefined);
  });

  it('should collapse/expand a group and update rootItems immediately', async () => {
    const group: ChatGroup = { id: 'g1', name: 'Group 1', isCollapsed: false, items: [], updatedAt: 0 };
    mockRootItems.push({ id: 'chat_group:g1', type: 'chat_group', chatGroup: group });

    await chatStore.loadChats();
    const item = rootItems.value[0] as Extract<SidebarItem, { type: 'chat_group' }>;
    expect(item).toBeDefined();
    expect(item.type).toBe('chat_group');
    expect(item.chatGroup.isCollapsed).toBe(false);

    // Act: Collapse
    await setChatGroupCollapsed({ groupId: 'g1', isCollapsed: true });

    // Assert: Immediate update in rootItems
    const itemAfterCollapse = rootItems.value[0] as Extract<SidebarItem, { type: 'chat_group' }>;
    expect(itemAfterCollapse.type).toBe('chat_group');
    expect(itemAfterCollapse.chatGroup.isCollapsed).toBe(true);

    // Assert: Persisted to storage
    expect(storageService.updateChatGroup).toHaveBeenCalledWith('g1', expect.any(Function));
    
    // Test the updater function passed to storageService
    const calls = vi.mocked(storageService.updateChatGroup).mock.calls;
    expect(calls[0]).toBeDefined();
    const updater = calls[0]![1];
    const updatedGroup = (updater as any)(group) as ChatGroup;
    expect(updatedGroup.isCollapsed).toBe(true);

    // Act: Expand
    await setChatGroupCollapsed({ groupId: 'g1', isCollapsed: false });
    const itemAfterExpand = rootItems.value[0] as Extract<SidebarItem, { type: 'chat_group' }>;
    expect(itemAfterExpand.chatGroup.isCollapsed).toBe(false);
  });

  it('should update currentChatGroup if it matches the group being toggled', async () => {
    const group: ChatGroup = reactive({ id: 'g1', name: 'Group 1', isCollapsed: false, items: [], updatedAt: 0 });
    mockRootItems.push({ id: 'chat_group:g1', type: 'chat_group', chatGroup: group });

    await chatStore.loadChats();
    __testOnlySetCurrentChatGroup(group);

    // Act
    await setChatGroupCollapsed({ groupId: 'g1', isCollapsed: true });

    // Assert
    expect(currentChatGroup.value?.isCollapsed).toBe(true);
  });

  it('should allow toggling a group that is NOT the current group', async () => {
    const group1: ChatGroup = { id: 'g1', name: 'Group 1', isCollapsed: false, items: [], updatedAt: 0 };
    const group2: ChatGroup = { id: 'g2', name: 'Group 2', isCollapsed: false, items: [], updatedAt: 0 };
    
    mockRootItems.push({ id: 'chat_group:g1', type: 'chat_group', chatGroup: group1 });
    mockRootItems.push({ id: 'chat_group:g2', type: 'chat_group', chatGroup: group2 });

    await chatStore.loadChats();
    __testOnlySetCurrentChatGroup(group1);

    // Act: Toggle group 2 while group 1 is selected
    await setChatGroupCollapsed({ groupId: 'g2', isCollapsed: true });

    // Assert: Group 2 is collapsed
    const item2 = rootItems.value[1] as Extract<SidebarItem, { type: 'chat_group' }>;
    expect(item2.type).toBe('chat_group');
    expect(item2.chatGroup.isCollapsed).toBe(true);

    // Assert: Group 1 (current) remains uncollapsed
    expect(currentChatGroup.value?.id).toBe('g1');
    expect(currentChatGroup.value?.isCollapsed).toBe(false);
    const item1 = rootItems.value[0] as Extract<SidebarItem, { type: 'chat_group' }>;
    expect(item1.chatGroup.isCollapsed).toBe(false);
  });

  it('should still update storage and currentChatGroup even if group is not in rootItems', async () => {
    const group: ChatGroup = reactive({ id: 'g1', name: 'Group 1', isCollapsed: false, items: [], updatedAt: 0 });
    // Don't add to mockRootItems
    
    __testOnlySetCurrentChatGroup(group);

    // Act
    await setChatGroupCollapsed({ groupId: 'g1', isCollapsed: true });

    // Assert
    expect(currentChatGroup.value?.isCollapsed).toBe(true);
    expect(storageService.updateChatGroup).toHaveBeenCalledWith('g1', expect.any(Function));
  });
});