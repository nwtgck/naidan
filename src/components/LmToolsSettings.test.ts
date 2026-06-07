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
const mockToggleTool = vi.fn();
const mockEnableWikipediaToolsForCurrentChat = vi.fn();
const mockDisableWikipediaToolsForCurrentChat = vi.fn();

vi.mock('@/composables/useFeatureFlags', () => ({
  useFeatureFlags: () => ({
    isFeatureEnabled: mockIsFeatureEnabled,
  }),
}));

vi.mock('@/composables/useChatTools', () => ({
  useChatTools: () => ({
    isToolEnabled: mockIsToolEnabled,
    toggleTool: mockToggleTool,
  }),
}));

vi.mock('@/composables/useToolDependencyActions', () => ({
  useToolDependencyActions: () => ({
    enableWikipediaToolsForCurrentChat: mockEnableWikipediaToolsForCurrentChat,
    disableWikipediaToolsForCurrentChat: mockDisableWikipediaToolsForCurrentChat,
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
  InfoIcon: { template: '<span>Info</span>' },
}));

describe('LmToolsSettings.vue', () => {
  beforeEach(() => {
    mockIsFeatureEnabled.mockReset();
    mockIsToolEnabled.mockReset();
    mockToggleTool.mockReset();
    mockEnableWikipediaToolsForCurrentChat.mockReset();
    mockDisableWikipediaToolsForCurrentChat.mockReset();
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

    expect(wrapper.get('[data-testid="tool-wikipedia-note"]').text()).toContain(
      'Wikipedia search keywords are sent to the external service without additional user approval.',
    );
  });

  it('enables wikipedia through dependency actions from the toggle', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);

    const wrapper = mount(LmToolsSettings);
    await flushPromises();
    await wrapper.find('[data-testid="tool-wikipedia-toggle"]').trigger('click');

    expect(mockEnableWikipediaToolsForCurrentChat).toHaveBeenCalledWith({});
  });

  it('disables wikipedia through dependency actions from the toggle', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);
    mockIsToolEnabled.mockImplementation(({ name }: { name: string }) =>
      name === WIKIPEDIA_SEARCH_TOOL_NAME || name === WIKIPEDIA_GET_PAGE_TOOL_NAME);

    const wrapper = mount(LmToolsSettings);
    await flushPromises();
    await wrapper.find('[data-testid="tool-wikipedia-toggle"]').trigger('click');

    expect(mockDisableWikipediaToolsForCurrentChat).toHaveBeenCalledWith({});
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

    expect(mockEnableWikipediaToolsForCurrentChat).toHaveBeenCalledWith({});
  });

  it('keeps calculator toggle behavior unchanged', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);

    const wrapper = mount(LmToolsSettings);
    await flushPromises();
    await wrapper.find('[data-testid="tool-calculator-toggle"]').trigger('click');

    expect(mockToggleTool).toHaveBeenCalledWith({ name: 'calculator' });
  });

  it('shows the sysfs usage note in the wikipedia card', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);

    const wrapper = mount(LmToolsSettings);
    await flushPromises();

    expect(wrapper.text()).toContain('Uses sysfs Naidan for page text');
  });
});
