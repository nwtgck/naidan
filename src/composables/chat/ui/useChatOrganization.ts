import { toRaw } from 'vue';
import { ensureStrings } from '@/strings';
import { generateId } from '@/01-models/id';
import type { ChatGroupId, ChatId } from '@/01-models/ids';
import { cloneToolConfigs } from '@/features/tools/tool-config';
import type { ChatGroup, HierarchyChatGroupNode, HierarchyNode } from '@/01-models/types';
import { storageService } from '@/00-storage/service';
import { useSettings } from '@/composables/useSettings';
import {
  currentChatGroupRef,
  currentChatRef,
  loadData,
} from '@/composables/chat/global/chat-core-singletons';
import { useChatLifecycle } from './useChatLifecycle';
import { useCurrentChatState } from './useCurrentChatState';

export type ChatOrganizationAdapter = {
  createChatGroup({
    name,
    options,
  }: {
    name: string,
    options?: Partial<Pick<ChatGroup, 'modelId' | 'systemPrompt' | 'lmParameters'>>,
  }): Promise<ChatGroupId>,

  deleteChatGroup({
    id,
  }: {
    id: ChatGroupId,
  }): Promise<void>,

  duplicateChatGroup({
    groupId,
  }: {
    groupId: ChatGroupId,
  }): Promise<ChatGroupId | undefined>,

  renameChatGroup({
    groupId,
    newName,
  }: {
    groupId: ChatGroupId,
    newName: string,
  }): Promise<void>,

  updateChatGroupMetadata({
    id,
    updates,
  }: {
    id: ChatGroupId,
    updates: Partial<Pick<ChatGroup, 'name' | 'endpoint' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>,
  }): Promise<void>,

  moveChatToGroup({
    chatId,
    targetGroupId,
  }: {
    chatId: ChatId,
    targetGroupId: ChatGroupId | null,
  }): Promise<void>,

  reorderSidebarChatAfterSend({
    chatId,
  }: {
    chatId: ChatId,
  }): Promise<void>,

  TEST_ONLY: Record<never, never>,
};

