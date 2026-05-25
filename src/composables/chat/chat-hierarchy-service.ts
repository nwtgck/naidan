import { triggerRef, toRaw, type Ref } from 'vue';
import { generateId } from '@/utils/id';
import type { Chat, ChatGroup, Hierarchy, HierarchyChatGroupNode, HierarchyNode, SidebarItem } from '@/models/types';

export type ChatHierarchyService = {
  createChatGroup({
    name,
    options,
  }: {
    name: string;
    options?: Partial<Pick<ChatGroup, 'modelId' | 'systemPrompt' | 'lmParameters'>>;
  }): Promise<string>;

  deleteChatGroup({
    id,
  }: {
    id: string;
  }): Promise<void>;

  setChatGroupCollapsed({
    groupId,
    isCollapsed,
  }: {
    groupId: string;
    isCollapsed: boolean;
  }): Promise<void>;

  duplicateChatGroup({
    groupId,
  }: {
    groupId: string;
  }): Promise<string | undefined>;

  renameChatGroup({
    groupId,
    newName,
  }: {
    groupId: string;
    newName: string;
  }): Promise<void>;

  updateChatGroupMetadata({
    id,
    updates,
  }: {
    id: string;
    updates: Partial<Pick<ChatGroup, 'name' | 'endpoint' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>;
  }): Promise<void>;

  persistSidebarStructure({
    topLevelItems,
  }: {
    topLevelItems: SidebarItem[];
  }): Promise<void>;

  reorderSidebarChatAfterSend({
    chatId,
  }: {
    chatId: string;
  }): Promise<void>;

  moveChatToGroup({
    chatId,
    targetGroupId,
  }: {
    chatId: string;
    targetGroupId: string | null;
  }): Promise<void>;
};

