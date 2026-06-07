import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { useToolDependencyActions } from './useToolDependencyActions'
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState'
import {
  WIKIPEDIA_GET_PAGE_TOOL_NAME,
  WIKIPEDIA_SEARCH_TOOL_NAME,
} from '@/services/tools/wikipedia'

const mockSetToolEnabled = vi.fn()
const mockGetNaidanSysfsMountSelection = vi.fn()
const mockSetNaidanSysfsMountSelection = vi.fn()
const mockCurrentChat = ref<{ id: string } | null>({ id: 'chat-1' })

vi.mock('@/composables/useChatTools', () => ({
  useChatTools: () => ({
    setToolEnabled: mockSetToolEnabled,
  }),
}))

vi.mock('@/composables/useChatWeshPreferences', () => ({
  useChatWeshPreferences: () => ({
    getNaidanSysfsMountSelection: mockGetNaidanSysfsMountSelection,
    setNaidanSysfsMountSelection: mockSetNaidanSysfsMountSelection,
  }),
}))

vi.mock('@/composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: vi.fn(),
}))

describe('useToolDependencyActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCurrentChat.value = { id: 'chat-1' }
    mockGetNaidanSysfsMountSelection.mockReturnValue('none')
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

    enableWikipediaToolsForCurrentChat({})

    expect(mockSetToolEnabled).toHaveBeenNthCalledWith(1, { name: 'shell_execute', enabled: true })
    expect(mockSetToolEnabled).toHaveBeenNthCalledWith(2, { name: WIKIPEDIA_SEARCH_TOOL_NAME, enabled: true })
    expect(mockSetToolEnabled).toHaveBeenNthCalledWith(3, { name: WIKIPEDIA_GET_PAGE_TOOL_NAME, enabled: true })
    expect(mockSetNaidanSysfsMountSelection).toHaveBeenCalledWith({
      chatId: 'chat-1',
      selection: 'current_chat_only',
    })
  })

  it('preserves a non-none sysfs selection when enabling wikipedia', () => {
    mockGetNaidanSysfsMountSelection.mockReturnValue('all_chats')
    const { enableWikipediaToolsForCurrentChat } = useToolDependencyActions()

    enableWikipediaToolsForCurrentChat({})

    expect(mockSetNaidanSysfsMountSelection).not.toHaveBeenCalled()
  })

  it('disables only wikipedia tools when turning wikipedia off', () => {
    const { disableWikipediaToolsForCurrentChat } = useToolDependencyActions()

    disableWikipediaToolsForCurrentChat({})

    expect(mockSetToolEnabled).toHaveBeenNthCalledWith(1, { name: WIKIPEDIA_SEARCH_TOOL_NAME, enabled: false })
    expect(mockSetToolEnabled).toHaveBeenNthCalledWith(2, { name: WIKIPEDIA_GET_PAGE_TOOL_NAME, enabled: false })
    expect(mockSetToolEnabled).not.toHaveBeenCalledWith({ name: 'shell_execute', enabled: false })
  })

  it('disables sysfs and wikipedia tools without disabling shell', () => {
    const { disableNaidanSysfsForCurrentChat } = useToolDependencyActions()

    disableNaidanSysfsForCurrentChat({})

    expect(mockSetNaidanSysfsMountSelection).toHaveBeenCalledWith({
      chatId: 'chat-1',
      selection: 'none',
    })
    expect(mockSetToolEnabled).toHaveBeenNthCalledWith(1, { name: WIKIPEDIA_SEARCH_TOOL_NAME, enabled: false })
    expect(mockSetToolEnabled).toHaveBeenNthCalledWith(2, { name: WIKIPEDIA_GET_PAGE_TOOL_NAME, enabled: false })
    expect(mockSetToolEnabled).not.toHaveBeenCalledWith({ name: 'shell_execute', enabled: false })
  })
})
