import { createChatDerivedState } from '@/composables/chat/chat-derived-state';
import { installChatBootstrap } from '@/composables/chat/chat-bootstrap';
import { useChatModels } from '@/composables/chat/useChatModels';
import { loadData } from '@/composables/chat/global/chat-core-singletons';
import { chatRuntimeStore, currentChatRef, rootItems } from '@/composables/chat/global/chat-core-singletons';
import { useChatNavigation } from '@/composables/chat/ui/useChatNavigation';
import type { Settings } from '@/models/types';
import { transformersJsService } from '@/services/transformers-js';
import { useSettings } from '@/composables/useSettings';
import type { ChatId } from '@/models/ids';

export type ChatBootstrapAdapter = {
  loadChats(): Promise<void>;

  openChat({
    chatId,
  }: {
    chatId: ChatId;
  }): Promise<unknown>;

  TEST_ONLY: Record<never, never>;
};

export function useChatBootstrap(): ChatBootstrapAdapter {
  const { settings } = useSettings();
  const chatModels = useChatModels();
  const chatNavigation = useChatNavigation();
  const chatDerivedState = createChatDerivedState({
    currentChatRef,
    rootItems,
    getSettings: () => settings.value as Settings,
  });

  installChatBootstrap({
    registerBeforeUnload: () => {
      if (typeof window === 'undefined') {
        return undefined;
      }

      const onBeforeUnload = () => {
        for (const item of chatRuntimeStore.activeGenerations.values()) {
          item.controller.abort();
        }
      };

      window.addEventListener('beforeunload', onBeforeUnload);
      return () => {
        window.removeEventListener('beforeunload', onBeforeUnload);
      };
    },
    subscribeModelList: () => {
      return transformersJsService.subscribeModelList({ listener: async () => {
        const type = chatDerivedState.resolvedSettings.value?.endpointType;
        if (type === undefined) {
          return;
        }

        switch (type) {
        case 'transformers_js':
          if (currentChatRef.value === null) {
            return;
          }
          await chatModels.fetchForChat({
            chatId: currentChatRef.value.id,
          });
          return;
        case 'openai':
        case 'ollama':
          return;
        default: {
          const _ex: never = type;
          throw new Error(`Unhandled endpoint type: ${_ex}`);
        }
        }
      } });
    },
  });

  async function loadChats() {
    await loadData();
  }

  async function openChat({
    chatId,
  }: {
    chatId: ChatId;
  }) {
    return await chatNavigation.openChat({
      chatId,
      leafId: undefined,
    });
  }

  return {
    loadChats,
    openChat,
    TEST_ONLY: {},
  };
}
