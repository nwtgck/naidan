import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive, ref } from 'vue';
import type { ChatGroup } from '@/01-models/types';
import { toChatGroupId, type ChatGroupId } from '@/01-models/ids';
import { useChatGroupName } from './useChatGroupName';

const chatGroups = ref<ChatGroup[]>([]);
const updateMetadata = vi.fn<(args: { chatGroupId: ChatGroupId, updates: { name: string } }) => Promise<void>>();
let nextId = 0;

vi.mock('../useChatGroups', () => ({ useChatGroups: () => ({ updateChatGroupMetadata: updateMetadata }) }));
vi.mock('./useCurrentChatState', () => ({ useCurrentChatState: () => ({ chatGroups }) }));

function createChatGroup({ name }: { name: string }): ChatGroup {
  const chatGroup = reactive<ChatGroup>({ id: toChatGroupId({ raw: `name-test-${++nextId}` }), name, items: [], isCollapsed: false, updatedAt: 0 });
  chatGroups.value.push(chatGroup);
  return chatGroup;
}

beforeEach(() => {
  chatGroups.value = [];
  updateMetadata.mockReset();
  updateMetadata.mockImplementation(async ({ chatGroupId, updates }) => {
    const current = chatGroups.value.find(chatGroup => chatGroup.id === chatGroupId);
    if (!current) {
      throw new Error('Chat group not found');
    }
    current.name = updates.name;
  });
});

describe('chat group name changes', () => {
  it('prevents overlapping writes and records undo only after a successful save', async () => {
    const chatGroup = createChatGroup({ name: 'Original' });
    const pending = Promise.withResolvers<void>();
    updateMetadata.mockImplementationOnce(async ({ updates }) => {
      await pending.promise;
      chatGroup.name = updates.name;
    });
    const names = useChatGroupName();
    const saving = names.renameChatGroup({ chatGroup, newName: 'Model', source: 'model' });
    expect(chatGroup.name).toBe('Original');
    expect(names.isRenamingChatGroup({ chatGroupId: chatGroup.id })).toBe(true);
    expect(names.canUndoModelName({ chatGroupId: chatGroup.id })).toBe(false);
    expect(await names.renameChatGroup({ chatGroup, newName: 'Other', source: 'manual' })).toBeUndefined();
    expect(updateMetadata).toHaveBeenCalledTimes(1);
    expect(updateMetadata).toHaveBeenCalledWith({ chatGroupId: chatGroup.id, updates: { name: 'Model' } });
    pending.resolve();
    await saving;
    expect(names.canUndoModelName({ chatGroupId: chatGroup.id })).toBe(true);
    expect(names.isRenamingChatGroup({ chatGroupId: chatGroup.id })).toBe(false);
  });

  it('keeps independent undo entries across consumers and restores only the requested group', async () => {
    const first = createChatGroup({ name: 'First' });
    const second = createChatGroup({ name: 'Second' });
    const names = useChatGroupName();
    await names.renameChatGroup({ chatGroup: first, newName: 'Model A', source: 'model' });
    await names.renameChatGroup({ chatGroup: second, newName: 'Model B', source: 'model' });
    const anotherConsumer = useChatGroupName();
    expect(await anotherConsumer.undoModelName({ chatGroupId: first.id, expectedChange: undefined })).toBe(true);
    expect(first.name).toBe('First');
    expect(second.name).toBe('Model B');
    expect(names.canUndoModelName({ chatGroupId: first.id })).toBe(false);
    expect(names.canUndoModelName({ chatGroupId: second.id })).toBe(true);
  });

  it('does not create history on failed saves and permits a retry', async () => {
    const chatGroup = createChatGroup({ name: 'Original' });
    const names = useChatGroupName();
    updateMetadata.mockRejectedValueOnce(new Error('Write failed'));
    await expect(names.renameChatGroup({ chatGroup, newName: 'Model', source: 'model' })).rejects.toThrow('Write failed');
    expect(chatGroup.name).toBe('Original');
    expect(names.canUndoModelName({ chatGroupId: chatGroup.id })).toBe(false);
    expect(names.isRenamingChatGroup({ chatGroupId: chatGroup.id })).toBe(false);
    await names.renameChatGroup({ chatGroup, newName: 'Model', source: 'model' });
    expect(names.canUndoModelName({ chatGroupId: chatGroup.id })).toBe(true);
  });

  it('retains the restoration point after a failed undo', async () => {
    const chatGroup = createChatGroup({ name: 'Original' });
    const names = useChatGroupName();
    await names.renameChatGroup({ chatGroup, newName: 'Model', source: 'model' });
    updateMetadata.mockRejectedValueOnce(new Error('Write failed'));
    await expect(names.undoModelName({ chatGroupId: chatGroup.id, expectedChange: undefined })).rejects.toThrow('Write failed');
    expect(chatGroup.name).toBe('Model');
    expect(names.canUndoModelName({ chatGroupId: chatGroup.id })).toBe(true);
    expect(await names.undoModelName({ chatGroupId: chatGroup.id, expectedChange: undefined })).toBe(true);
    expect(chatGroup.name).toBe('Original');
  });

  it('invalidates history on manual rename and refuses undo after another name change', async () => {
    const chatGroup = createChatGroup({ name: 'Original' });
    const names = useChatGroupName();
    await names.renameChatGroup({ chatGroup, newName: 'Model', source: 'model' });
    await names.renameChatGroup({ chatGroup, newName: 'Manual', source: 'manual' });
    expect(names.canUndoModelName({ chatGroupId: chatGroup.id })).toBe(false);
    await names.renameChatGroup({ chatGroup, newName: 'Another model', source: 'model' });
    chatGroup.name = 'Changed elsewhere';
    updateMetadata.mockClear();
    expect(await names.undoModelName({ chatGroupId: chatGroup.id, expectedChange: undefined })).toBe(false);
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it('does not let a stale notification undo a more recent model-name change', async () => {
    const chatGroup = createChatGroup({ name: 'Original' });
    const names = useChatGroupName();
    const earlier = await names.renameChatGroup({ chatGroup, newName: 'Model A', source: 'model' });
    const latest = await names.renameChatGroup({ chatGroup, newName: 'Model B', source: 'model' });
    updateMetadata.mockClear();
    expect(await names.undoModelName({ chatGroupId: chatGroup.id, expectedChange: earlier })).toBe(false);
    expect(updateMetadata).not.toHaveBeenCalled();
    expect(await names.undoModelName({ chatGroupId: chatGroup.id, expectedChange: latest })).toBe(true);
    expect(chatGroup.name).toBe('Model A');
  });

  it('starts without undo history when the module is loaded in a new session', async () => {
    const chatGroup = createChatGroup({ name: 'Original' });
    const names = useChatGroupName();
    await names.renameChatGroup({ chatGroup, newName: 'Model', source: 'model' });
    vi.resetModules();
    const fresh = await import('./useChatGroupName');
    expect(fresh.useChatGroupName().canUndoModelName({ chatGroupId: chatGroup.id })).toBe(false);
    expect(chatGroup.name).toBe('Model');
  });
});
