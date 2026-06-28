import type { ChatId } from '@/01-models/ids';
import { toChatId } from '@/01-models/ids';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { computed, ref } from 'vue';
import WeshToolSettings from './WeshToolSettings.vue';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';

const mockIsFeatureEnabled = vi.fn();
vi.mock('@/composables/useFeatureFlags', () => ({
  useFeatureFlags: () => ({
    isFeatureEnabled: mockIsFeatureEnabled,
  }),
}));

const mockIsToolEnabled = vi.fn();
const mockSetToolEnabled = vi.fn();
const mockToggleTool = vi.fn();
const mockGetNaidanSysfsAccessScope = vi.fn();
const mockSetNaidanSysfsAccessScope = vi.fn();
const mockDisableNaidanSysfsForCurrentChat = vi.fn();
const mockDisableShellToolForCurrentChat = vi.fn();
const mockCurrentChat = ref<{ id: ChatId } | null>({ id: toChatId({ raw: 'chat-1' }) });
const mockSettings = ref({
  storageType: 'opfs' as 'opfs' | 'local' | 'memory',
  mounts: [],
});

vi.mock('@/features/tools/composables/useChatTools', () => ({
  useChatTools: () => ({
    isToolEnabled: mockIsToolEnabled,
    setToolEnabled: mockSetToolEnabled,
    toggleTool: mockToggleTool,
  }),
}));

vi.mock('@/features/tools/composables/useChatWeshPreferences', () => ({
  useChatWeshPreferences: () => ({
    getNaidanSysfsAccessScope: mockGetNaidanSysfsAccessScope,
    setNaidanSysfsAccessScope: mockSetNaidanSysfsAccessScope,
  }),
}));

vi.mock('@/features/tools/composables/useToolDependencyActions', () => ({
  useToolDependencyActions: () => ({
    disableNaidanSysfsForCurrentChat: mockDisableNaidanSysfsForCurrentChat,
    disableShellToolForCurrentChat: mockDisableShellToolForCurrentChat,
  }),
}));

vi.mock('@/composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: vi.fn(),
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: mockSettings,
  }),
}));

vi.mock('lucide-vue-next', () => ({
  TerminalIcon: { template: '<span>Terminal</span>' },
  InfoIcon: { template: '<span>Info</span>' },
}));

