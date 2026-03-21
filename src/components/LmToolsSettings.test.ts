import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import LmToolsSettings from './LmToolsSettings.vue';

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

vi.mock('@/composables/useChatTools', () => ({
  useChatTools: () => ({
    isToolEnabled: () => false,
    setToolEnabled: vi.fn(),
    toggleTool: vi.fn(),
  }),
}));

vi.mock('@/services/storage/opfs-detection', () => ({
  checkOPFSSupport: vi.fn().mockResolvedValue(true),
}));

vi.mock('lucide-vue-next', () => ({
  Calculator: { template: '<span>Calculator</span>' },
  Terminal: { template: '<span>Terminal</span>' },
}));

describe('LmToolsSettings.vue', () => {
  beforeEach(() => {
    mockIsFeatureEnabled.mockReset();
  });

  it('hides shell in browser when the feature flag is disabled', async () => {
    mockIsFeatureEnabled.mockImplementation(({ feature }: { feature: string }) => feature !== 'wesh_tool');

    const wrapper = mount(LmToolsSettings);
    await flushPromises();

    expect(wrapper.find('[data-testid="tool-shell-toggle"]').exists()).toBe(false);
  });

  it('shows shell in browser when the feature flag is enabled', async () => {
    mockIsFeatureEnabled.mockReturnValue(true);

    const wrapper = mount(LmToolsSettings);
    await flushPromises();

    expect(wrapper.find('[data-testid="tool-shell-toggle"]').exists()).toBe(true);
  });
});
