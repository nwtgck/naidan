import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChat } from './useChat';
import { storageService } from '../services/storage';
import { reactive } from 'vue';

vi.mock('../services/storage', () => ({
  storageService: {
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    updateChatGroup: vi.fn().mockResolvedValue(undefined),
    updateHierarchy: vi.fn().mockImplementation((updater) => {
      const curr = { items: [] };
      updater(curr);
      return Promise.resolve();
    }),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    listChatGroups: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: reactive({ endpointType: 'openai', autoTitleEnabled: true }),
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
      systemPrompt: { behavior: 'override', content: 'You are a bot' }
    };

    // Inject mock data into rootItems (which is internal but exposed via sidebarItems/rootItems in useChat)
    rootItems.value = [{ id: 'g1', type: 'chat_group', chatGroup: originalGroup as any }];

    const newGroupId = await duplicateChatGroup('g1');

    expect(newGroupId).toBeDefined();
    expect(storageService.updateChatGroup).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function)
    );

    // Check the new group content via the updater passed to updateChatGroup
    const updater = (storageService.updateChatGroup as any).mock.calls[0][1];
    const newGroup = updater(null);

    expect(newGroup.name).toBe('Copy of Original');
    expect(newGroup.modelId).toBe('gpt-4');
    expect(newGroup.systemPrompt).toEqual({ behavior: 'override', content: 'You are a bot' });
    expect(newGroup.items).toEqual([]); // Should be empty
    expect(newGroup.id).not.toBe('g1');
  });

  it('should insert the new group into hierarchy after the original', async () => {
    const { duplicateChatGroup, rootItems } = useChat();

    const originalGroup = { id: 'g1', name: 'Original', items: [], updatedAt: 123, isCollapsed: false };
    rootItems.value = [{ id: 'g1', type: 'chat_group', chatGroup: originalGroup as any }];

    let capturedHierarchy: any = { items: [{ type: 'chat_group', id: 'g1', chat_ids: [] }] };
    vi.mocked(storageService.updateHierarchy).mockImplementationOnce(async (updater) => {
      capturedHierarchy = updater(capturedHierarchy);
    });

    await duplicateChatGroup('g1');

    expect(capturedHierarchy.items).toHaveLength(2);
    expect(capturedHierarchy.items[0].id).toBe('g1');
    expect(capturedHierarchy.items[1].type).toBe('chat_group');
    expect(capturedHierarchy.items[1].id).not.toBe('g1');
  });
});
