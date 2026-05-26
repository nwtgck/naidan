import { computed, type ComputedRef } from 'vue';
import type { Chat, ChatGroup, SidebarItem } from '@/models/types';
import { isProcessing as isChatProcessing } from '@/composables/chat/global/chat-core-singletons';
import { renameChatById } from '@/composables/chat/chat-scoped/chat-metadata-helpers';
import { useCurrentChatState } from './useCurrentChatState';
import { useChatLifecycle } from './useChatLifecycle';
import { useChatNavigation } from './useChatNavigation';
import { useChatOrganization } from './useChatOrganization';
import { useSidebarStructure } from './useSidebarStructure';

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
  const chatLifecycle = useChatLifecycle();
  const chatNavigation = useChatNavigation();
  const chatOrganization = useChatOrganization();
  const sidebarStructure = useSidebarStructure();

  const currentChat = computed(() => currentChatState.currentChat.value);
  const currentChatGroup = computed(() => currentChatState.currentChatGroup.value);
  const sidebarItems = computed(() => currentChatState.sidebarItems.value);
  const chatGroups = computed(() => currentChatState.chatGroups.value);

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
    await sidebarStructure.persistSidebarStructure({
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
    void sidebarStructure.setChatGroupCollapsed({
      groupId,
      isCollapsed,
    });
  }

  async function createChatGroup({
    name,
  }: {
    name: string;
  }) {
    return await chatOrganization.createChatGroup({
      name,
      options: undefined,
    });
  }

  async function deleteChatGroup({
    id,
  }: {
    id: string;
  }) {
    await chatOrganization.deleteChatGroup({
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
    await chatLifecycle.createNewChat({
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
    return await chatNavigation.openChat({
      chatId: id,
      leafId: undefined,
    });
  }

  function openChatGroup({
    id,
  }: {
    id: string;
  }) {
    chatNavigation.openChatGroup({
      groupId: id,
    });
  }

  async function deleteChat({
    id,
  }: {
    id: string;
  }) {
    await chatLifecycle.deleteChat({
      id,
      injectAddToast: undefined,
    });
  }

  async function renameChat({
    id,
    newTitle,
  }: {
    id: string;
    newTitle: string;
  }) {
    await renameChatById({
      chatId: id,
      title: newTitle,
    });
  }

  async function renameChatGroup({
    groupId,
    newName,
  }: {
    groupId: string;
    newName: string;
  }) {
    await chatOrganization.renameChatGroup({
      groupId,
      newName,
    });
  }

  async function duplicateChatGroup({
    groupId,
  }: {
    groupId: string;
  }) {
    await chatOrganization.duplicateChatGroup({
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
