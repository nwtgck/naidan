import { mount } from '@vue/test-utils';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { useRouter } from 'vue-router';
import { useInitialRouteRenderReadinessClaim } from '@/composables/useInitialRouteRenderReadiness';
import SettingsIndexPage from './index.vue';

vi.mock('vue-router', () => ({
  useRouter: vi.fn(),
}));

vi.mock('@/composables/useInitialRouteRenderReadiness', () => ({
  useInitialRouteRenderReadinessClaim: vi.fn(),
}));

describe('settings index page', () => {
  it('keeps the initial route readiness claimed until the redirect replaces it', async () => {
    const replace = vi.fn(async () => {});
    const cancel = vi.fn();
    const reportReady = vi.fn();
    (useRouter as unknown as Mock).mockReturnValue({ replace });
    (useInitialRouteRenderReadinessClaim as unknown as Mock).mockReturnValue({
      reportReady,
      reportFailure: vi.fn(),
      cancel,
    });

    const wrapper = mount(SettingsIndexPage);
    await Promise.resolve();

    expect(replace).toHaveBeenCalledWith('/settings/connection');
    expect(reportReady).not.toHaveBeenCalled();

    wrapper.unmount();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
