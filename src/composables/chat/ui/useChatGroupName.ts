import { shallowReactive } from 'vue';
import type { ChatGroupId } from '@/01-models/ids';
import type { ChatGroup } from '@/01-models/types';
import { useChatGroups } from '@/composables/chat/useChatGroups';
import { useCurrentChatState } from './useCurrentChatState';

export type ChatGroupNameChange = { previousName: string, newName: string };

// Undo history belongs to this session and is never persisted with chat groups.
const undoEntries = shallowReactive(new Map<ChatGroupId, ChatGroupNameChange>());
const pendingIds = shallowReactive(new Set<ChatGroupId>());

export function useChatGroupName() {
  const { updateChatGroupMetadata } = useChatGroups();
  const { chatGroups } = useCurrentChatState();

  function getUndoEntry({ chatGroupId }: { chatGroupId: ChatGroupId }) {
    const entry = undoEntries.get(chatGroupId);
    const current = chatGroups.value.find(chatGroup => chatGroup.id === chatGroupId);
    return entry && current?.name === entry.newName ? entry : undefined;
  }

  function isRenamingChatGroup({ chatGroupId }: { chatGroupId: ChatGroupId }) {
    return pendingIds.has(chatGroupId);
  }

  function canUndoModelName({ chatGroupId }: { chatGroupId: ChatGroupId }) {
    return !pendingIds.has(chatGroupId) && getUndoEntry({ chatGroupId }) !== undefined;
  }

  async function renameChatGroup({ chatGroup, newName, source }: { chatGroup: Pick<ChatGroup, 'id' | 'name'>, newName: string, source: 'manual' | 'model' }): Promise<ChatGroupNameChange | undefined> {
    const chatGroupId = chatGroup.id;
    if (pendingIds.has(chatGroupId) || newName === chatGroup.name) {
      return undefined;
    }
    const previousName = chatGroup.name;
    const change = { previousName, newName };
    pendingIds.add(chatGroupId);
    try {
      await updateChatGroupMetadata({ chatGroupId, updates: { name: newName } });
      switch (source) {
      case 'manual':
        undoEntries.delete(chatGroupId);
        break;
      case 'model':
        undoEntries.set(chatGroupId, change);
        break;
      default: {
        const _ex: never = source;
        throw new Error(`Unhandled rename source: ${_ex}`);
      }
      }
      return change;
    } finally {
      pendingIds.delete(chatGroupId);
    }
  }

  async function undoModelName({ chatGroupId, expectedChange }: { chatGroupId: ChatGroupId, expectedChange: ChatGroupNameChange | undefined }): Promise<boolean> {
    const entry = getUndoEntry({ chatGroupId });
    if (!entry || pendingIds.has(chatGroupId) || (expectedChange !== undefined && entry !== expectedChange)) {
      return false;
    }
    pendingIds.add(chatGroupId);
    try {
      await updateChatGroupMetadata({ chatGroupId, updates: { name: entry.previousName } });
      undoEntries.delete(chatGroupId);
      return true;
    } finally {
      pendingIds.delete(chatGroupId);
    }
  }

  return {
    renameChatGroup,
    undoModelName,
    canUndoModelName,
    isRenamingChatGroup,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

export const TEST_ONLY = {
};