export function createChatHierarchyService({
  rootItems,
  currentChatRef,
  currentChatGroupRef,
  getChatGroups,
  getSidebarSendMessageReorder,
  replaceSidebarItems,
  updateChatGroup,
  deleteChatGroupFromStorage,
  updateHierarchy,
  loadData,
  deleteChat,
}: {
  rootItems: Ref<SidebarItem[]>;
  currentChatRef: Ref<Chat | null>;
  currentChatGroupRef: Ref<ChatGroup | null>;
  getChatGroups: () => ChatGroup[];
  getSidebarSendMessageReorder: () => 'disabled' | 'move_sent_chat';
  replaceSidebarItems: ({ items }: { items: SidebarItem[] }) => void;
  updateChatGroup: ({
    id,
    updater,
  }: {
    id: string;
    updater: (current: ChatGroup | null) => ChatGroup | Promise<ChatGroup>;
  }) => Promise<void>;
  deleteChatGroupFromStorage: ({ id }: { id: string }) => Promise<void>;
  updateHierarchy: (updater: (current: Hierarchy) => Hierarchy | Promise<Hierarchy>) => Promise<void>;
  loadData: (_args: Record<never, never>) => Promise<void>;
  deleteChat: ({ id, injectAddToast }: { id: string; injectAddToast?: (_args: unknown) => string }) => Promise<void>;
}): ChatHierarchyService {
  async function createChatGroup({
    name,
    options = undefined,
  }: {
    name: string;
    options?: Partial<Pick<ChatGroup, 'modelId' | 'systemPrompt' | 'lmParameters'>>;
  }) {
    const id = generateId();
    const newGroup: ChatGroup = {
      id,
      name,
      updatedAt: Date.now(),
      isCollapsed: false,
      items: [],
      ...options,
    };
    await updateChatGroup({
      id,
      updater: () => newGroup,
    });
    await updateHierarchy(curr => {
      curr.items.unshift({ type: 'chat_group', id, chat_ids: [] });
      return curr;
    });
    await loadData({});
    return id;
  }

  async function deleteChatGroup({
    id,
  }: {
    id: string;
  }) {
    const group = getChatGroups().find(item => item.id === id);
    if (!group) return;

    const items = [...group.items];
    for (const item of items) {
      await deleteChat({
        id: item.chat.id,
        injectAddToast: () => '',
      });
    }

    if (currentChatGroupRef.value?.id === id) {
      currentChatGroupRef.value = null;
    }

    await deleteChatGroupFromStorage({ id });
    await updateHierarchy(curr => {
      curr.items = curr.items.filter(item => {
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
      return curr;
    });
    await loadData({});
  }

  async function setChatGroupCollapsed({
    groupId,
    isCollapsed,
  }: {
    groupId: string;
    isCollapsed: boolean;
  }) {
    const item = rootItems.value.find(entry => entry.type === 'chat_group' && entry.chatGroup.id === groupId);
    if (item && item.type === 'chat_group') {
      item.chatGroup.isCollapsed = isCollapsed;
      triggerRef(rootItems);
    }

    if (currentChatGroupRef.value?.id === groupId) {
      currentChatGroupRef.value.isCollapsed = isCollapsed;
    }

    await updateChatGroup({
      id: groupId,
      updater: current => {
        if (!current) throw new Error('Chat group not found');
        current.isCollapsed = isCollapsed;
        return current;
      },
    });
  }

  async function duplicateChatGroup({
    groupId,
  }: {
    groupId: string;
  }) {
    const originalGroup = getChatGroups().find(group => group.id === groupId);
    if (!originalGroup) return undefined;

    const newId = generateId();
    const newGroup: ChatGroup = {
      ...toRaw(originalGroup),
      id: newId,
      name: `Copy of ${originalGroup.name}`,
      items: [],
      updatedAt: Date.now(),
      isCollapsed: false,
    };

    await updateChatGroup({
      id: newId,
      updater: () => newGroup,
    });
    await updateHierarchy(curr => {
      const originalIndex = curr.items.findIndex(item => item.type === 'chat_group' && item.id === groupId);
      const newNode: HierarchyNode = { type: 'chat_group', id: newId, chat_ids: [] };
      if (originalIndex !== -1) {
        curr.items.splice(originalIndex + 1, 0, newNode);
      } else {
        curr.items.unshift(newNode);
      }
      return curr;
    });
    await loadData({});
    return newId;
  }

  async function renameChatGroup({
    groupId,
    newName,
  }: {
    groupId: string;
    newName: string;
  }) {
    if (currentChatGroupRef.value?.id === groupId) {
      currentChatGroupRef.value.name = newName;
      currentChatGroupRef.value.updatedAt = Date.now();
    }

    await updateChatGroup({
      id: groupId,
      updater: current => {
        if (!current) throw new Error('Chat group not found');
        current.name = newName;
        current.updatedAt = Date.now();
        return current;
      },
    });
    await loadData({});
  }

  async function updateChatGroupMetadata({
    id,
    updates,
  }: {
    id: string;
    updates: Partial<Pick<ChatGroup, 'name' | 'endpoint' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>>;
  }) {
    if (currentChatGroupRef.value?.id === id) {
      Object.assign(currentChatGroupRef.value, updates);
      currentChatGroupRef.value.updatedAt = Date.now();
    }

    await updateChatGroup({
      id,
      updater: current => {
        if (!current) throw new Error('Chat group not found');
        return { ...current, ...updates, updatedAt: Date.now() };
      },
    });
    await loadData({});
  }

  async function persistSidebarStructure({
    topLevelItems,
  }: {
    topLevelItems: SidebarItem[];
  }) {
    replaceSidebarItems({ items: topLevelItems });
    const newHierarchy: Hierarchy = {
      items: topLevelItems.map(item => {
        switch (item.type) {
        case 'chat':
          return { type: 'chat', id: item.chat.id };
        case 'chat_group':
          return {
            type: 'chat_group',
            id: item.chatGroup.id,
            chat_ids: item.chatGroup.items.map(chatItem => chatItem.id.replace('chat:', '')),
          };
        default: {
          const _ex: never = item;
          return _ex;
        }
        }
      }),
    };
    await updateHierarchy(() => newHierarchy);
  }

  async function reorderSidebarChatAfterSend({
    chatId,
  }: {
    chatId: string;
  }) {
    const reorderSetting = getSidebarSendMessageReorder();
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

    await updateHierarchy(curr => {
      let chatNode: HierarchyNode | undefined;
      let sourceGroup: HierarchyChatGroupNode | undefined;

      curr.items = curr.items.filter(item => {
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

      if (sourceGroup) {
        sourceGroup.chat_ids.unshift(chatId);
        return curr;
      }

      const node = chatNode ?? { type: 'chat', id: chatId };
      const firstTopLevelChatIndex = curr.items.findIndex(item => item.type === 'chat');
      const insertIndex = firstTopLevelChatIndex === -1 ? curr.items.length : firstTopLevelChatIndex;
      curr.items.splice(insertIndex, 0, node);
      return curr;
    });

    await loadData({});
  }

  async function moveChatToGroup({
    chatId,
    targetGroupId,
  }: {
    chatId: string;
    targetGroupId: string | null;
  }) {
    await updateHierarchy(curr => {
      const node: HierarchyNode = { type: 'chat', id: chatId };
      curr.items = curr.items.filter(item => {
        switch (item.type) {
        case 'chat':
          return item.id !== chatId;
        case 'chat_group':
          item.chat_ids = item.chat_ids.filter(id => id !== chatId);
          return true;
        default: {
          const _ex: never = item;
          return _ex || true;
        }
        }
      });

      if (targetGroupId) {
        const group = curr.items.find(item => item.type === 'chat_group' && item.id === targetGroupId) as HierarchyChatGroupNode | undefined;
        if (group) {
          group.chat_ids.unshift(chatId);
        } else {
          insertTopLevelChat({ curr, node });
        }
      } else {
        insertTopLevelChat({ curr, node });
      }
      return curr;
    });

    if (currentChatRef.value && toRaw(currentChatRef.value).id === chatId) {
      currentChatRef.value.groupId = targetGroupId;
      triggerRef(currentChatRef);
    }
    await loadData({});
  }

  return {
    createChatGroup,
    deleteChatGroup,
    setChatGroupCollapsed,
    duplicateChatGroup,
    renameChatGroup,
    updateChatGroupMetadata,
    persistSidebarStructure,
    reorderSidebarChatAfterSend,
    moveChatToGroup,
  };
}

function insertTopLevelChat({
  curr,
  node,
}: {
  curr: Hierarchy;
  node: HierarchyNode;
}) {
  const firstChatIndex = curr.items.findIndex(item => item.type === 'chat');
  const insertIndex = firstChatIndex !== -1 ? firstChatIndex : curr.items.length;
  curr.items.splice(insertIndex, 0, node);
}
