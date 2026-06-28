import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import FeatureFlagsSettings from './FeatureFlagsSettings.vue';
import { useFeatureFlags } from '@/composables/useFeatureFlags';
import { ensureAllStringsForTest } from '@/strings/test-utils';

const {
  mockFakeLmDebugModeAvailability,
  mockPreloadFakeLmLanguagePacks,
  mockSetFakeLmDebugModeStatus,
} = vi.hoisted(() => ({
  mockFakeLmDebugModeAvailability: { value: 'available' },
  mockPreloadFakeLmLanguagePacks: vi.fn(),
  mockSetFakeLmDebugModeStatus: vi.fn(),
}));
const mockShowConfirm = vi.fn();
const mockSaveSettings = vi.fn();
const mockSettings = ref({
  endpoint: {
    type: 'openai',
    url: 'http://localhost',
  },
  storageType: 'local',
  autoTitleEnabled: true,
  defaultModelId: 'gpt-4',
  providerProfiles: [],
  mounts: [],
  experimental: undefined as {
    fakeLm?: 'disabled' | 'enabled',
    toolConfigPersistence?: 'disabled' | 'enabled',
    sidebarSendMessageReorder?: 'disabled' | 'move_sent_chat',
  } | undefined,
});

vi.mock('@/composables/useConfirm', () => ({
  useConfirm: () => ({
    showConfirm: mockShowConfirm,
  }),
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: mockSettings,
    save: mockSaveSettings,
    setFakeLmDebugModeStatus: mockSetFakeLmDebugModeStatus,
  }),
}));

vi.mock('@/services/fake-lm', () => ({
  FAKE_LM_ENDPOINT_URL: 'https://fake-lm.invalid',
  preloadFakeLmLanguagePacks: mockPreloadFakeLmLanguagePacks,
  useFakeLmDebugMode: () => ({
    fakeLmDebugModeAvailability: mockFakeLmDebugModeAvailability,
  }),
}));

vi.mock('lucide-vue-next', () => ({
  AlertTriangleIcon: { template: '<span>AlertTriangle</span>' },
  ChevronDownIcon: { template: '<span>ChevronDown</span>' },
  FlaskConicalIcon: { template: '<span>FlaskConical</span>' },
  FolderIcon: { template: '<span>Folder</span>' },
  ListRestartIcon: { template: '<span>ListRestart</span>' },
  TerminalIcon: { template: '<span>Terminal</span>' },
}));

