import { triggerRef } from 'vue';
import type { Hierarchy, SidebarItem } from '@/01-models/types';
import { storageService } from '@/00-storage/service';
import {
  currentChatGroupRef,
  rootItems,
} from '@/composables/chat/global/chat-core-singletons';
import type { ChatGroupId } from '@/01-models/ids';

export type SidebarStructureAdapter = {
  persistSidebarStructure({
    topLevelItems,
  }: {
    topLevelItems: SidebarItem[],
  }): Promise<void>,

  setChatGroupCollapsed({
    groupId,
    isCollapsed,
  }: {
    groupId: ChatGroupId,
    isCollapsed: boolean,
  }): Promise<void>,

  TEST_ONLY: Record<never, never>,
};

export function useSidebarStructure(): SidebarStructureAdapter {
  async function persistSidebarStructure({
    topLevelItems,
  }: {
    topLevelItems: SidebarItem[],
  }): Promise<void> {
    rootItems.value = topLevelItems;
    const newHierarchy: Hierarchy = {
      items: topLevelItems.map((item) => {
        switch (item.type) {
        case 'chat':
          return { type: 'chat', id: item.chat.id };
        case 'chat_group':
          return {
            type: 'chat_group',
            id: item.chatGroup.id,
            chat_ids: item.chatGroup.items.map((chatItem) => chatItem.chat.id),
          };
        default: {
          const _ex: never = item;
          return _ex;
        }
        }
      }),
    };
    await storageService.updateHierarchy({ updater: ({ current: _current }) => newHierarchy });
  }

  async function setChatGroupCollapsed({
    groupId,
    isCollapsed,
  }: {
    groupId: ChatGroupId,
    isCollapsed: boolean,
  }): Promise<void> {
    const item = rootItems.value.find((entry) => entry.type === 'chat_group' && entry.chatGroup.id === groupId);
    if (item !== undefined && item.type === 'chat_group') {
      item.chatGroup.isCollapsed = isCollapsed;
      triggerRef(rootItems);
    }

    if (currentChatGroupRef.value?.id === groupId) {
      currentChatGroupRef.value.isCollapsed = isCollapsed;
    }

    await storageService.updateChatGroup({ id: groupId, updater: ({ current }) => {
      if (current === null) {
        throw new Error('Chat group not found');
      }
      current.isCollapsed = isCollapsed;
      return current;
    } });
  }

  return {
    persistSidebarStructure,
    setChatGroupCollapsed,
    TEST_ONLY: {},
  };
}
