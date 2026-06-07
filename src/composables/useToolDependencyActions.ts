import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState'
import { useChatTools } from '@/composables/useChatTools'
import { useChatWeshPreferences } from '@/composables/useChatWeshPreferences'
import {
  WIKIPEDIA_GET_PAGE_TOOL_NAME,
  WIKIPEDIA_SEARCH_TOOL_NAME,
} from '@/services/tools/wikipedia'

export function useToolDependencyActions() {
  const { currentChat } = useCurrentChatState()
  const { isToolEnabled, setToolEnabled } = useChatTools()
  const {
    getNaidanSysfsMountSelection,
    setNaidanSysfsMountSelection,
  } = useChatWeshPreferences()

  function isNaidanSysfsMountedForCurrentChat(_args: Record<never, never>): boolean {
    const selection = getNaidanSysfsMountSelection({ chatId: currentChat.value?.id })
    switch (selection) {
    case 'none':
      return false
    case 'current_chat_only':
    case 'current_chat_with_chat_group':
    case 'all_chats':
      return true
    default: {
      const _exhaustive: never = selection
      throw new Error(`Unhandled naidan sysfs selection: ${String(_exhaustive)}`)
    }
    }
  }

  function isWikipediaEffectivelyEnabledForCurrentChat(_args: Record<never, never>): boolean {
    return isToolEnabled({ name: 'shell_execute' })
      && isNaidanSysfsMountedForCurrentChat({})
      && isToolEnabled({ name: WIKIPEDIA_SEARCH_TOOL_NAME })
      && isToolEnabled({ name: WIKIPEDIA_GET_PAGE_TOOL_NAME })
  }

  function enableWikipediaToolsForCurrentChat(_args: Record<never, never>): void {
    setToolEnabled({ name: 'shell_execute', enabled: true })
    setToolEnabled({ name: WIKIPEDIA_SEARCH_TOOL_NAME, enabled: true })
    setToolEnabled({ name: WIKIPEDIA_GET_PAGE_TOOL_NAME, enabled: true })

    const chatId = currentChat.value?.id
    const selection = getNaidanSysfsMountSelection({ chatId })
    switch (selection) {
    case 'none':
      setNaidanSysfsMountSelection({
        chatId,
        selection: 'current_chat_only',
      })
      break
    case 'current_chat_only':
    case 'current_chat_with_chat_group':
    case 'all_chats':
      break
    default: {
      const _exhaustive: never = selection
      throw new Error(`Unhandled naidan sysfs selection: ${String(_exhaustive)}`)
    }
    }
  }

  function disableWikipediaToolsForCurrentChat(_args: Record<never, never>): void {
    setToolEnabled({ name: WIKIPEDIA_SEARCH_TOOL_NAME, enabled: false })
    setToolEnabled({ name: WIKIPEDIA_GET_PAGE_TOOL_NAME, enabled: false })
  }

  function disableShellToolForCurrentChat(_args: Record<never, never>): void {
    setToolEnabled({ name: 'shell_execute', enabled: false })
    disableWikipediaToolsForCurrentChat({})
  }

  function disableNaidanSysfsForCurrentChat(_args: Record<never, never>): void {
    const chatId = currentChat.value?.id
    setNaidanSysfsMountSelection({
      chatId,
      selection: 'none',
    })
    disableWikipediaToolsForCurrentChat({})
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
  }
}