describe('FeatureFlagsSettings.vue', () => {
  beforeEach(async () => {
    localStorage.clear();
    mockShowConfirm.mockReset();
    mockSaveSettings.mockReset();
    mockSetFakeLmDebugModeStatus.mockReset();
    mockPreloadFakeLmLanguagePacks.mockReset();
    mockFakeLmDebugModeAvailability.value = 'available';
    mockSettings.value.experimental = undefined;
    const { TEST_ONLY } = useFeatureFlags();
    TEST_ONLY.reset();
    await ensureAllStringsForTest({ locale: 'en' });
  });

  it('renders all feature controls in one vertical settings list', () => {
    const wrapper = mount(FeatureFlagsSettings);
    const list = wrapper.find('[data-testid="experimental-feature-list"]');

    expect(list.findAll('[data-testid$="-row"]')).toHaveLength(5);
    expect(list.classes()).toContain('divide-y');
    expect(list.classes().some(className => className.includes('grid-cols'))).toBe(false);
    expect(wrapper.find('[data-testid="feature-volume-row"] > div').classes()).toContain('flex-wrap');
    expect(wrapper.find('[data-testid="feature-fake-lm-row"]').exists()).toBe(true);
  });

  it('keeps long descriptions collapsed until details are requested', async () => {
    const wrapper = mount(FeatureFlagsSettings);
    const details = wrapper.find('[data-testid="feature-volume-details"]');
    const toggle = wrapper.find('[data-testid="feature-volume-details-toggle"]');

    expect(details.attributes('aria-hidden')).toBe('true');
    expect(details.classes()).toContain('grid-rows-[0fr]');
    expect(toggle.attributes('aria-expanded')).toBe('false');

    await toggle.trigger('click');

    expect(details.attributes('aria-hidden')).toBe('false');
    expect(details.classes()).toContain('grid-rows-[1fr]');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(details.text()).toContain('Enabled by default for this browser profile.');
  });

  it('animates details while respecting reduced motion preferences', () => {
    const wrapper = mount(FeatureFlagsSettings);
    const details = wrapper.find('[data-testid="feature-volume-details"]');
    const detailsContent = details.find('.overflow-hidden > div');

    expect(details.classes()).toContain('transition-[grid-template-rows]');
    expect(details.classes()).toContain('duration-200');
    expect(details.classes()).toContain('motion-reduce:transition-none');
    expect(detailsContent.classes()).toContain('transition-[opacity,transform]');
    expect(detailsContent.classes()).toContain('motion-reduce:transition-none');
  });

  it('uses neutral surfaces and limits warning color to status accents', () => {
    const wrapper = mount(FeatureFlagsSettings);
    const row = wrapper.find('[data-testid="feature-volume-row"]');
    const warning = wrapper.find('[data-testid="experimental-feature-warning"]');

    expect(row.classes()).toContain('bg-white/70');
    expect(row.classes().some(className => className.includes('bg-amber'))).toBe(false);
    expect(warning.classes()).toContain('bg-gray-50/70');
    expect(warning.classes().some(className => className.includes('bg-amber'))).toBe(false);
  });

  it('exposes feature toggles as accessible switches', async () => {
    const wrapper = mount(FeatureFlagsSettings);
    const toggle = wrapper.find('[data-testid="feature-flag-volume-toggle"]');

    expect(toggle.attributes('role')).toBe('switch');
    expect(toggle.attributes('aria-checked')).toBe('true');

    await toggle.trigger('click');

    expect(toggle.attributes('aria-checked')).toBe('false');
  });

  it('disables a feature immediately when it is currently enabled', async () => {
    const wrapper = mount(FeatureFlagsSettings);
    await wrapper.find('[data-testid="feature-flag-volume-toggle"]').trigger('click');

    expect(mockShowConfirm).not.toHaveBeenCalled();
    expect(useFeatureFlags().isFeatureEnabled({ feature: 'volume' })).toBe(false);
  });

  it('does not re-enable a feature when confirmation is rejected', async () => {
    mockShowConfirm.mockResolvedValue(false);

    const wrapper = mount(FeatureFlagsSettings);
    await wrapper.find('[data-testid="feature-flag-wesh-tool-toggle"]').trigger('click');
    await wrapper.find('[data-testid="feature-flag-wesh-tool-toggle"]').trigger('click');

    expect(useFeatureFlags().isFeatureEnabled({ feature: 'wesh_tool' })).toBe(false);
  });

  it('asks for confirmation before re-enabling a feature', async () => {
    mockShowConfirm.mockResolvedValue(true);

    const wrapper = mount(FeatureFlagsSettings);
    await wrapper.find('[data-testid="feature-flag-volume-toggle"]').trigger('click');
    await wrapper.find('[data-testid="feature-flag-volume-toggle"]').trigger('click');

    await vi.waitFor(() => {
      expect(mockShowConfirm).toHaveBeenCalled();
      expect(useFeatureFlags().isFeatureEnabled({ feature: 'volume' })).toBe(true);
    });
  });

  it('describes persistence across Global, Chat Group, and Chat layers', () => {
    const wrapper = mount(FeatureFlagsSettings);

    expect(wrapper.text()).toContain('Saves Global, Chat Group, and Chat tool settings.');
    expect(wrapper.text()).toContain('Saved settings remain active.');
  });

  it('auto-saves the tool config persistence setting when toggled', async () => {
    const wrapper = mount(FeatureFlagsSettings);
    await wrapper.find('[data-testid="feature-tool-config-persistence-toggle"]').trigger('click');

    expect(mockSaveSettings).toHaveBeenCalledWith({
      patch: {
        experimental: {
          toolConfigPersistence: 'enabled',
        },
      },
      modelRefresh: 'await',
    });
  });

  it('auto-saves the sidebar send reorder setting when toggled', async () => {
    const wrapper = mount(FeatureFlagsSettings);
    await wrapper.find('[data-testid="feature-sidebar-send-reorder-toggle"]').trigger('click');

    expect(mockSaveSettings).toHaveBeenCalledWith({
      patch: {
        experimental: {
          sidebarSendMessageReorder: 'move_sent_chat',
        },
      },
      modelRefresh: 'await',
    });
  });

  it('persists fake LM debug mode through settings', async () => {
    const wrapper = mount(FeatureFlagsSettings);

    await wrapper.find('[data-testid="feature-fake-lm-toggle"]').trigger('click');

    expect(mockSetFakeLmDebugModeStatus).toHaveBeenCalledWith({ status: 'enabled' });
  });

  it('preloads fake LM language packs when the settings list is created', () => {
    mount(FeatureFlagsSettings);

    expect(mockPreloadFakeLmLanguagePacks).toHaveBeenCalledTimes(1);
  });

  it('disables fake LM in standalone builds and explains why', async () => {
    mockFakeLmDebugModeAvailability.value = 'unavailable_in_standalone';
    const wrapper = mount(FeatureFlagsSettings);
    const toggle = wrapper.find('[data-testid="feature-fake-lm-toggle"]');

    expect(toggle.attributes('disabled')).toBeDefined();

    await wrapper.find('[data-testid="feature-fake-lm-details-toggle"]').trigger('click');

    expect(wrapper.find('[data-testid="feature-fake-lm-details"]').text()).toContain(
      'Hosted build only. Standalone builds do not bundle fake LM.',
    );
  });
});
