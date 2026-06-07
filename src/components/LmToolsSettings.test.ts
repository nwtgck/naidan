import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import LmToolsSettings from './LmToolsSettings.vue';
import {
  WIKIPEDIA_GET_PAGE_TOOL_NAME,
  WIKIPEDIA_SEARCH_TOOL_NAME,
} from '@/services/tools/wikipedia';

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

  it('shows the wikipedia toggle', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);

    const wrapper = mount(LmToolsSettings);
    await flushPromises();

    expect(wrapper.find('[data-testid="tool-wikipedia-toggle"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="tool-wikipedia-note"]').exists()).toBe(false);
  });

  it('shows the wikipedia note only when both wikipedia tools are enabled', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);
    mockIsToolEnabled.mockImplementation(({ name }: { name: string }) =>
      name === WIKIPEDIA_SEARCH_TOOL_NAME || name === WIKIPEDIA_GET_PAGE_TOOL_NAME);

    const wrapper = mount(LmToolsSettings);
    await flushPromises();

    expect(wrapper.get('[data-testid="tool-wikipedia-note"]').text()).toBe(
      'Search keywords are sent to Wikipedia without additional user approval.',
    );
    expect(wrapper.get('[data-testid="tool-wikipedia-note"] span').text()).toBe(
      'without additional user approval',
    );
  });

  it('enables both wikipedia tools from the toggle', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);

    const wrapper = mount(LmToolsSettings);
    await flushPromises();
    await wrapper.find('[data-testid="tool-wikipedia-toggle"]').trigger('click');

    expect(mockSetToolEnabled).toHaveBeenNthCalledWith(1, { name: WIKIPEDIA_SEARCH_TOOL_NAME, enabled: true });
    expect(mockSetToolEnabled).toHaveBeenNthCalledWith(2, { name: WIKIPEDIA_GET_PAGE_TOOL_NAME, enabled: true });
  });

  it('disables both wikipedia tools from the toggle', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);
    mockIsToolEnabled.mockImplementation(({ name }: { name: string }) =>
      name === WIKIPEDIA_SEARCH_TOOL_NAME || name === WIKIPEDIA_GET_PAGE_TOOL_NAME);

    const wrapper = mount(LmToolsSettings);
    await flushPromises();
    await wrapper.find('[data-testid="tool-wikipedia-toggle"]').trigger('click');

    expect(mockSetToolEnabled).toHaveBeenNthCalledWith(1, { name: WIKIPEDIA_SEARCH_TOOL_NAME, enabled: false });
    expect(mockSetToolEnabled).toHaveBeenNthCalledWith(2, { name: WIKIPEDIA_GET_PAGE_TOOL_NAME, enabled: false });
  });

  it('shows wikipedia as enabled only when both tools are enabled', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);
    mockIsToolEnabled.mockImplementation(({ name }: { name: string }) =>
      name === WIKIPEDIA_SEARCH_TOOL_NAME || name === WIKIPEDIA_GET_PAGE_TOOL_NAME);

    const wrapper = mount(LmToolsSettings);
    await flushPromises();

    expect(wrapper.find('[data-testid="tool-wikipedia-toggle"]').classes().join(' ')).toContain('bg-blue-50');
  });

  it('repairs a broken partial wikipedia state on toggle', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);
    mockIsToolEnabled.mockImplementation(({ name }: { name: string }) => name === WIKIPEDIA_SEARCH_TOOL_NAME);

    const wrapper = mount(LmToolsSettings);
    await flushPromises();
    await wrapper.find('[data-testid="tool-wikipedia-toggle"]').trigger('click');

    expect(mockSetToolEnabled).toHaveBeenNthCalledWith(1, { name: WIKIPEDIA_SEARCH_TOOL_NAME, enabled: true });
    expect(mockSetToolEnabled).toHaveBeenNthCalledWith(2, { name: WIKIPEDIA_GET_PAGE_TOOL_NAME, enabled: true });
  });

  it('keeps calculator toggle behavior unchanged', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);

    const wrapper = mount(LmToolsSettings);
    await flushPromises();
    await wrapper.find('[data-testid="tool-calculator-toggle"]').trigger('click');

    expect(mockToggleTool).toHaveBeenCalledWith({ name: 'calculator' });
  });
});
