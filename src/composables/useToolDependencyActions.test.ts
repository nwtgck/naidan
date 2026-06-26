import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { useToolDependencyActions } from './useToolDependencyActions';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import { WIKIPEDIA_SEARCH_TOOL_NAME } from '@/services/tools/wikipedia';

const mocks = vi.hoisted(() => ({
  setToolStatus: vi.fn(),
  isToolEnabled: vi.fn(),
  getNaidanSysfsAccessScope: vi.fn(),
  setNaidanSysfsAccessScope: vi.fn(),
}));
const mockCurrentChat = ref<{ id: string } | null>({ id: 'chat-1' });

vi.mock('@/composables/useChatTools', () => ({
  useChatTools: () => ({
    isToolEnabled: mocks.isToolEnabled,
    setToolStatus: mocks.setToolStatus,
  }),
}));

vi.mock('@/composables/useChatWeshPreferences', () => ({
  useChatWeshPreferences: () => ({
    getNaidanSysfsAccessScope: mocks.getNaidanSysfsAccessScope,
    setNaidanSysfsAccessScope: mocks.setNaidanSysfsAccessScope,
  }),
}));

vi.mock('@/composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: vi.fn(),
}));

describe('useToolDependencyActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrentChat.value = { id: 'chat-1' };
    mocks.getNaidanSysfsAccessScope.mockReturnValue('none');
    mocks.isToolEnabled.mockReturnValue(false);
    mocks.setToolStatus.mockResolvedValue(undefined);
    mocks.setNaidanSysfsAccessScope.mockResolvedValue(undefined);
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
    } as unknown as ReturnType<typeof useCurrentChatState>);
  });

  it('enables wikipedia through the hierarchical tool status action', async () => {
    const { enableWikipediaToolsForCurrentChat } = useToolDependencyActions();

    await enableWikipediaToolsForCurrentChat();

    expect(mocks.setToolStatus).toHaveBeenCalledWith({
      name: WIKIPEDIA_SEARCH_TOOL_NAME,
      status: 'enabled',
    });
  });

  it('uses the canonical effective Wikipedia state', () => {
    mocks.isToolEnabled.mockImplementation(({ name }: { name: string }) =>
      name === WIKIPEDIA_SEARCH_TOOL_NAME);

    const { isWikipediaEffectivelyEnabledForCurrentChat } = useToolDependencyActions();

    expect(isWikipediaEffectivelyEnabledForCurrentChat()).toBe(true);
    expect(mocks.isToolEnabled).toHaveBeenCalledWith({
      name: WIKIPEDIA_SEARCH_TOOL_NAME,
    });
  });

  it('reports wikipedia as effectively disabled when the canonical resolver does', () => {
    mocks.isToolEnabled.mockReturnValue(false);

    const { isWikipediaEffectivelyEnabledForCurrentChat } = useToolDependencyActions();

    expect(isWikipediaEffectivelyEnabledForCurrentChat()).toBe(false);
  });

  it('disables wikipedia through the hierarchical tool status action', async () => {
    const { disableWikipediaToolsForCurrentChat } = useToolDependencyActions();

    await disableWikipediaToolsForCurrentChat();

    expect(mocks.setToolStatus).toHaveBeenCalledWith({
      name: WIKIPEDIA_SEARCH_TOOL_NAME,
      status: 'disabled',
    });
  });

  it('disables shell through the hierarchical tool status action', async () => {
    const { disableShellToolForCurrentChat } = useToolDependencyActions();

    await disableShellToolForCurrentChat();

    expect(mocks.setToolStatus).toHaveBeenCalledWith({
      name: 'shell_execute',
      status: 'disabled',
    });
  });

  it('disables sysfs for the current chat through Wesh preferences', async () => {
    const { disableNaidanSysfsForCurrentChat } = useToolDependencyActions();

    await disableNaidanSysfsForCurrentChat();

    expect(mocks.setNaidanSysfsAccessScope).toHaveBeenCalledWith({
      chatId: 'chat-1',
      accessScope: 'none',
    });
  });
});