describe('WeshToolSettings.vue', () => {
  beforeEach(() => {
    mockIsFeatureEnabled.mockReset();
    mockIsToolEnabled.mockReset();
    mockSetToolEnabled.mockReset();
    mockToggleTool.mockReset();
    mockGetNaidanSysfsAccessScope.mockReset();
    mockSetNaidanSysfsAccessScope.mockReset();
    mockDisableNaidanSysfsForCurrentChat.mockReset();
    mockDisableShellToolForCurrentChat.mockReset();
    mockCurrentChat.value = { id: toChatId({ raw: 'chat-1' }) };
    mockSettings.value = {
      storageType: 'opfs',
      mounts: [],
    };

    mockIsFeatureEnabled.mockReturnValue(true);
    mockIsToolEnabled.mockImplementation(({ name }: { name: string }) => name === 'shell_execute');
    mockGetNaidanSysfsAccessScope.mockReturnValue('none');
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

  it('shows the shell toggle when the feature flag is enabled', async () => {
    const wrapper = mount(WeshToolSettings);
    await flushPromises();

    expect(wrapper.find('[data-testid="tool-wesh-toggle"]').exists()).toBe(true);
  });

  it('hides the shell toggle when the feature flag is disabled', async () => {
    mockIsFeatureEnabled.mockImplementation(({ feature }: { feature: string }) => feature !== 'wesh_tool');

    const wrapper = mount(WeshToolSettings);
    await flushPromises();

    expect(wrapper.find('[data-testid="tool-wesh-toggle"]').exists()).toBe(false);
  });

  it('shows shell settings as a full-width grid row when shell in browser is enabled', async () => {
    const wrapper = mount(WeshToolSettings);
    await flushPromises();

    const settings = wrapper.get('[data-testid="naidan-sysfs-settings"]');
    expect(settings.classes()).toContain('sm:col-span-2');
    expect(settings.text()).toContain('Shell settings');
    expect(settings.text()).not.toContain('Enabled');
  });

  it('shows a read-only note for local storage', async () => {
    mockSettings.value = {
      storageType: 'local',
      mounts: [],
    };

    const wrapper = mount(WeshToolSettings);
    await flushPromises();

    expect(wrapper.get('[data-testid="wesh-storage-mode-note"]').text()).toBe('Local and memory storage expose Wesh as read-only, without /tmp.');
  });

  it('defaults sysfs access scope to current_chat_only when enabling shell in browser', async () => {
    mockIsToolEnabled.mockReturnValue(false);

    const wrapper = mount(WeshToolSettings);
    await flushPromises();

    await wrapper.find('[data-testid="tool-wesh-toggle"]').trigger('click');

    expect(mockToggleTool).toHaveBeenCalledWith({ name: 'shell_execute' });
    expect(mockSetNaidanSysfsAccessScope).toHaveBeenCalledWith({ chatId: toChatId({ raw: 'chat-1' }), accessScope: 'current_chat_only' });
  });

  it('disables wikipedia tools when shell in browser is turned off', async () => {
    const wrapper = mount(WeshToolSettings);
    await flushPromises();

    await wrapper.find('[data-testid="tool-wesh-toggle"]').trigger('click');

    expect(mockDisableShellToolForCurrentChat).toHaveBeenCalledWith();
  });

  it('defaults sysfs mount enabling to current_chat_only', async () => {
    const wrapper = mount(WeshToolSettings);
    await flushPromises();

    await wrapper.find('[data-testid="naidan-sysfs-toggle"]').trigger('click');

    expect(mockSetNaidanSysfsAccessScope).toHaveBeenCalledWith({ chatId: toChatId({ raw: 'chat-1' }), accessScope: 'current_chat_only' });
  });

  it('shows the access scope select when sysfs is already mounted', async () => {
    mockGetNaidanSysfsAccessScope.mockReturnValue('current_chat_only');

    const wrapper = mount(WeshToolSettings);
    await flushPromises();

    expect(wrapper.find('[data-testid="naidan-sysfs-access-scope-select"]').exists()).toBe(true);
  });

  it('updates the access scope selection', async () => {
    mockGetNaidanSysfsAccessScope.mockReturnValue('current_chat_only');

    const wrapper = mount(WeshToolSettings);
    await flushPromises();

    await wrapper.find('[data-testid="naidan-sysfs-access-scope-select"]').setValue('main_chats');

    expect(mockSetNaidanSysfsAccessScope).toHaveBeenCalledWith({ chatId: toChatId({ raw: 'chat-1' }), accessScope: 'main_chats' });
  });

  it('preserves an existing sysfs access scope when enabling shell in browser', async () => {
    mockIsToolEnabled.mockReturnValue(false);
    mockGetNaidanSysfsAccessScope.mockReturnValue('main_chats');

    const wrapper = mount(WeshToolSettings);
    await flushPromises();

    await wrapper.find('[data-testid="tool-wesh-toggle"]').trigger('click');

    expect(mockToggleTool).toHaveBeenCalledWith({ name: 'shell_execute' });
    expect(mockSetNaidanSysfsAccessScope).not.toHaveBeenCalledWith({ chatId: toChatId({ raw: 'chat-1' }), accessScope: 'current_chat_only' });
  });

  it('disables wikipedia tools when sysfs is turned off', async () => {
    mockGetNaidanSysfsAccessScope.mockReturnValue('current_chat_only');

    const wrapper = mount(WeshToolSettings);
    await flushPromises();

    await wrapper.find('[data-testid="naidan-sysfs-toggle"]').trigger('click');

    expect(mockDisableNaidanSysfsForCurrentChat).toHaveBeenCalledWith();
  });
});
