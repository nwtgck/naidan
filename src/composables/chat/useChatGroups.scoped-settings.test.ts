import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toChatGroupId } from '@/models/ids';
import type { ChatGroup } from '@/models/types';

const {
  mockCurrentChatGroupRef,
  mockCurrentChatRef,
  mockLoadData,
  mockUpdateChatGroup,
} = vi.hoisted(() => ({
  mockCurrentChatGroupRef: { value: null as ChatGroup | null },
  mockCurrentChatRef: { value: null },
  mockLoadData: vi.fn().mockResolvedValue(undefined),
  mockUpdateChatGroup: vi.fn(),
}));

vi.mock('@/services/storage', () => ({
  storageService: {
    updateChatGroup: mockUpdateChatGroup,
    updateHierarchy: vi.fn(),
  },
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  currentChatGroupRef: mockCurrentChatGroupRef,
  currentChatRef: mockCurrentChatRef,
  loadData: mockLoadData,
}));

import { useChatGroups } from './useChatGroups';

function createGroup({ rawId = 'group-1' }: { rawId?: string } = {}): ChatGroup {
  return {
    id: toChatGroupId({ raw: rawId }),
    name: 'Group',
    isCollapsed: false,
    items: [],
    updatedAt: 1,
    modelId: 'old-model',
    systemPrompt: {
      behavior: 'append',
      content: 'Keep this prompt',
    },
  };
}

describe('useChatGroups scoped settings updates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrentChatGroupRef.value = null;
    mockCurrentChatRef.value = null;
  });

  it('applies only explicit setting changes to the latest group', async () => {
    let persisted = createGroup();
    mockUpdateChatGroup.mockImplementation(async ({ updater }) => {
      persisted = await updater({ current: persisted });
    });

    const chatGroups = useChatGroups();
    await chatGroups.updateScopedSettings({
      chatGroupId: persisted.id,
      changes: [
        {
          field: 'model_id',
          behavior: 'override',
          value: 'new-model',
        },
      ],
    });

    expect(persisted.modelId).toBe('new-model');
    expect(persisted.systemPrompt).toEqual({
      behavior: 'append',
      content: 'Keep this prompt',
    });
    expect(mockLoadData).toHaveBeenCalledTimes(1);
  });

  it('synchronizes the current group ref with the persisted result', async () => {
    let persisted = createGroup();
    mockCurrentChatGroupRef.value = persisted;
    mockUpdateChatGroup.mockImplementation(async ({ updater }) => {
      persisted = await updater({ current: persisted });
    });

    const chatGroups = useChatGroups();
    await chatGroups.updateScopedSettings({
      chatGroupId: persisted.id,
      changes: [{ field: 'model_id', behavior: 'override', value: 'new-model' }],
    });

    expect(mockCurrentChatGroupRef.value?.modelId).toBe('new-model');
  });

  it('updates updatedAt when only the group name changes', async () => {
    let persisted = createGroup();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1234);
    mockUpdateChatGroup.mockImplementation(async ({ updater }) => {
      persisted = await updater({ current: persisted });
    });

    const chatGroups = useChatGroups();
    await chatGroups.updateChatGroupMetadata({
      chatGroupId: persisted.id,
      updates: { name: 'Renamed' },
    });

    expect(persisted.name).toBe('Renamed');
    expect(persisted.updatedAt).toBe(1234);
    now.mockRestore();
  });

  it('does not reload group state after persistence fails', async () => {
    const group = createGroup();
    mockUpdateChatGroup.mockRejectedValueOnce(new Error('storage failed'));

    const chatGroups = useChatGroups();
    await expect(chatGroups.updateScopedSettings({
      chatGroupId: group.id,
      changes: [
        {
          field: 'model_id',
          behavior: 'override',
          value: 'new-model',
        },
      ],
    })).rejects.toThrow('storage failed');

    expect(mockLoadData).not.toHaveBeenCalled();
  });

  it('serializes updates for one group and continues after a failure', async () => {
    const group = createGroup({ rawId: 'serialized-group' });
    let persisted = group;
    mockUpdateChatGroup
      .mockRejectedValueOnce(new Error('first failed'))
      .mockImplementationOnce(async ({ updater }) => {
        persisted = await updater({ current: persisted });
      });

    const chatGroups = useChatGroups();
    const first = chatGroups.updateScopedSettings({
      chatGroupId: group.id,
      changes: [
        {
          field: 'model_id',
          behavior: 'override',
          value: 'failed-model',
        },
      ],
    });
    const second = chatGroups.updateScopedSettings({
      chatGroupId: group.id,
      changes: [
        {
          field: 'model_id',
          behavior: 'override',
          value: 'successful-model',
        },
      ],
    });

    await expect(first).rejects.toThrow('first failed');
    await expect(second).resolves.toBeUndefined();

    expect(persisted.modelId).toBe('successful-model');
    expect(mockUpdateChatGroup).toHaveBeenCalledTimes(2);
    expect(mockLoadData).toHaveBeenCalledTimes(1);
  });

  it('never_moves_updatedAt_backwards', async () => {
    let persisted = {
      ...createGroup(),
      updatedAt: 5000,
    };
    const now = vi.spyOn(Date, 'now').mockReturnValue(1234);
    mockUpdateChatGroup.mockImplementation(async ({ updater }) => {
      persisted = await updater({ current: persisted });
    });

    const chatGroups = useChatGroups();
    await chatGroups.updateScopedSettings({
      chatGroupId: persisted.id,
      changes: [{ field: 'model_id', behavior: 'override', value: 'new-model' }],
    });

    expect(persisted.updatedAt).toBe(5001);
    now.mockRestore();
  });


  it('does_not_replace_a_newer_current_group_ref_after_reload', async () => {
    let persisted = createGroup();
    mockCurrentChatGroupRef.value = persisted;
    mockUpdateChatGroup.mockImplementation(async ({ updater }) => {
      persisted = await updater({ current: persisted });
    });
    mockLoadData.mockImplementationOnce(async () => {
      mockCurrentChatGroupRef.value = {
        ...persisted,
        modelId: 'newer-external-model',
        updatedAt: persisted.updatedAt + 1,
      };
    });

    const chatGroups = useChatGroups();
    await chatGroups.updateScopedSettings({
      chatGroupId: persisted.id,
      changes: [{ field: 'model_id', behavior: 'override', value: 'saved-model' }],
    });

    expect(mockCurrentChatGroupRef.value?.modelId).toBe('newer-external-model');
  });

});
