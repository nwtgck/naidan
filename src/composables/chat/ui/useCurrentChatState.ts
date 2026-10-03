import { useChatViewScope } from './chat-view-scope';
import { useChatPaneState } from './useChatPaneState';
import { computed, type ComputedRef } from 'vue';
import type { Chat, ChatGroup, MessageNode, SidebarItem } from '@/01-models/types';
import type { Settings } from '@/01-models/types';
import type { ChatId } from '@/01-models/ids';
import { useSettings } from '@/composables/useSettings';
import { resolveChatSettings } from '@/logic/chat-settings-resolver';
import { createChatCurrentBridge } from '@/composables/chat/chat-current-bridge';
import { createChatDerivedState } from '@/composables/chat/chat-derived-state';
import {
  currentChatGroupRef,
  currentChatRef,
  getLiveChat,
  liveChatRegistry,
  rootItems,
} from '@/composables/chat/global/chat-core-singletons';

export type CurrentChatStateAdapter = {
  currentChat: ComputedRef<Readonly<Chat> | null>,
  currentChatGroup: ComputedRef<Readonly<ChatGroup> | null>,
  currentChatId: ComputedRef<ChatId | undefined>,
  activeMessages: ComputedRef<MessageNode[]>,
  resolvedSettings: ComputedRef<ReturnType<typeof resolveChatSettings> | null>,
  inheritedSettings: ComputedRef<ReturnType<typeof resolveChatSettings> | null>,
  chatGroups: ComputedRef<ChatGroup[]>,
  sidebarItems: ComputedRef<SidebarItem[]>,

  TEST_ONLY: {
    allMessages: ComputedRef<MessageNode[]>,
  },
};

export function useCurrentChatState(): CurrentChatStateAdapter {
  const scope = useChatViewScope();
  if (scope) {
    const pane = useChatPaneState({ chatId: scope });
    return {
      currentChat: pane.chat, currentChatGroup: pane.chatGroup,
      currentChatId: computed(() => pane.chat.value?.id),
      activeMessages: pane.activeMessages, resolvedSettings: pane.resolvedSettings,
      inheritedSettings: pane.inheritedSettings, chatGroups: pane.chatGroups,
      sidebarItems: computed(() => rootItems.value),
      ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: { allMessages: pane.allMessages } }) || {}),
    };
  }
  const { settings } = useSettings();
  const chatCurrentBridge = createChatCurrentBridge({
    currentChatRef,
    currentChatGroupRef,
    liveChatRegistry,
    getLiveChat,
  });
  const chatDerivedState = createChatDerivedState({
    currentChatRef,
    rootItems,
    getSettings: () => settings.value as Settings,
  });

  const currentChat = computed(() => chatCurrentBridge.currentChat.value);
  const currentChatGroup = computed(() => chatCurrentBridge.currentChatGroup.value);
  const currentChatId = computed(() => currentChat.value?.id);
  const activeMessages = computed(() => chatDerivedState.activeMessages.value);
  const allMessages = computed(() => chatDerivedState.allMessages.value);
  const resolvedSettings = computed(() => chatDerivedState.resolvedSettings.value);
  const inheritedSettings = computed(() => chatDerivedState.inheritedSettings.value);
  const chatGroups = computed(() => chatDerivedState.chatGroups.value);
  const sidebarItems = computed(() => chatDerivedState.sidebarItems.value);

  return {
    currentChat,
    currentChatGroup,
    currentChatId,
    activeMessages,
    resolvedSettings,
    inheritedSettings,
    chatGroups,
    sidebarItems,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        allMessages,
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
