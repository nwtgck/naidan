import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import WeshToolSettings from './WeshToolSettings.vue';

vi.mock('@vueuse/core', async () => {
  const actual = await vi.importActual<typeof import('@vueuse/core')>('@vueuse/core');
  return {
    ...actual,
    computedAsync: (fn: () => Promise<boolean>, initial: boolean) => {
      const state = ref(initial);
      fn().then((value) => {
        state.value = value;
      });
      return state;
    },
  };
});

const mockIsFeatureEnabled = vi.fn();
vi.mock('@/composables/useFeatureFlags', () => ({
  useFeatureFlags: () => ({
    isFeatureEnabled: mockIsFeatureEnabled,
  }),
}));

const mockIsToolEnabled = vi.fn();
const mockSetToolEnabled = vi.fn();
const mockToggleTool = vi.fn();
const mockGetNaidanSysfsMountSelection = vi.fn();
const mockSetNaidanSysfsMountSelection = vi.fn();
const mockCurrentChat = ref<{ id: string } | null>({ id: 'chat-1' });

vi.mock('@/composables/useChatTools', () => ({
  useChatTools: () => ({
    isToolEnabled: mockIsToolEnabled,
    setToolEnabled: mockSetToolEnabled,
    toggleTool: mockToggleTool,
  }),
}));

vi.mock('@/composables/useChatWeshPreferences', () => ({
  useChatWeshPreferences: () => ({
    getNaidanSysfsMountSelection: mockGetNaidanSysfsMountSelection,
    setNaidanSysfsMountSelection: mockSetNaidanSysfsMountSelection,
  }),
}));

vi.mock('@/composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
  }),
}));

vi.mock('@/services/storage/opfs-detection', () => ({
  checkOPFSSupport: vi.fn().mockResolvedValue(true),
}));

vi.mock('lucide-vue-next', () => ({
  TerminalIcon: { template: '<span>Terminal</span>' },
}));

describe('WeshToolSettings.vue', () => {
  beforeEach(() => {
    mockIsFeatureEnabled.mockReset();
    mockIsToolEnabled.mockReset();
    mockSetToolEnabled.mockReset();
    mockToggleTool.mockReset();
    mockGetNaidanSysfsMountSelection.mockReset();
    mockSetNaidanSysfsMountSelection.mockReset();
    mockCurrentChat.value = { id: 'chat-1' };

    mockIsFeatureEnabled.mockReturnValue(true);
    mockIsToolEnabled.mockImplementation(({ name }: { name: string }) => name === 'shell_execute');
    mockGetNaidanSysfsMountSelection.mockReturnValue('none');
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

  it('shows sysfs settings when shell in browser is enabled', async () => {
    const wrapper = mount(WeshToolSettings);
    await flushPromises();

    expect(wrapper.find('[data-testid="naidan-sysfs-settings"]').exists()).toBe(true);
  });

  it('defaults sysfs selection to current_chat_only when enabling shell in browser', async () => {
    mockIsToolEnabled.mockReturnValue(false);

    const wrapper = mount(WeshToolSettings);
    await flushPromises();

    await wrapper.find('[data-testid="tool-wesh-toggle"]').trigger('click');

    expect(mockToggleTool).toHaveBeenCalledWith({ name: 'shell_execute' });
    expect(mockSetNaidanSysfsMountSelection).toHaveBeenCalledWith({ chatId: 'chat-1', selection: 'current_chat_only' });
  });

  it('defaults sysfs mount enabling to current_chat_only', async () => {
    const wrapper = mount(WeshToolSettings);
    await flushPromises();

    await wrapper.find('[data-testid="naidan-sysfs-toggle"]').trigger('click');

    expect(mockSetNaidanSysfsMountSelection).toHaveBeenCalledWith({ chatId: 'chat-1', selection: 'current_chat_only' });
  });

  it('shows the visibility select when sysfs is already mounted', async () => {
    mockGetNaidanSysfsMountSelection.mockReturnValue('current_chat_only');

    const wrapper = mount(WeshToolSettings);
    await flushPromises();

    expect(wrapper.find('[data-testid="naidan-sysfs-visibility-select"]').exists()).toBe(true);
  });

  it('updates the visibility selection', async () => {
    mockGetNaidanSysfsMountSelection.mockReturnValue('current_chat_only');

    const wrapper = mount(WeshToolSettings);
    await flushPromises();

    await wrapper.find('[data-testid="naidan-sysfs-visibility-select"]').setValue('all_chats');

    expect(mockSetNaidanSysfsMountSelection).toHaveBeenCalledWith({ chatId: 'chat-1', selection: 'all_chats' });
  });

  it('preserves an existing sysfs selection when enabling shell in browser', async () => {
    mockIsToolEnabled.mockReturnValue(false);
    mockGetNaidanSysfsMountSelection.mockReturnValue('all_chats');

    const wrapper = mount(WeshToolSettings);
    await flushPromises();

    await wrapper.find('[data-testid="tool-wesh-toggle"]').trigger('click');

    expect(mockToggleTool).toHaveBeenCalledWith({ name: 'shell_execute' });
    expect(mockSetNaidanSysfsMountSelection).not.toHaveBeenCalledWith({ chatId: 'chat-1', selection: 'current_chat_only' });
  });
});
