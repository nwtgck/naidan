import { computed, type ComputedRef } from 'vue';
import type { Chat, ChatGroup, SidebarItem } from '@/models/types';
import { isProcessing as isChatProcessing } from '@/composables/chat/global/chat-core-singletons';
import { useCurrentChatState } from './useCurrentChatState';
import { useChatUiServices } from './useChatUiServices';

export type SidebarDataAdapter = {
  currentChat: ComputedRef<Readonly<Chat> | null>;
  currentChatGroup: ComputedRef<Readonly<ChatGroup> | null>;
  sidebarItems: ComputedRef<SidebarItem[]>;
  chatGroups: ComputedRef<ChatGroup[]>;

  isProcessing({
    chatId,
  }: {
    chatId: string;
  }): boolean;

  persistSidebarStructure({
    topLevelItems,
  }: {
    topLevelItems: SidebarItem[];
  }): Promise<void>;

  setChatGroupCollapsed({
    groupId,
    isCollapsed,
  }: {
    groupId: string;
    isCollapsed: boolean;
  }): void;

  createChatGroup({
    name,
  }: {
    name: string;
  }): Promise<string>;

  deleteChatGroup({
    id,
  }: {
    id: string;
  }): Promise<void>;

  createNewChat({
    groupId,
    modelId,
    systemPrompt,
  }: {
    groupId: string | undefined;
    modelId: string | undefined;
    systemPrompt: Chat['systemPrompt'];
  }): Promise<void>;

  openChat({
    id,
  }: {
    id: string;
  }): Promise<Chat | null>;

  openChatGroup({
    id,
  }: {
    id: string;
  }): void;

  deleteChat({
    id,
  }: {
    id: string;
  }): Promise<void>;

  renameChat({
    id,
    newTitle,
  }: {
    id: string;
    newTitle: string;
  }): Promise<void>;

  renameChatGroup({
    groupId,
    newName,
  }: {
    groupId: string;
    newName: string;
  }): Promise<void>;

  duplicateChatGroup({
    groupId,
  }: {
    groupId: string;
  }): Promise<void>;

  TEST_ONLY: Record<string, never>;
};

export function useSidebarData(): SidebarDataAdapter {
  const currentChatState = useCurrentChatState();
  const { derivedState, hierarchyService, lifecycleService, metadataService, openService } = useChatUiServices({});

  const currentChat = computed(() => currentChatState.currentChat.value);
  const currentChatGroup = computed(() => currentChatState.currentChatGroup.value);
  const sidebarItems = computed(() => derivedState.sidebarItems.value);
  const chatGroups = computed(() => derivedState.chatGroups.value);

  function isProcessing({
    chatId,
  }: {
    chatId: string;
  }) {
    return isChatProcessing({
      chatId,
    });
  }

  async function persistSidebarStructure({
    topLevelItems,
  }: {
    topLevelItems: SidebarItem[];
  }) {
    await hierarchyService.persistSidebarStructure({
      topLevelItems,
    });
  }

  function setChatGroupCollapsed({
    groupId,
    isCollapsed,
  }: {
    groupId: string;
    isCollapsed: boolean;
  }) {
    void hierarchyService.setChatGroupCollapsed({
      groupId,
      isCollapsed,
    });
  }

  async function createChatGroup({
    name,
  }: {
    name: string;
  }) {
    return await hierarchyService.createChatGroup({
      name,
    });
  }

  async function deleteChatGroup({
    id,
  }: {
    id: string;
  }) {
    await hierarchyService.deleteChatGroup({
      id,
    });
  }

  async function createNewChat({
    groupId,
    modelId,
    systemPrompt,
  }: {
    groupId: string | undefined;
    modelId: string | undefined;
    systemPrompt: Chat['systemPrompt'];
  }) {
    await lifecycleService.createNewChat({
      groupId,
      modelId,
      systemPrompt,
    });
  }

  async function openChat({
    id,
  }: {
    id: string;
  }) {
    return await openService.openChat({
      id,
      leafId: undefined,
    });
  }

  function openChatGroup({
    id,
  }: {
    id: string;
  }) {
    openService.openChatGroup({
      id,
    });
  }

  async function deleteChat({
    id,
  }: {
    id: string;
  }) {
    await lifecycleService.deleteChat({
      id,
    });
  }

  async function renameChat({
    id,
    newTitle,
  }: {
    id: string;
    newTitle: string;
  }) {
    await metadataService.renameChat({
      id,
      newTitle,
    });
  }

  async function renameChatGroup({
    groupId,
    newName,
  }: {
    groupId: string;
    newName: string;
  }) {
    await hierarchyService.renameChatGroup({
      groupId,
      newName,
    });
  }

  async function duplicateChatGroup({
    groupId,
  }: {
    groupId: string;
  }) {
    await hierarchyService.duplicateChatGroup({
      groupId,
    });
  }

  return {
    currentChat,
    currentChatGroup,
    sidebarItems,
    chatGroups,
    isProcessing,
    persistSidebarStructure,
    setChatGroupCollapsed,
    createChatGroup,
    deleteChatGroup,
    createNewChat,
    openChat,
    openChatGroup,
    deleteChat,
    renameChat,
    renameChatGroup,
    duplicateChatGroup,
    TEST_ONLY: {},
  };
}
