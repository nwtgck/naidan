import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState'
import { useChatTools } from '@/composables/useChatTools'
import { useChatWeshPreferences } from '@/composables/useChatWeshPreferences'
import {
  WIKIPEDIA_GET_PAGE_TOOL_NAME,
  WIKIPEDIA_SEARCH_TOOL_NAME,
} from '@/services/tools/wikipedia'
import {
  setLmToolEnabledInToolConfigs,
  setWeshNaidanSysfsAccessScopeInToolConfigs,
} from '@/services/tools/tool-config'

export function useToolDependencyActions() {
  const { currentChat } = useCurrentChatState()
  const { isToolEnabled, updateToolConfigsForCurrentChat } = useChatTools()
  const { getNaidanSysfsAccessScope } = useChatWeshPreferences()

  function isNaidanSysfsMountedForCurrentChat(): boolean {
    const accessScope = getNaidanSysfsAccessScope({ chatId: currentChat.value?.id })
    switch (accessScope) {
    case 'none':
      return false
    case 'current_chat_only':
    case 'current_chat_with_chat_group':
    case 'main_chats':
      return true
    default: {
      const _exhaustive: never = accessScope
      throw new Error(`Unhandled naidan sysfs access scope: ${String(_exhaustive)}`)
    }
    }
  }

  function isWikipediaEffectivelyEnabledForCurrentChat(): boolean {
    return isToolEnabled({ name: 'shell_execute' })
      && isNaidanSysfsMountedForCurrentChat()
      && isToolEnabled({ name: WIKIPEDIA_SEARCH_TOOL_NAME })
      && isToolEnabled({ name: WIKIPEDIA_GET_PAGE_TOOL_NAME })
  }

  function enableWikipediaToolsForCurrentChat(): void {
    const chatId = currentChat.value?.id
    const accessScope = getNaidanSysfsAccessScope({ chatId })
    updateToolConfigsForCurrentChat({
      updater: ({ toolConfigs }) => {
        let nextToolConfigs = setLmToolEnabledInToolConfigs({
          toolConfigs,
          name: 'shell_execute',
          enabled: true,
        })
        nextToolConfigs = setLmToolEnabledInToolConfigs({
          toolConfigs: nextToolConfigs,
          name: WIKIPEDIA_SEARCH_TOOL_NAME,
          enabled: true,
        })
        nextToolConfigs = setLmToolEnabledInToolConfigs({
          toolConfigs: nextToolConfigs,
          name: WIKIPEDIA_GET_PAGE_TOOL_NAME,
          enabled: true,
        })

        switch (accessScope) {
        case 'none':
          return setWeshNaidanSysfsAccessScopeInToolConfigs({
            toolConfigs: nextToolConfigs,
            accessScope: 'current_chat_only',
          })
        case 'current_chat_only':
        case 'current_chat_with_chat_group':
        case 'main_chats':
          return setWeshNaidanSysfsAccessScopeInToolConfigs({
            toolConfigs: nextToolConfigs,
            accessScope,
          })
        default: {
          const _exhaustive: never = accessScope
          throw new Error(`Unhandled naidan sysfs access scope: ${String(_exhaustive)}`)
        }
        }
      },
    })
  }

  function disableWikipediaToolsForCurrentChat(): void {
    updateToolConfigsForCurrentChat({
      updater: ({ toolConfigs }) => {
        let nextToolConfigs = setLmToolEnabledInToolConfigs({
          toolConfigs,
          name: WIKIPEDIA_SEARCH_TOOL_NAME,
          enabled: false,
        })
        nextToolConfigs = setLmToolEnabledInToolConfigs({
          toolConfigs: nextToolConfigs,
          name: WIKIPEDIA_GET_PAGE_TOOL_NAME,
          enabled: false,
        })
        return nextToolConfigs
      },
    })
  }

  function disableShellToolForCurrentChat(): void {
    updateToolConfigsForCurrentChat({
      updater: ({ toolConfigs }) => {
        let nextToolConfigs = setLmToolEnabledInToolConfigs({
          toolConfigs,
          name: 'shell_execute',
          enabled: false,
        })
        nextToolConfigs = setLmToolEnabledInToolConfigs({
          toolConfigs: nextToolConfigs,
          name: WIKIPEDIA_SEARCH_TOOL_NAME,
          enabled: false,
        })
        nextToolConfigs = setLmToolEnabledInToolConfigs({
          toolConfigs: nextToolConfigs,
          name: WIKIPEDIA_GET_PAGE_TOOL_NAME,
          enabled: false,
        })
        return nextToolConfigs
      },
    })
  }

  function disableNaidanSysfsForCurrentChat(): void {
    updateToolConfigsForCurrentChat({
      updater: ({ toolConfigs }) => {
        let nextToolConfigs = setWeshNaidanSysfsAccessScopeInToolConfigs({
          toolConfigs,
          accessScope: 'none',
        })
        nextToolConfigs = setLmToolEnabledInToolConfigs({
          toolConfigs: nextToolConfigs,
          name: WIKIPEDIA_SEARCH_TOOL_NAME,
          enabled: false,
        })
        nextToolConfigs = setLmToolEnabledInToolConfigs({
          toolConfigs: nextToolConfigs,
          name: WIKIPEDIA_GET_PAGE_TOOL_NAME,
          enabled: false,
        })
        return nextToolConfigs
      },
    })
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
