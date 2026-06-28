import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChat } from './useChat';
import { storageService } from '@/00-storage/service';
import { reactive } from 'vue';
import { toChatGroupId } from '@/01-models/ids';

vi.mock('../00-storage/service', () => ({
  storageService: {
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    updateChatGroup: vi.fn().mockResolvedValue(undefined),
    updateHierarchy: vi.fn().mockImplementation(({ updater }) => {
      const curr = { items: [] };
      updater({ current: curr });
      return Promise.resolve();
    }),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    listChatGroups: vi.fn().mockResolvedValue([]),
    loadChatGroup: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: reactive({ endpoint: { type: 'openai', url: '' }, autoTitleEnabled: true }),
  }),
}));

vi.mock('./useGlobalEvents', () => ({
  useGlobalEvents: () => ({
    addErrorEvent: vi.fn(),
  }),
}));

describe('useChat.duplicateChatGroup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a new group with copied settings and modified name', async () => {
    const { duplicateChatGroup, rootItems } = useChat();

    // Mock existing groups
    const originalGroup = {
      id: 'g1',
      name: 'Original',
      items: [{ id: 'c1', type: 'chat', chat: { id: 'c1', title: 'Chat 1' } }],
      updatedAt: 123,
      isCollapsed: false,
      modelId: 'gpt-4',
      systemPrompt: { behavior: 'override', content: 'You are a bot' },
      toolConfigs: [{
        key: 'builtin.wesh',
        status: 'enabled',
        naidanSysfs: { accessScope: 'main_chats' },
      }],
    };

    // Inject mock data into rootItems (which is internal but exposed via sidebarItems/rootItems in useChat)
    rootItems.value = [{ id: 'g1', type: 'chat_group', chatGroup: originalGroup as any }];

    const newGroupId = await duplicateChatGroup({ groupId: toChatGroupId({ raw: 'g1' }) });

    expect(newGroupId).toBeDefined();
    expect(storageService.updateChatGroup).toHaveBeenCalledWith({ id: expect.any(String), updater: expect.any(Function) });

    // Check the new group content via the updater passed to updateChatGroup
    const updater = (storageService.updateChatGroup as any).mock.calls[0][0].updater;
    const newGroup = updater({ current: null });

    expect(newGroup.name).toBe('Copy of Original');
    expect(newGroup.modelId).toBe('gpt-4');
    expect(newGroup.systemPrompt).toEqual({ behavior: 'override', content: 'You are a bot' });
    expect(newGroup.toolConfigs).toEqual(originalGroup.toolConfigs);
    expect(newGroup.toolConfigs).not.toBe(originalGroup.toolConfigs);
    expect(newGroup.toolConfigs[0]).not.toBe(originalGroup.toolConfigs[0]);
    expect(newGroup.toolConfigs[0].naidanSysfs).not.toBe(originalGroup.toolConfigs[0]!.naidanSysfs);
    expect(newGroup.items).toEqual([]); // Should be empty
    expect(newGroup.id).not.toBe('g1');
  });

  it('should insert the new group into hierarchy after the original', async () => {
    const { duplicateChatGroup, rootItems } = useChat();

    const originalGroup = { id: 'g1', name: 'Original', items: [], updatedAt: 123, isCollapsed: false };
    rootItems.value = [{ id: 'g1', type: 'chat_group', chatGroup: originalGroup as any }];

    let capturedHierarchy: any = { items: [{ type: 'chat_group', id: 'g1', chat_ids: [] }] };
    vi.mocked(storageService.updateHierarchy).mockImplementationOnce(async ({ updater }) => {
      capturedHierarchy = updater({ current: capturedHierarchy });
    });

    await duplicateChatGroup({ groupId: toChatGroupId({ raw: 'g1' }) });

    expect(capturedHierarchy.items).toHaveLength(2);
    expect(capturedHierarchy.items[0].id).toBe('g1');
    expect(capturedHierarchy.items[1].type).toBe('chat_group');
    expect(capturedHierarchy.items[1].id).not.toBe('g1');
  });
});
