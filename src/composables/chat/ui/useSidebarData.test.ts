import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockState,
  mockIsProcessing,
  mockPersistSidebarStructure,
  mockSetChatGroupCollapsed,
  mockCreateChatGroup,
  mockDeleteChatGroup,
  mockCreateNewChat,
  mockOpenChat,
  mockOpenChatGroup,
  mockDeleteChat,
  mockRenameChat,
  mockRenameChatGroup,
  mockDuplicateChatGroup,
} = vi.hoisted(() => ({
  mockState: {
    currentChat: null as any,
    currentChatGroup: null as any,
    sidebarItems: [] as any[],
    chatGroups: [] as any[],
  },
  mockIsProcessing: vi.fn(() => false),
  mockPersistSidebarStructure: vi.fn().mockResolvedValue(undefined),
  mockSetChatGroupCollapsed: vi.fn(),
  mockCreateChatGroup: vi.fn().mockResolvedValue('group-1'),
  mockDeleteChatGroup: vi.fn().mockResolvedValue(undefined),
  mockCreateNewChat: vi.fn().mockResolvedValue(undefined),
  mockOpenChat: vi.fn().mockResolvedValue(null),
  mockOpenChatGroup: vi.fn(),
  mockDeleteChat: vi.fn().mockResolvedValue(undefined),
  mockRenameChat: vi.fn().mockResolvedValue(undefined),
  mockRenameChatGroup: vi.fn().mockResolvedValue(undefined),
  mockDuplicateChatGroup: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  isProcessing: mockIsProcessing,
}));

vi.mock('./useCurrentChatState', () => ({
  useCurrentChatState: () => ({
    currentChat: computed(() => mockState.currentChat),
    currentChatGroup: computed(() => mockState.currentChatGroup),
    TEST_ONLY: {},
  }),
}));

vi.mock('./useChatUiServices', () => ({
  useChatUiServices: () => ({
    derivedState: {
      sidebarItems: computed(() => mockState.sidebarItems),
      chatGroups: computed(() => mockState.chatGroups),
    },
    hierarchyService: {
      persistSidebarStructure: mockPersistSidebarStructure,
      setChatGroupCollapsed: mockSetChatGroupCollapsed,
      createChatGroup: mockCreateChatGroup,
      deleteChatGroup: mockDeleteChatGroup,
      renameChatGroup: mockRenameChatGroup,
      duplicateChatGroup: mockDuplicateChatGroup,
    },
    lifecycleService: {
      createNewChat: mockCreateNewChat,
      deleteChat: mockDeleteChat,
    },
    metadataService: {
      renameChat: mockRenameChat,
    },
    openService: {
      openChat: mockOpenChat,
      openChatGroup: mockOpenChatGroup,
    },
  }),
}));

import { useSidebarData } from './useSidebarData';

describe('useSidebarData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.currentChat = { id: 'chat-1', title: 'Chat 1' };
    mockState.currentChatGroup = { id: 'group-1', name: 'Group 1' };
    mockState.sidebarItems = [];
    mockState.chatGroups = [{ id: 'group-1', name: 'Group 1' }];
  });

  it('exposes sidebar state from the compat store', () => {
    const sidebarData = useSidebarData();

    expect(sidebarData.currentChat.value?.id).toBe('chat-1');
    expect(sidebarData.currentChatGroup.value?.id).toBe('group-1');
    expect(sidebarData.sidebarItems.value).toEqual([]);
    expect(sidebarData.chatGroups.value).toEqual([{ id: 'group-1', name: 'Group 1' }]);
  });

  it('delegates sidebar actions to the compat store', async () => {
    const sidebarData = useSidebarData();

    sidebarData.isProcessing({ chatId: 'chat-1' });
    await sidebarData.persistSidebarStructure({ topLevelItems: [] });
    sidebarData.setChatGroupCollapsed({ groupId: 'group-1', isCollapsed: true });
    await sidebarData.createChatGroup({ name: 'Group 1' });
    await sidebarData.deleteChatGroup({ id: 'group-1' });
    await sidebarData.createNewChat({
      groupId: 'group-1',
      modelId: undefined,
      systemPrompt: undefined,
    });
    await sidebarData.openChat({ id: 'chat-1' });
    sidebarData.openChatGroup({ id: 'group-1' });
    await sidebarData.deleteChat({ id: 'chat-1' });
    await sidebarData.renameChat({ id: 'chat-1', newTitle: 'Renamed' });
    await sidebarData.renameChatGroup({ groupId: 'group-1', newName: 'Renamed Group' });
    await sidebarData.duplicateChatGroup({ groupId: 'group-1' });

    expect(mockIsProcessing).toHaveBeenCalledWith({ chatId: 'chat-1' });
    expect(mockPersistSidebarStructure).toHaveBeenCalledWith({ topLevelItems: [] });
    expect(mockSetChatGroupCollapsed).toHaveBeenCalledWith({ groupId: 'group-1', isCollapsed: true });
    expect(mockCreateChatGroup).toHaveBeenCalledWith({ name: 'Group 1' });
    expect(mockDeleteChatGroup).toHaveBeenCalledWith({ id: 'group-1' });
    expect(mockCreateNewChat).toHaveBeenCalledWith({
      groupId: 'group-1',
      modelId: undefined,
      systemPrompt: undefined,
    });
    expect(mockOpenChat).toHaveBeenCalledWith({ id: 'chat-1', leafId: undefined });
    expect(mockOpenChatGroup).toHaveBeenCalledWith({ id: 'group-1' });
    expect(mockDeleteChat).toHaveBeenCalledWith({ id: 'chat-1' });
    expect(mockRenameChat).toHaveBeenCalledWith({ id: 'chat-1', newTitle: 'Renamed' });
    expect(mockRenameChatGroup).toHaveBeenCalledWith({ groupId: 'group-1', newName: 'Renamed Group' });
    expect(mockDuplicateChatGroup).toHaveBeenCalledWith({ groupId: 'group-1' });
  });
});
