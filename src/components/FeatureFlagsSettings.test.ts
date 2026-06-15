import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import FeatureFlagsSettings from './FeatureFlagsSettings.vue';
import { useFeatureFlags } from '@/composables/useFeatureFlags';

const mockShowConfirm = vi.fn();
const mockSaveSettings = vi.fn();
const mockSettings = ref({
  endpointType: 'openai',
  endpointUrl: 'http://localhost',
  storageType: 'local',
  autoTitleEnabled: true,
  defaultModelId: 'gpt-4',
  providerProfiles: [],
  mounts: [],
  experimental: undefined as { toolConfigPersistence?: 'disabled' | 'enabled'; sidebarSendMessageReorder?: 'disabled' | 'move_sent_chat' } | undefined,
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
  }),
}));

vi.mock('lucide-vue-next', () => ({
  AlertTriangleIcon: { template: '<span>AlertTriangle</span>' },
  FlaskConicalIcon: { template: '<span>FlaskConical</span>' },
  FolderIcon: { template: '<span>Folder</span>' },
  ListRestartIcon: { template: '<span>ListRestart</span>' },
  TerminalIcon: { template: '<span>Terminal</span>' },
}));

describe('FeatureFlagsSettings.vue', () => {
  beforeEach(() => {
    localStorage.clear();
    mockShowConfirm.mockReset();
    mockSaveSettings.mockReset();
    mockSettings.value.experimental = undefined;
    const { TEST_ONLY } = useFeatureFlags();
    TEST_ONLY.reset();
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

    expect(mockShowConfirm).toHaveBeenCalled();
    expect(useFeatureFlags().isFeatureEnabled({ feature: 'volume' })).toBe(true);
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
    });
  });
});
