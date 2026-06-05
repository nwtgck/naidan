import type { Settings } from '@/models/types';
import { useSettings } from '@/composables/useSettings';
import { useChatTools } from '@/composables/useChatTools';
import { createChatDerivedState } from '@/composables/chat/chat-derived-state';
import {
  chatDataStore,
  currentChatRef,
  rootItems,
} from '@/composables/chat/global/chat-core-singletons';

export type ChatNavigationAdapter = {
  openChat({
    chatId,
    leafId,
  }: {
    chatId: string;
    leafId?: string;
  }): Promise<import('@/models/types').Chat | null>;

  openChatAtMessage({
    chatId,
    messageId,
  }: {
    chatId: string;
    messageId: string;
  }): Promise<import('@/models/types').Chat | null>;

  openChatGroup({
    groupId,
  }: {
    groupId: string | null;
  }): void;

  TEST_ONLY: Record<string, never>;
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
    chatId: string;
    leafId?: string;
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
    chatId: string;
    messageId: string;
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
    groupId: string | null;
  }) {
    chatDataStore.openChatGroup({ id: groupId });
  }

  return {
    openChat,
    openChatAtMessage,
    openChatGroup,
    TEST_ONLY: {},
  };
}
