import { toChatGroupId, toChatId } from '@/01-models/ids';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAddToast,
  mockEnsureChatWorkspaceMounted,
  mockGetEffectiveToolConfigsForChat,
  mockLoadData,
  mockRegisterLiveInstance,
  mockSetCurrentChatId,
  mockUpdateChatContent,
  mockUpdateChatMeta,
  mockUpdateHierarchy,
  mockCreatingChat,
  mockCurrentChatGroupRef,
  mockCurrentChatRef,
} = vi.hoisted(() => ({
  mockAddToast: vi.fn(),
  mockEnsureChatWorkspaceMounted: vi.fn().mockResolvedValue(undefined),
  mockGetEffectiveToolConfigsForChat: vi.fn(),
  mockLoadData: vi.fn().mockResolvedValue(undefined),
  mockRegisterLiveInstance: vi.fn(),
  mockSetCurrentChatId: vi.fn(),
  mockUpdateChatContent: vi.fn().mockResolvedValue(undefined),
  mockUpdateChatMeta: vi.fn().mockResolvedValue(undefined),
  mockUpdateHierarchy: vi.fn(),
  mockCreatingChat: { value: false },
  mockCurrentChatGroupRef: { value: null },
  mockCurrentChatRef: { value: null },
}));

vi.mock('@/00-storage/service', () => ({
  storageService: {
    updateHierarchy: mockUpdateHierarchy,
    loadChat: vi.fn().mockResolvedValue(null),
    deleteChat: vi.fn().mockResolvedValue(undefined),
    listChats: vi.fn().mockResolvedValue([]),
    listChatGroups: vi.fn().mockResolvedValue([]),
    deleteChatGroup: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/features/tools/composables/useChatTools', () => ({
  getEffectiveToolConfigsForChat: mockGetEffectiveToolConfigsForChat,
  useChatTools: () => ({
    setCurrentChatId: mockSetCurrentChatId,
  }),
}));

vi.mock('@/features/tools/wesh/chat-workspace', () => ({
  ensureChatWorkspaceMounted: mockEnsureChatWorkspaceMounted,
}));

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    addToast: mockAddToast,
  }),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  chatRuntimeStore: {
    activeGenerations: new Map(),
    clearActiveGenerations: vi.fn(),
    clearActiveTaskCounts: vi.fn(),
    clearTasksForChat: vi.fn(),
    getActiveGeneration: vi.fn(),
    deleteActiveGeneration: vi.fn(),
  },
  clearChatTmpDirectories: vi.fn(),
  creatingChat: mockCreatingChat,
  currentChatGroupRef: mockCurrentChatGroupRef,
  currentChatRef: mockCurrentChatRef,
  deleteChatTmpDirectory: vi.fn(),
  liveChatRegistry: new Map(),
  loadData: mockLoadData,
  registerLiveInstance: mockRegisterLiveInstance,
  updateChatContent: mockUpdateChatContent,
  updateChatMeta: mockUpdateChatMeta,
}));

vi.mock('./useChatNavigation', () => ({
  useChatNavigation: () => ({
    openChat: vi.fn(),
  }),
}));

import { useChatLifecycle } from './useChatLifecycle';

describe('useChatLifecycle', () => {
  const groupId = toChatGroupId({ raw: 'workspace-group' });
  const existingChatId = toChatId({ raw: 'existing-chat' });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreatingChat.value = false;
    mockCurrentChatGroupRef.value = null;
    mockCurrentChatRef.value = null;
    mockEnsureChatWorkspaceMounted.mockResolvedValue(undefined);
    mockGetEffectiveToolConfigsForChat.mockReturnValue([{
      key: 'builtin.wesh',
      status: 'enabled',
      naidanSysfs: { accessScope: 'none' },
    }]);
    mockUpdateHierarchy.mockImplementation(async ({ updater }) => {
      const current = {
        items: [{
          type: 'chat_group',
          id: groupId,
          chat_ids: [existingChatId],
        }],
      };
      await updater({ current });
    });
  });

  it('provisions a workspace only for the newly created chat when Shell Execute is effectively enabled', async () => {
    const lifecycle = useChatLifecycle();

    const created = await lifecycle.createNewChat({
      groupId,
      modelId: undefined,
      systemPrompt: undefined,
    });

    expect(created).not.toBeNull();
    expect(created?.groupId).toBe(groupId);
    expect(mockGetEffectiveToolConfigsForChat).toHaveBeenCalledWith({ chat: created });
    expect(mockEnsureChatWorkspaceMounted).toHaveBeenCalledTimes(1);
    expect(mockEnsureChatWorkspaceMounted).toHaveBeenCalledWith({ chat: created });
    expect(mockEnsureChatWorkspaceMounted).not.toHaveBeenCalledWith(expect.objectContaining({
      chat: expect.objectContaining({ id: existingChatId }),
    }));
  });

  it('does not provision a workspace when Shell Execute is not effectively enabled', async () => {
    mockGetEffectiveToolConfigsForChat.mockReturnValue([]);
    const lifecycle = useChatLifecycle();

    const created = await lifecycle.createNewChat({
      groupId,
      modelId: undefined,
      systemPrompt: undefined,
    });

    expect(created).not.toBeNull();
    expect(mockEnsureChatWorkspaceMounted).not.toHaveBeenCalled();
  });
});
