import type { Settings } from '@/01-models/types';
import { useSettings } from '@/composables/useSettings';
import { useChatTools } from '@/features/tools/composables/useChatTools';
import { createChatDerivedState } from '@/composables/chat/chat-derived-state';
import {
  chatDataStore,
  currentChatRef,
  rootItems,
} from '@/composables/chat/global/chat-core-singletons';
import type { ChatGroupId, ChatId, MessageId } from '@/01-models/ids';

export type ChatNavigationAdapter = {
  openChat({
    chatId,
    leafId,
  }: {
    chatId: ChatId,
    leafId?: MessageId,
  }): Promise<import('@/01-models/types').Chat | null>,

  openChatAtMessage({
    chatId,
    messageId,
  }: {
    chatId: ChatId,
    messageId: MessageId,
  }): Promise<import('@/01-models/types').Chat | null>,

  openChatGroup({
    groupId,
  }: {
    groupId: ChatGroupId | null,
  }): void,

  TEST_ONLY: Record<never, never>,
};

export function useChatNavigation(): ChatNavigationAdapter {
  const { settings } = useSettings();
  const { setCurrentChatId, setToolEnabled } = useChatTools();
  const chatDerivedState = createChatDerivedState({
    currentChatRef,
    rootItems,
    getSettings: () => settings.value as Settings,
  });

  async function openChat({
    chatId,
    leafId,
  }: {
    chatId: ChatId,
    leafId?: MessageId,
  }) {
    setCurrentChatId({ chatId });
    const chat = await chatDataStore.openChat({ id: chatId, leafId });
    if (chat === null) {
      setCurrentChatId({ chatId: null });
      return null;
    }

    if (chatDerivedState.hasMountsForChat({ chat })) {
      setToolEnabled({ name: 'shell_execute', enabled: true });
    }
    return chat;
  }

  async function openChatAtMessage({
    chatId,
    messageId,
  }: {
    chatId: ChatId,
    messageId: MessageId,
  }) {
    setCurrentChatId({ chatId });
    const chat = await chatDataStore.openChatAtMessage({ chatId, messageId });
    if (chat === null) {
      setCurrentChatId({ chatId: null });
      return null;
    }

    if (chatDerivedState.hasMountsForChat({ chat })) {
      setToolEnabled({ name: 'shell_execute', enabled: true });
    }
    return chat;
  }

  function openChatGroup({
    groupId,
  }: {
    groupId: ChatGroupId | null,
  }) {
    chatDataStore.openChatGroup({ id: groupId });
  }

  return {
    openChat,
    openChatAtMessage,
    openChatGroup,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {},
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
