import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import PWAUpdateNotification from './PWAUpdateNotification.vue';
import { usePWAUpdate } from '../composables/usePWAUpdate';
import { useLayout } from '../composables/useLayout';

// Mock usePWAUpdate
vi.mock('../composables/usePWAUpdate', () => ({
  usePWAUpdate: vi.fn(),
}));

// Mock useLayout
vi.mock('../composables/useLayout', () => ({
  useLayout: vi.fn(),
}));

describe('PWAUpdateNotification', () => {
  const mockUpdate = vi.fn();
  const needRefresh = ref(false);
  const isSidebarOpen = ref(true);

  beforeEach(() => {
    vi.clearAllMocks();
    needRefresh.value = false;
    isSidebarOpen.value = true;

    (usePWAUpdate as any).mockReturnValue({
      needRefresh,
      update: mockUpdate,
    });

    (useLayout as any).mockReturnValue({
      isSidebarOpen,
    });
  });

  it('renders nothing when no refresh is needed', () => {
    needRefresh.value = false;
    const wrapper = mount(PWAUpdateNotification);
    expect(wrapper.find('[data-testid="pwa-update-button"]').exists()).toBe(false);
  });

  it('renders nothing when sidebar is closed even if refresh is needed', () => {
    needRefresh.value = true;
    isSidebarOpen.value = false;
    const wrapper = mount(PWAUpdateNotification);
    expect(wrapper.find('[data-testid="pwa-update-button"]').exists()).toBe(false);
  });

  it('renders the update button when refresh is needed and sidebar is open', () => {
    needRefresh.value = true;
    isSidebarOpen.value = true;
    const wrapper = mount(PWAUpdateNotification);
    expect(wrapper.find('[data-testid="pwa-update-button"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Reload to Update');
  });

  it('calls update function when button is clicked', async () => {
    needRefresh.value = true;
    isSidebarOpen.value = true;
    const wrapper = mount(PWAUpdateNotification);
    await wrapper.find('[data-testid="pwa-update-button"]').trigger('click');
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });
});
