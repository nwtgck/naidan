import type { Settings } from '@/models/types';
import { useSettings } from '@/composables/useSettings';
import { createChatCurrentBridge } from '@/composables/chat/chat-current-bridge';
import { createChatDerivedState } from '@/composables/chat/chat-derived-state';
import {
  currentChatGroupRef,
  currentChatRef,
  getLiveChat,
  liveChatRegistry,
  rootItems,
} from '@/composables/chat/global/chat-core-singletons';

export function useChatUiServices(_args: Record<never, never>) {
  const { settings } = useSettings();

  const currentBridge = createChatCurrentBridge({
    currentChatRef,
    currentChatGroupRef,
    liveChatRegistry,
    getLiveChat,
  });
  const derivedState = createChatDerivedState({
    currentChatRef,
    rootItems,
    getSettings: () => settings.value as Settings,
  });
  return {
    currentBridge,
    derivedState,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
