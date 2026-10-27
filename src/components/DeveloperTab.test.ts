import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import DeveloperTab from './DeveloperTab.vue';
import ActionButton from './ActionButton.vue';
import { usePWAUpdate } from '@/composables/usePWAUpdate';
import { useConfirm } from '@/composables/useConfirm';
import { useSampleChat } from '@/composables/useSampleChat';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';

vi.mock('../composables/useConfirm', () => ({
  useConfirm: vi.fn(),
}));

vi.mock('../composables/useSampleChat', () => ({
  useSampleChat: vi.fn(),
}));


vi.mock('@/features/transformers-js/model-support-investigation', () => ({
  isModelSupportInvestigationAvailable: true,
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({
    replace: vi.fn(),
  }),
}));

describe('DeveloperTab', () => {
  const { status, setUpdateState } = usePWAUpdate();
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

  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    vi.clearAllMocks();
    setUpdateState({ next: { kind: 'idle' } });

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
    expect(wrapper.find('[data-testid="data-deletion-factory-reset-preset-button"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="fake-lm-debug-mode-toggle"]').exists()).toBe(false);
  });

  it('requests the app-level model support investigation host with an empty target', async () => {
    const wrapper = mountDeveloperTab();

    await wrapper.find('[data-testid="open-model-support-investigation-button"]').trigger('click');

    expect(wrapper.emitted('openModelSupportInvestigation')).toEqual([['']]);
    expect(wrapper.find('[data-testid="model-support-investigation-stub"]').exists()).toBe(false);
  });

  it('creates a long sample chat when the long sample button is clicked', async () => {
    const wrapper = mountDeveloperTab();

    await wrapper.find('[data-testid="setting-create-long-sample-button"]').trigger('click');

    expect(createLongSampleChat).toHaveBeenCalled();
  });

  it('uses shared native buttons for developer actions and reserves danger for deletion', () => {
    const wrapper = mountDeveloperTab();
    const buttons = wrapper.findAllComponents(ActionButton);
    const sampleButton = buttons.find(button => button.attributes('data-testid') === 'setting-create-sample-button');
    const pwaButton = buttons.find(button => button.attributes('data-testid') === 'toggle-pwa-update-button');
    const resetButton = buttons.find(button => button.attributes('data-testid') === 'setting-reset-data-button');

    expect(sampleButton?.props('appearance')).toBe('primary');
    expect(pwaButton?.props('appearance')).toBe('primary');
    expect(resetButton?.props('appearance')).toBe('danger-filled');
    expect(sampleButton?.attributes('type')).toBe('button');
    expect(resetButton?.attributes('disabled')).toBeDefined();
  });

  it('toggles PWA update simulation when the button is clicked', async () => {
    const wrapper = mountDeveloperTab();

    const button = wrapper.find('[data-testid="toggle-pwa-update-button"]');
    await button.trigger('click');

    expect(status.value).toBe('ready');
    expect(button.attributes('aria-pressed')).toBe('true');
    await button.trigger('click');
    expect(status.value).toBe('idle');
    expect(button.attributes('aria-pressed')).toBe('false');
  });

  it('exposes the pressed state when an update is ready', () => {
    setUpdateState({ next: { kind: 'ready', handler: async () => {} } });
    const wrapper = mountDeveloperTab();

    const button = wrapper.find('[data-testid="toggle-pwa-update-button"]');
    expect(button.attributes('aria-pressed')).toBe('true');
    expect(wrapper.find('.animate-spin-slow').exists()).toBe(true);
  });

  it('can clear a preparing notification through the developer toggle', async () => {
    setUpdateState({ next: { kind: 'preparing' } });
    const wrapper = mountDeveloperTab();
    await wrapper.get('[data-testid="toggle-pwa-update-button"]').trigger('click');
    expect(status.value).toBe('idle');
  });

  it('uses the data deletion panel for Cache Storage deletion through the factory reset preset', async () => {
    showConfirm.mockResolvedValue(false);
    const wrapper = mountDeveloperTab();

    await wrapper.find('[data-testid="data-deletion-factory-reset-preset-button"]').trigger('click');
    const cacheStorageCheckbox = wrapper.find<HTMLInputElement>('[data-testid="data-deletion-checkbox-cache-storage-all"]');

    expect(cacheStorageCheckbox.element.checked).toBe(true);
    expect(wrapper.find('[data-testid="clear-all-cache-storage-button"]').exists()).toBe(false);
  });
});
