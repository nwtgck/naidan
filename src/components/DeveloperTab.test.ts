import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import DeveloperTab from './DeveloperTab.vue';
import { usePWAUpdate } from '@/composables/usePWAUpdate';
import { useSettings } from '@/composables/useSettings';
import { useConfirm } from '@/composables/useConfirm';
import { useSampleChat } from '@/composables/useSampleChat';

// Mock composables
vi.mock('../composables/usePWAUpdate', () => ({
  usePWAUpdate: vi.fn(),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: vi.fn(),
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
  const toggleMarkdownRendering = vi.fn();
  const createSampleChat = vi.fn();
  const showConfirm = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    needRefresh.value = false;

    (usePWAUpdate as any).mockReturnValue({
      needRefresh,
      setNeedRefresh,
    });

    (useSettings as any).mockReturnValue({
      settings: ref({ experimental: { markdownRendering: 'monolithic_html' } }),
      toggleMarkdownRendering,
    });

    (useConfirm as any).mockReturnValue({
      showConfirm,
    });

    (useSampleChat as any).mockReturnValue({
      createSampleChat,
    });
  });

  it('renders correctly', () => {
    const wrapper = mount(DeveloperTab, {
      props: { storageType: 'localStorage' }
    });
    expect(wrapper.text()).toContain('Developer Tools');
    expect(wrapper.find('[data-testid="toggle-pwa-update-button"]').exists()).toBe(true);
  });

  it('toggles PWA update simulation when the button is clicked', async () => {
    const wrapper = mount(DeveloperTab, {
      props: { storageType: 'localStorage' }
    });

    const button = wrapper.find('[data-testid="toggle-pwa-update-button"]');
    await button.trigger('click');

    expect(setNeedRefresh).toHaveBeenCalledWith({
      refresh: true,
      handler: expect.any(Function),
    });
  });

  it('applies active styles when needRefresh is true', () => {
    needRefresh.value = true;
    const wrapper = mount(DeveloperTab, {
      props: { storageType: 'localStorage' }
    });

    const button = wrapper.find('[data-testid="toggle-pwa-update-button"]');
    expect(button.classes()).toContain('bg-emerald-50/30');
    expect(wrapper.find('.animate-spin-slow').exists()).toBe(true);
  });

  it('triggers Cache Storage clearing when the button is clicked and confirmed', async () => {
    showConfirm.mockResolvedValue(true);
    const wrapper = mount(DeveloperTab, {
      props: { storageType: 'localStorage' }
    });

    const button = wrapper.find('[data-testid="clear-all-cache-storage-button"]');
    await button.trigger('click');

    expect(showConfirm).toHaveBeenCalledWith({
      title: 'Clear All Cache Storage',
      message: expect.stringContaining('delete all entries in the browser\'s Cache Storage API'),
      confirmButtonText: 'Clear All',
      confirmButtonVariant: 'danger',
    });
  });
});
