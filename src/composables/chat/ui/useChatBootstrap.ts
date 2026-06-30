import { createChatDerivedState } from '@/composables/chat/chat-derived-state';
import { installChatBootstrap } from '@/composables/chat/chat-bootstrap';
import { useChatModels } from '@/composables/chat/useChatModels';
import { loadData } from '@/composables/chat/global/chat-core-singletons';
import { chatRuntimeStore, currentChatRef, rootItems } from '@/composables/chat/global/chat-core-singletons';
import { useChatNavigation } from '@/composables/chat/ui/useChatNavigation';
import type { Settings } from '@/01-models/types';
import { transformersJsService } from '@/features/transformers-js';
import { useSettings } from '@/composables/useSettings';
import type { ChatId } from '@/01-models/ids';

export type ChatBootstrapAdapter = {
  loadChats(): Promise<void>,

  openChat({
    chatId,
  }: {
    chatId: ChatId,
  }): Promise<unknown>,

  TEST_ONLY: Record<never, never>,
};

export async function loadChatsForAppStartup(): Promise<void> {
  /**
   * WHY: Startup may hydrate the Sidebar while onboarding is still visible,
   * but runtime listeners must remain inactive until the real app has
   * mounted. Keep data hydration separate from runtime activation.
   */
  await loadData();
}

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
        const type = chatDerivedState.resolvedSettings.value?.endpoint.type;
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
    await loadChatsForAppStartup();
  }

  async function openChat({
    chatId,
  }: {
    chatId: ChatId,
  }) {
    return await chatNavigation.openChat({
      chatId,
      leafId: undefined,
    });
  }

  return {
    loadChats,
    openChat,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {},
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
