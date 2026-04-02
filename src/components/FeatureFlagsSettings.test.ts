import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import FeatureFlagsSettings from './FeatureFlagsSettings.vue';
import { useFeatureFlags } from '@/composables/useFeatureFlags';

const mockShowConfirm = vi.fn();

vi.mock('@/composables/useConfirm', () => ({
  useConfirm: () => ({
    showConfirm: mockShowConfirm,
  }),
}));

vi.mock('lucide-vue-next', () => ({
  AlertTriangleIcon: { template: '<span>AlertTriangle</span>' },
  FlaskConicalIcon: { template: '<span>FlaskConical</span>' },
  FolderIcon: { template: '<span>Folder</span>' },
  TerminalIcon: { template: '<span>Terminal</span>' },
}));

describe('FeatureFlagsSettings.vue', () => {
  beforeEach(() => {
    localStorage.clear();
    mockShowConfirm.mockReset();
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
});
