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
  AlertTriangle: { template: '<span>AlertTriangle</span>' },
  FlaskConical: { template: '<span>FlaskConical</span>' },
  Folder: { template: '<span>Folder</span>' },
  Terminal: { template: '<span>Terminal</span>' },
}));

describe('FeatureFlagsSettings.vue', () => {
  beforeEach(() => {
    localStorage.clear();
    mockShowConfirm.mockReset();
    const { __testOnly } = useFeatureFlags();
    __testOnly.reset();
  });

  it('asks for confirmation before enabling a feature', async () => {
    mockShowConfirm.mockResolvedValue(true);

    const wrapper = mount(FeatureFlagsSettings);
    await wrapper.find('[data-testid="feature-flag-volume-toggle"]').trigger('click');

    expect(mockShowConfirm).toHaveBeenCalled();
    expect(useFeatureFlags().isFeatureEnabled({ feature: 'volume' })).toBe(true);
  });

  it('does not enable a feature when confirmation is rejected', async () => {
    mockShowConfirm.mockResolvedValue(false);

    const wrapper = mount(FeatureFlagsSettings);
    await wrapper.find('[data-testid="feature-flag-wesh-tool-toggle"]').trigger('click');

    expect(useFeatureFlags().isFeatureEnabled({ feature: 'wesh_tool' })).toBe(false);
  });
});
