import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { useToolDependencyActions } from './useToolDependencyActions'
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState'
import {
  WIKIPEDIA_GET_PAGE_TOOL_NAME,
  WIKIPEDIA_SEARCH_TOOL_NAME,
} from '@/services/tools/wikipedia'
import { findLastToolConfigByKey, llmToolNamesFromToolConfigs } from '@/services/tools/tool-config'
import type { ToolConfig } from '@/services/tools/types'

const mockSetToolEnabled = vi.fn()
const mockIsToolEnabled = vi.fn()
const mockUpdateToolConfigsForCurrentChat = vi.fn()
let updatedToolConfigs: ToolConfig[] | undefined
const mockGetNaidanSysfsAccessScope = vi.fn()
const mockSetNaidanSysfsAccessScope = vi.fn()
const mockCurrentChat = ref<{ id: string } | null>({ id: 'chat-1' })

vi.mock('@/composables/useChatTools', () => ({
  useChatTools: () => ({
    isToolEnabled: mockIsToolEnabled,
    setToolEnabled: mockSetToolEnabled,
    updateToolConfigsForCurrentChat: mockUpdateToolConfigsForCurrentChat,
  }),
}))

vi.mock('@/composables/useChatWeshPreferences', () => ({
  useChatWeshPreferences: () => ({
    getNaidanSysfsAccessScope: mockGetNaidanSysfsAccessScope,
    setNaidanSysfsAccessScope: mockSetNaidanSysfsAccessScope,
  }),
}))

vi.mock('@/composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: vi.fn(),
}))

describe('useToolDependencyActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCurrentChat.value = { id: 'chat-1' }
    mockGetNaidanSysfsAccessScope.mockReturnValue('none')
    mockIsToolEnabled.mockReturnValue(false)
    updatedToolConfigs = undefined
    mockUpdateToolConfigsForCurrentChat.mockImplementation(({ updater }) => {
      updatedToolConfigs = updater({ toolConfigs: updatedToolConfigs })
    })
    vi.mocked(useCurrentChatState).mockReturnValue({
      currentChat: computed(() => mockCurrentChat.value),
      currentChatGroup: computed(() => null),
      currentChatId: computed(() => mockCurrentChat.value?.id),
      activeMessages: computed(() => []),
      allMessages: computed(() => []),
      resolvedSettings: computed(() => null),
      inheritedSettings: computed(() => null),
      chatGroups: computed(() => []),
      sidebarItems: computed(() => []),
      TEST_ONLY: {},
    } as unknown as ReturnType<typeof useCurrentChatState>)
  })

  it('enables shell and wikipedia tools and mounts sysfs when it was none', () => {
    const { enableWikipediaToolsForCurrentChat } = useToolDependencyActions()

    enableWikipediaToolsForCurrentChat()

    expect(mockUpdateToolConfigsForCurrentChat).toHaveBeenCalledTimes(1)
    const enabledToolNames = llmToolNamesFromToolConfigs({ toolConfigs: updatedToolConfigs })
    expect(enabledToolNames).toHaveLength(3)
    expect(enabledToolNames).toEqual(expect.arrayContaining([
      'shell_execute',
      WIKIPEDIA_SEARCH_TOOL_NAME,
      WIKIPEDIA_GET_PAGE_TOOL_NAME,
    ]))
    expect(findLastToolConfigByKey({
      toolConfigs: updatedToolConfigs,
      key: 'builtin.wesh',
    })?.naidanSysfs.accessScope).toBe('current_chat_only')
    expect(mockSetNaidanSysfsAccessScope).not.toHaveBeenCalled()
  })

  it('preserves a non-none sysfs access scope when enabling wikipedia', () => {
    mockGetNaidanSysfsAccessScope.mockReturnValue('main_chats')
    const { enableWikipediaToolsForCurrentChat } = useToolDependencyActions()

    enableWikipediaToolsForCurrentChat()

    expect(findLastToolConfigByKey({
      toolConfigs: updatedToolConfigs,
      key: 'builtin.wesh',
    })?.naidanSysfs.accessScope).toBe('main_chats')
    expect(mockSetNaidanSysfsAccessScope).not.toHaveBeenCalled()
  })

  it('reports wikipedia as effectively enabled only when shell, sysfs, and both tools are enabled', () => {
    mockGetNaidanSysfsAccessScope.mockReturnValue('current_chat_only')
    mockIsToolEnabled.mockImplementation(({ name }: { name: string }) =>
      name === 'shell_execute'
      || name === WIKIPEDIA_SEARCH_TOOL_NAME
      || name === WIKIPEDIA_GET_PAGE_TOOL_NAME)

    const { isWikipediaEffectivelyEnabledForCurrentChat } = useToolDependencyActions()

    expect(isWikipediaEffectivelyEnabledForCurrentChat()).toBe(true)
  })

  it('reports wikipedia as effectively disabled when shell is off', () => {
    mockGetNaidanSysfsAccessScope.mockReturnValue('current_chat_only')
    mockIsToolEnabled.mockImplementation(({ name }: { name: string }) =>
      name === WIKIPEDIA_SEARCH_TOOL_NAME
      || name === WIKIPEDIA_GET_PAGE_TOOL_NAME)

    const { isWikipediaEffectivelyEnabledForCurrentChat } = useToolDependencyActions()

    expect(isWikipediaEffectivelyEnabledForCurrentChat()).toBe(false)
  })

  it('disables only wikipedia tools when turning wikipedia off', () => {
    updatedToolConfigs = [
      {
        key: 'builtin.wesh',
        naidanSysfs: {
          accessScope: 'current_chat_only',
        },
      },
      { key: 'builtin.wikipedia' },
    ]
    const { disableWikipediaToolsForCurrentChat } = useToolDependencyActions()

    disableWikipediaToolsForCurrentChat()

    expect(llmToolNamesFromToolConfigs({ toolConfigs: updatedToolConfigs })).toEqual(['shell_execute'])
    expect(mockSetToolEnabled).not.toHaveBeenCalled()
  })

  it('disables shell and wikipedia tools together when shell is turned off', () => {
    updatedToolConfigs = [
      {
        key: 'builtin.wesh',
        naidanSysfs: {
          accessScope: 'current_chat_only',
        },
      },
      { key: 'builtin.wikipedia' },
    ]
    const { disableShellToolForCurrentChat } = useToolDependencyActions()

    disableShellToolForCurrentChat()

    expect(updatedToolConfigs).toBeUndefined()
    expect(mockSetToolEnabled).not.toHaveBeenCalled()
  })

  it('disables sysfs and wikipedia tools without disabling shell', () => {
    updatedToolConfigs = [
      {
        key: 'builtin.wesh',
        naidanSysfs: {
          accessScope: 'current_chat_only',
        },
      },
      { key: 'builtin.wikipedia' },
    ]
    const { disableNaidanSysfsForCurrentChat } = useToolDependencyActions()

    disableNaidanSysfsForCurrentChat()

    expect(llmToolNamesFromToolConfigs({ toolConfigs: updatedToolConfigs })).toEqual(['shell_execute'])
    expect(findLastToolConfigByKey({
      toolConfigs: updatedToolConfigs,
      key: 'builtin.wesh',
    })?.naidanSysfs.accessScope).toBe('none')
    expect(mockSetNaidanSysfsAccessScope).not.toHaveBeenCalled()
    expect(mockSetToolEnabled).not.toHaveBeenCalled()
  })
})
