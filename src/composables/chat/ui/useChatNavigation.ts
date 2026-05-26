import { useSettings } from '@/composables/useSettings';
import { useChatTools } from '@/composables/useChatTools';
import type { Settings } from '@/models/types';
import { createChatDerivedState } from '@/composables/chat/chat-derived-state';
import {
  chatDataStore,
  currentChatRef,
  rootItems,
} from '@/composables/chat/global/chat-core-singletons';
import { createChatOpenService } from '@/composables/chat/services/chat-open-service';

export type ChatNavigationAdapter = {
  openChat({
    chatId,
    leafId,
  }: {
    chatId: string;
    leafId?: string;
  }): ReturnType<ReturnType<typeof createChatOpenService>['openChat']>;

  openChatAtMessage({
    chatId,
    messageId,
  }: {
    chatId: string;
    messageId: string;
  }): ReturnType<ReturnType<typeof createChatOpenService>['openChatAtMessage']>;

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
  const chatOpenService = createChatOpenService({
    setCurrentChatId,
    setToolEnabled,
    hasMountsForChat: chatDerivedState.hasMountsForChat,
    openChatInStore: ({ id, leafId }) => chatDataStore.openChat({ id, leafId }),
    openChatAtMessageInStore: ({ chatId, messageId }) => chatDataStore.openChatAtMessage({ chatId, messageId }),
    openChatGroupInStore: ({ id }) => {
      chatDataStore.openChatGroup({ id });
    },
  });

  function openChat({
    chatId,
    leafId,
  }: {
    chatId: string;
    leafId?: string;
  }) {
    return chatOpenService.openChat({
      id: chatId,
      leafId,
    });
  }

  function openChatAtMessage({
    chatId,
    messageId,
  }: {
    chatId: string;
    messageId: string;
  }) {
    return chatOpenService.openChatAtMessage({
      chatId,
      messageId,
    });
  }

  function openChatGroup({
    groupId,
  }: {
    groupId: string | null;
  }) {
    chatOpenService.openChatGroup({
      id: groupId,
    });
  }

  return {
    openChat,
    openChatAtMessage,
    openChatGroup,
    TEST_ONLY: {},
  };
}
