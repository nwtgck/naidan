import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import DeveloperTab from './DeveloperTab.vue';
import { usePWAUpdate } from '@/composables/usePWAUpdate';
import { useConfirm } from '@/composables/useConfirm';
import { useSampleChat } from '@/composables/useSampleChat';

// Mock composables
vi.mock('../composables/usePWAUpdate', () => ({
  usePWAUpdate: vi.fn(),
}));

vi.mock('../composables/useConfirm', () => ({
  useConfirm: vi.fn(),
}));

vi.mock('../composables/useSampleChat', () => ({
  useSampleChat: vi.fn(),
}));

const {
  mockFakeLmDebugModeAvailability,
  mockFakeLmSettings,
  mockPreloadFakeLmLanguagePacks,
  mockSaveSettings,
  mockSetFakeLmDebugModeStatus,
} = vi.hoisted(() => ({
  mockFakeLmDebugModeAvailability: { value: 'available' },
  mockFakeLmSettings: { value: { experimental: { fakeLm: 'disabled' } } },
  mockPreloadFakeLmLanguagePacks: vi.fn(),
  mockSaveSettings: vi.fn(),
  mockSetFakeLmDebugModeStatus: vi.fn(),
}));

vi.mock('@/services/fake-lm', () => ({
  FAKE_LM_ENDPOINT_URL: 'https://fake-lm.invalid',
  preloadFakeLmLanguagePacks: mockPreloadFakeLmLanguagePacks,
  useFakeLmDebugMode: () => ({
    fakeLmDebugModeAvailability: mockFakeLmDebugModeAvailability,
  }),
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: mockFakeLmSettings,
    save: mockSaveSettings,
    setFakeLmDebugModeStatus: mockSetFakeLmDebugModeStatus,
  }),
}));

describe('DeveloperTab', () => {
  const needRefresh = ref(false);
  const setNeedRefresh = vi.fn();
  const createSampleChat = vi.fn();
  const createLongSampleChat = vi.fn();
  const showConfirm = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    needRefresh.value = false;
    mockFakeLmDebugModeAvailability.value = 'available';
    mockFakeLmSettings.value = { experimental: { fakeLm: 'disabled' } };

    (usePWAUpdate as any).mockReturnValue({
      needRefresh,
      setNeedRefresh,
    });

    (useConfirm as any).mockReturnValue({
      showConfirm,
    });

    (useSampleChat as any).mockReturnValue({
      createSampleChat,
      createLongSampleChat,
    });
  });

  it('renders correctly', () => {
    const wrapper = mount(DeveloperTab, {
      props: { storageType: 'localStorage' }
    });
    expect(wrapper.text()).toContain('Developer Tools');
    expect(wrapper.find('[data-testid="toggle-pwa-update-button"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="setting-create-long-sample-button"]').exists()).toBe(true);
  });

  it('persists fake LM debug mode through settings', async () => {
    const wrapper = mount(DeveloperTab, {
      props: { storageType: 'localStorage' }
    });

    await wrapper.find('[data-testid="fake-lm-debug-mode-toggle"]').trigger('click');

    expect(mockSetFakeLmDebugModeStatus).toHaveBeenCalledWith({ status: 'enabled' });
  });

  it('creates a long sample chat when the long sample button is clicked', async () => {
    const wrapper = mount(DeveloperTab, {
      props: { storageType: 'localStorage' }
    });

    await wrapper.find('[data-testid="setting-create-long-sample-button"]').trigger('click');

    expect(createLongSampleChat).toHaveBeenCalled();
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
