import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import LmToolsSettings from './LmToolsSettings.vue';

const mockIsFeatureEnabled = vi.fn();
const mockSettings = ref({
  storageType: 'opfs' as const,
  mounts: [],
});
const mockIsToolEnabled = vi.fn();
const mockSetToolEnabled = vi.fn();
const mockToggleTool = vi.fn();

vi.mock('@/composables/useFeatureFlags', () => ({
  useFeatureFlags: () => ({
    isFeatureEnabled: mockIsFeatureEnabled,
  }),
}));

vi.mock('@/composables/useChatTools', () => ({
  useChatTools: () => ({
    isToolEnabled: mockIsToolEnabled,
    setToolEnabled: mockSetToolEnabled,
    toggleTool: mockToggleTool,
  }),
}));

vi.mock('@/composables/useChatWeshPreferences', () => ({
  useChatWeshPreferences: () => ({
    getNaidanSysfsMountSelection: vi.fn(() => 'none'),
    setNaidanSysfsMountSelection: vi.fn(),
  }),
}));

vi.mock('@/composables/useChat', () => ({
  useChat: () => ({
    currentChat: ref({ id: 'chat-1' }),
  }),
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: mockSettings,
  }),
}));

vi.mock('lucide-vue-next', () => ({
  CalculatorIcon: { template: '<span>Calculator</span>' },
  BookOpenIcon: { template: '<span>Wikipedia</span>' },
  TerminalIcon: { template: '<span>Terminal</span>' },
}));

describe('LmToolsSettings.vue', () => {
  beforeEach(() => {
    mockIsFeatureEnabled.mockReset();
    mockIsToolEnabled.mockReset();
    mockSetToolEnabled.mockReset();
    mockToggleTool.mockReset();
    mockSettings.value = {
      storageType: 'opfs',
      mounts: [],
    };
    mockIsToolEnabled.mockReturnValue(false);
  });

  it('hides shell in browser when the feature flag is disabled', async () => {
    mockIsFeatureEnabled.mockImplementation(({ feature }: { feature: string }) => feature !== 'wesh_tool');

    const wrapper = mount(LmToolsSettings);
    await flushPromises();

    expect(wrapper.find('[data-testid="tool-wesh-toggle"]').exists()).toBe(false);
  });

  it('shows shell in browser when the feature flag is enabled', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);

    const wrapper = mount(LmToolsSettings);
    await flushPromises();

    expect(wrapper.find('[data-testid="tool-wesh-toggle"]').exists()).toBe(true);
  });

  it('enables both wikipedia tools from the toggle', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);

    const wrapper = mount(LmToolsSettings);
    await flushPromises();
    await wrapper.find('[data-testid="tool-wikipedia-toggle"]').trigger('click');

    expect(mockSetToolEnabled).toHaveBeenNthCalledWith(1, { name: 'wikipedia_search', enabled: true });
    expect(mockSetToolEnabled).toHaveBeenNthCalledWith(2, { name: 'wikipedia_get_page', enabled: true });
  });

  it('disables both wikipedia tools from the toggle', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);
    mockIsToolEnabled.mockImplementation(({ name }: { name: string }) =>
      name === 'wikipedia_search' || name === 'wikipedia_get_page');

    const wrapper = mount(LmToolsSettings);
    await flushPromises();
    await wrapper.find('[data-testid="tool-wikipedia-toggle"]').trigger('click');

    expect(mockSetToolEnabled).toHaveBeenNthCalledWith(1, { name: 'wikipedia_search', enabled: false });
    expect(mockSetToolEnabled).toHaveBeenNthCalledWith(2, { name: 'wikipedia_get_page', enabled: false });
  });

  it('shows wikipedia as enabled only when both tools are enabled', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);
    mockIsToolEnabled.mockImplementation(({ name }: { name: string }) =>
      name === 'wikipedia_search' || name === 'wikipedia_get_page');

    const wrapper = mount(LmToolsSettings);
    await flushPromises();

    expect(wrapper.find('[data-testid="tool-wikipedia-toggle"]').classes().join(' ')).toContain('bg-blue-50');
  });

  it('repairs a broken partial wikipedia state on toggle', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);
    mockIsToolEnabled.mockImplementation(({ name }: { name: string }) => name === 'wikipedia_search');

    const wrapper = mount(LmToolsSettings);
    await flushPromises();
    await wrapper.find('[data-testid="tool-wikipedia-toggle"]').trigger('click');

    expect(mockSetToolEnabled).toHaveBeenNthCalledWith(1, { name: 'wikipedia_search', enabled: true });
    expect(mockSetToolEnabled).toHaveBeenNthCalledWith(2, { name: 'wikipedia_get_page', enabled: true });
  });
});
