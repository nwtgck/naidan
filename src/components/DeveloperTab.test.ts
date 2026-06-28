import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import DeveloperTab from './DeveloperTab.vue';
import { usePWAUpdate } from '@/composables/usePWAUpdate';
import { useConfirm } from '@/composables/useConfirm';
import { useSampleChat } from '@/composables/useSampleChat';

vi.mock('../composables/usePWAUpdate', () => ({
  usePWAUpdate: vi.fn(),
}));

vi.mock('../composables/useConfirm', () => ({
  useConfirm: vi.fn(),
}));

vi.mock('../composables/useSampleChat', () => ({
  useSampleChat: vi.fn(),
}));

describe('DeveloperTab', () => {
  const needRefresh = ref(false);
  const setNeedRefresh = vi.fn();
  const createSampleChat = vi.fn();
  const createLongSampleChat = vi.fn();
  const showConfirm = vi.fn();

  function mountDeveloperTab() {
    return mount(DeveloperTab, {
      props: { storageType: 'localStorage' },
      global: {
        stubs: {
          FeatureFlagsSettings: true,
          DeveloperOpenStateLinks: true,
        },
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    needRefresh.value = false;

    (usePWAUpdate as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      needRefresh,
      setNeedRefresh,
    });

    (useConfirm as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      showConfirm,
    });

    (useSampleChat as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      createSampleChat,
      createLongSampleChat,
    });
  });

  it('renders correctly without a standalone fake LM action button', async () => {
    const wrapper = mountDeveloperTab();

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('Developer Tools');
    });
    expect(wrapper.find('[data-testid="toggle-pwa-update-button"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="setting-create-long-sample-button"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="fake-lm-debug-mode-toggle"]').exists()).toBe(false);
  });

  it('creates a long sample chat when the long sample button is clicked', async () => {
    const wrapper = mountDeveloperTab();

    await wrapper.find('[data-testid="setting-create-long-sample-button"]').trigger('click');

    expect(createLongSampleChat).toHaveBeenCalled();
  });

  it('uses compact spacing for developer action buttons', () => {
    const wrapper = mountDeveloperTab();
    const sampleButton = wrapper.find('[data-testid="setting-create-sample-button"]');
    const pwaButton = wrapper.find('[data-testid="toggle-pwa-update-button"]');
    const resetButton = wrapper.find('[data-testid="setting-reset-data-button"]');

    expect(sampleButton.classes()).toEqual(expect.arrayContaining(['gap-2', 'px-4', 'py-3', 'rounded-xl']));
    expect(pwaButton.classes()).toEqual(expect.arrayContaining(['px-4', 'py-3', 'rounded-xl']));
    expect(pwaButton.find('[class~="p-1.5"]').exists()).toBe(true);
    expect(resetButton.classes()).toEqual(expect.arrayContaining(['px-4', 'py-3', 'rounded-xl']));
  });

  it('toggles PWA update simulation when the button is clicked', async () => {
    const wrapper = mountDeveloperTab();

    const button = wrapper.find('[data-testid="toggle-pwa-update-button"]');
    await button.trigger('click');

    expect(setNeedRefresh).toHaveBeenCalledWith({
      refresh: true,
      handler: expect.any(Function),
    });
  });

  it('applies active styles when needRefresh is true', () => {
    needRefresh.value = true;
    const wrapper = mountDeveloperTab();

    const button = wrapper.find('[data-testid="toggle-pwa-update-button"]');
    expect(button.classes()).toContain('bg-emerald-50/30');
    expect(wrapper.find('.animate-spin-slow').exists()).toBe(true);
  });

  it('triggers Cache Storage clearing when the button is clicked and confirmed', async () => {
    showConfirm.mockResolvedValue(true);
    const wrapper = mountDeveloperTab();

    const button = wrapper.find('[data-testid="clear-all-cache-storage-button"]');
    await button.trigger('click');

    await vi.waitFor(() => {
      expect(showConfirm).toHaveBeenCalledWith({
        title: 'Clear All Cache Storage',
        message: expect.stringContaining("delete all entries in the browser's Cache Storage API"),
        confirmButtonText: 'Clear All',
        confirmButtonVariant: 'danger',
      });
    });
  });
});
