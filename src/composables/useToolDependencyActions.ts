import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import { useChatTools } from '@/composables/useChatTools';
import { useChatWeshPreferences } from '@/composables/useChatWeshPreferences';
import { WIKIPEDIA_SEARCH_TOOL_NAME } from '@/services/tools/wikipedia';

export function useToolDependencyActions() {
  const { currentChat } = useCurrentChatState();
  const { isToolEnabled, setToolStatus } = useChatTools();
  const {
    getNaidanSysfsAccessScope,
    setNaidanSysfsAccessScope,
  } = useChatWeshPreferences();

  function isNaidanSysfsMountedForCurrentChat(): boolean {
    const accessScope = getNaidanSysfsAccessScope({ chatId: currentChat.value?.id });
    switch (accessScope) {
    case 'none':
      return false;
    case 'current_chat_only':
    case 'current_chat_with_chat_group':
    case 'main_chats':
      return true;
    default: {
      const _exhaustive: never = accessScope;
      throw new Error(`Unhandled naidan sysfs access scope: ${String(_exhaustive)}`);
    }
    }
  }

  function isWikipediaEffectivelyEnabledForCurrentChat(): boolean {
    return isToolEnabled({ name: WIKIPEDIA_SEARCH_TOOL_NAME });
  }

  async function enableWikipediaToolsForCurrentChat(): Promise<void> {
    await setToolStatus({
      name: WIKIPEDIA_SEARCH_TOOL_NAME,
      status: 'enabled',
    });
  }

  async function disableWikipediaToolsForCurrentChat(): Promise<void> {
    await setToolStatus({
      name: WIKIPEDIA_SEARCH_TOOL_NAME,
      status: 'disabled',
    });
  }

  async function disableShellToolForCurrentChat(): Promise<void> {
    await setToolStatus({
      name: 'shell_execute',
      status: 'disabled',
    });
  }

  async function disableNaidanSysfsForCurrentChat(): Promise<void> {
    await setNaidanSysfsAccessScope({
      chatId: currentChat.value?.id,
      accessScope: 'none',
    });
  }

  return {
    isNaidanSysfsMountedForCurrentChat,
    isWikipediaEffectivelyEnabledForCurrentChat,
    enableWikipediaToolsForCurrentChat,
    disableWikipediaToolsForCurrentChat,
    disableShellToolForCurrentChat,
    disableNaidanSysfsForCurrentChat,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for useXxx return objects.
    },
  };
}