export function useChatOrganization(): ChatOrganizationAdapter {
  const { settings } = useSettings();
  const { chatGroups } = useCurrentChatState();
  const chatLifecycle = useChatLifecycle();

  async function createChatGroup({
    name,
    options,
  }: {
    name: string,
    options?: Partial<Pick<ChatGroup, 'modelId' | 'systemPrompt' | 'lmParameters'>>,
  }): Promise<ChatGroupId> {
    const id = generateId<ChatGroupId>();
    const newGroup: ChatGroup = {
      id,
      name,
      updatedAt: Date.now(),
      isCollapsed: false,
      items: [],
      ...(options ?? {}),
    };

    await storageService.updateChatGroup({ id: id, updater: () => newGroup });
    await storageService.updateHierarchy({ updater: ({ current }) => {
      current.items.unshift({ type: 'chat_group', id, chat_ids: [] });
      return current;
    } });
    await loadData();
    return id;
  }

  async function deleteChatGroup({
    id,
  }: {
    id: ChatGroupId,
  }): Promise<void> {
    const group = chatGroups.value.find((item) => item.id === id);
    if (group === undefined) {
      return;
    }

    for (const item of [...group.items]) {
      await chatLifecycle.deleteChat({
        id: item.chat.id,
        injectAddToast: () => '',
      });
    }

    if (currentChatGroupRef.value?.id === id) {
      currentChatGroupRef.value = null;
    }

    await storageService.deleteChatGroup({ id });
    await storageService.updateHierarchy({ updater: ({ current }) => {
      current.items = current.items.filter((item) => {
        switch (item.type) {
        case 'chat_group':
          return item.id !== id;
        case 'chat':
          return true;
        default: {
          const _ex: never = item;
          throw new Error(`Unhandled hierarchy node type: ${_ex}`);
        }
        }
      });
      return current;
    } });
    await loadData();
  }

  async function duplicateChatGroup({
    groupId,
  }: {
    groupId: ChatGroupId,
  }): Promise<ChatGroupId | undefined> {
    const originalGroup = chatGroups.value.find((group) => group.id === groupId);
    if (originalGroup === undefined) {
      return undefined;
    }

    const newId = generateId<ChatGroupId>();
    const newGroup: ChatGroup = {
      ...toRaw(originalGroup),
      id: newId,
      name: await ensureStrings.useChatOrganization__copy_of_chat_group({ groupName: originalGroup.name }),
      items: [],
      toolConfigs: cloneToolConfigs({ toolConfigs: originalGroup.toolConfigs }),
      updatedAt: Date.now(),
      isCollapsed: false,
    };

    await storageService.updateChatGroup({ id: newId, updater: () => newGroup });
    await storageService.updateHierarchy({ updater: ({ current }) => {
      const originalIndex = current.items.findIndex((item) => item.type === 'chat_group' && item.id === groupId);
      const newNode: HierarchyNode = { type: 'chat_group', id: newId, chat_ids: [] };
      if (originalIndex !== -1) {
        current.items.splice(originalIndex + 1, 0, newNode);
      } else {
        current.items.unshift(newNode);
      }
      return current;
    } });
    await loadData();
    return newId;
  }

  async function renameChatGroup({
    groupId,
    newName,
  }: {
    groupId: ChatGroupId,
    newName: string,
  }): Promise<void> {
    if (currentChatGroupRef.value?.id === groupId) {
      currentChatGroupRef.value.name = newName;
      currentChatGroupRef.value.updatedAt = Date.now();
    }

    await storageService.updateChatGroup({ id: groupId, updater: ({ current }) => {
      if (current === null) {
        throw new Error('Chat group not found');
      }
      current.name = newName;
      current.updatedAt = Date.now();
      return current;
    } });
    await loadData();
  }

  async function updateChatGroupMetadata({
    id,
    updates,
  }: {
    id: ChatGroupId,
    updates: Partial<Pick<ChatGroup, 'name' | 'endpoint' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>,
  }): Promise<void> {
    if (currentChatGroupRef.value?.id === id) {
      Object.assign(currentChatGroupRef.value, updates);
      currentChatGroupRef.value.updatedAt = Date.now();
    }

    await storageService.updateChatGroup({ id: id, updater: ({ current }) => {
      if (current === null) {
        throw new Error('Chat group not found');
      }
      return { ...current, ...updates, updatedAt: Date.now() };
    } });
    await loadData();
  }

  async function moveChatToGroup({
    chatId,
    targetGroupId,
  }: {
    chatId: ChatId,
    targetGroupId: ChatGroupId | null,
  }): Promise<void> {
    if (currentChatRef.value?.id === chatId) {
      currentChatRef.value.groupId = targetGroupId;
      currentChatRef.value.updatedAt = Date.now();
    }

    await storageService.updateHierarchy({ updater: ({ current }) => {
      let detachedChatId: ChatId | undefined;

      current.items = current.items.filter((item) => {
        switch (item.type) {
        case 'chat':
          if (item.id === chatId) {
            detachedChatId = item.id;
            return false;
          }
          return true;
        case 'chat_group': {
          const chatIndex = item.chat_ids.indexOf(chatId);
          if (chatIndex !== -1) {
            detachedChatId = item.chat_ids[chatIndex];
            item.chat_ids.splice(chatIndex, 1);
          }
          return true;
        }
        default: {
          const _ex: never = item;
          throw new Error(`Unhandled hierarchy node type: ${_ex}`);
        }
        }
      });

      if (detachedChatId === undefined) {
        return current;
      }

      if (targetGroupId === null) {
        insertTopLevelChat({
          current,
          node: { type: 'chat', id: detachedChatId },
        });
        return current;
      }

      const targetGroup = current.items.find((item) => item.type === 'chat_group' && item.id === targetGroupId) as HierarchyChatGroupNode | undefined;
      if (targetGroup !== undefined) {
        targetGroup.chat_ids.unshift(detachedChatId);
      } else {
        insertTopLevelChat({
          current,
          node: { type: 'chat', id: detachedChatId },
        });
      }
      return current;
    } });
    await loadData();
  }

  async function reorderSidebarChatAfterSend({
    chatId,
  }: {
    chatId: ChatId,
  }): Promise<void> {
    const reorderSetting = settings.value.experimental?.sidebarSendMessageReorder ?? 'disabled';
    switch (reorderSetting) {
    case 'disabled':
      return;
    case 'move_sent_chat':
      break;
    default: {
      const _ex: never = reorderSetting;
      throw new Error(`Unhandled sidebar send reorder setting: ${_ex}`);
    }
    }

    await storageService.updateHierarchy({ updater: ({ current }) => {
      let chatNode: HierarchyNode | undefined;
      let sourceGroup: HierarchyChatGroupNode | undefined;

      current.items = current.items.filter((item) => {
        switch (item.type) {
        case 'chat':
          if (item.id === chatId) {
            chatNode = item;
            return false;
          }
          return true;
        case 'chat_group': {
          const chatIndex = item.chat_ids.indexOf(chatId);
          if (chatIndex !== -1) {
            sourceGroup = item;
            item.chat_ids.splice(chatIndex, 1);
          }
          return true;
        }
        default: {
          const _ex: never = item;
          throw new Error(`Unhandled hierarchy node type: ${_ex}`);
        }
        }
      });

      if (sourceGroup !== undefined) {
        sourceGroup.chat_ids.unshift(chatId);
        return current;
      }

      const node = chatNode ?? { type: 'chat', id: chatId };
      insertTopLevelChat({
        current,
        node,
      });
      return current;
    } });
    await loadData();
  }

  return {
    createChatGroup,
    deleteChatGroup,
    duplicateChatGroup,
    renameChatGroup,
    updateChatGroupMetadata,
    moveChatToGroup,
    reorderSidebarChatAfterSend,
    TEST_ONLY: {},
  };
}

function insertTopLevelChat({
  current,
  node,
}: {
  current: import('@/01-models/types').Hierarchy,
  node: HierarchyNode,
}) {
  const firstChatIndex = current.items.findIndex((item) => item.type === 'chat');
  const insertIndex = firstChatIndex !== -1 ? firstChatIndex : current.items.length;
  current.items.splice(insertIndex, 0, node);
}
