import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import PWAUpdateNotification from './PWAUpdateNotification.vue';
import { usePWAUpdate } from '@/composables/usePWAUpdate';
import { ensureAllStringsForTest } from '@/strings/test-utils';

// Only the layout boundary is replaced. Use the real shared state and action.
const sidebar = vi.hoisted(() => ({ open: true }));
vi.mock('@/composables/useLayout', () => ({
  useLayout: () => ({ isSidebarOpen: ref(sidebar.open) }),
}));
const { setUpdateState, status } = usePWAUpdate();
enableAutoUnmount(afterEach);
beforeEach(async () => {
  sidebar.open = true;
  setUpdateState({ next: { kind: 'idle' } });
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  setUpdateState({ next: { kind: 'idle' } }); vi.restoreAllMocks();
});

describe('PWAUpdateNotification', () => {
  it('renders nothing when no update was detected', () => {
    const wrapper = mount(PWAUpdateNotification);
    expect(wrapper.find('[data-testid="pwa-update-button"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="pwa-online-update-warning"]').exists()).toBe(false);
  });

  it.each(['preparing', 'ready'] as const)('stays hidden with a closed sidebar while %s', kind => {
    sidebar.open = false;
    setUpdateState({ next: { kind, handler: async () => {} } });
    const wrapper = mount(PWAUpdateNotification);
    expect(wrapper.find('[data-testid="pwa-update-button"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="pwa-online-update-warning"]').exists()).toBe(false);
  });

  it('shows detection during preparation without enabling reload', async () => {
    setUpdateState({ next: { kind: 'preparing' } });
    const wrapper = mount(PWAUpdateNotification);
    const button = wrapper.get('[data-testid="pwa-update-button"]');
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.attributes('aria-busy')).toBe('false');
    expect(button.text()).toContain('Update found — preparing');
    expect(wrapper.find('[data-testid="pwa-online-update-warning"]').exists()).toBe(false);
    await button.trigger('click');
    expect(status.value).toBe('preparing');
    expect(button.find('[role="status"]').attributes('aria-live')).toBe('polite');
  });

  it('offers the actual reload action before precaching completes, with an offline warning', async () => {
    const handler = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    setUpdateState({ next: { kind: 'preparing', handler } });
    const wrapper = mount(PWAUpdateNotification);
    const button = wrapper.get('[data-testid="pwa-update-button"]');
    expect(button.attributes('disabled')).toBeUndefined();
    expect(button.text()).toContain('Reload to Update');
    const warning = wrapper.get('[data-testid="pwa-online-update-warning"]');
    expect(warning.text()).toContain('Offline use may be temporarily unavailable');
    // The warning belongs immediately below the action, not inside the button
    // or in a separate toast that could disappear before the user clicks.
    expect(button.element.nextElementSibling).toBe(warning.element);
    await button.trigger('click');
    expect(handler).toHaveBeenCalledOnce();
    expect(button.attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-testid="pwa-online-update-warning"]').exists()).toBe(false);
  });

  it('removes the network warning when the same update becomes offline-ready', async () => {
    const handler = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    setUpdateState({ next: { kind: 'preparing', handler } });
    const wrapper = mount(PWAUpdateNotification);
    const originalButton = wrapper.get('[data-testid="pwa-update-button"]').element;
    expect(wrapper.find('[data-testid="pwa-online-update-warning"]').exists()).toBe(true);

    setUpdateState({ next: { kind: 'ready', handler } });
    await nextTick();

    const button = wrapper.get('[data-testid="pwa-update-button"]');
    expect(button.element).toBe(originalButton);
    expect(button.attributes('disabled')).toBeUndefined();
    expect(button.text()).toContain('Reload to Update');
    expect(wrapper.find('[data-testid="pwa-online-update-warning"]').exists()).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('enables the same button only when preparation finishes', async () => {
    setUpdateState({ next: { kind: 'preparing' } });
    const wrapper = mount(PWAUpdateNotification);
    const original = wrapper.get('[data-testid="pwa-update-button"]').element;
    const handler = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    setUpdateState({ next: { kind: 'ready', handler } });
    await nextTick();
    const button = wrapper.get('[data-testid="pwa-update-button"]');
    expect(button.element).toBe(original);
    expect(button.attributes('disabled')).toBeUndefined();
    expect(button.text()).toContain('Reload to Update');
    expect(handler).not.toHaveBeenCalled();
    await button.trigger('click');
    expect(handler).toHaveBeenCalledOnce();
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.text()).toContain('Applying update');
  });

  it('renders an update already detected before the sidebar mounted', () => {
    setUpdateState({ next: { kind: 'ready', handler: async () => {} } });
    expect(mount(PWAUpdateNotification).text()).toContain('Reload to Update');
  });

  it('retains the update across notification remounts', () => {
    setUpdateState({ next: { kind: 'preparing' } });
    const first = mount(PWAUpdateNotification);
    first.unmount();
    expect(mount(PWAUpdateNotification).text()).toContain('Update found — preparing');
  });

  it('handles action failure without an unhandled rejection and allows retry', async () => {
    const error = new Error('update failed');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = vi.fn<() => Promise<void>>().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    setUpdateState({ next: { kind: 'ready', handler } });
    const wrapper = mount(PWAUpdateNotification);
    await wrapper.get('[data-testid="pwa-update-button"]').trigger('click');
    await flushPromises();
    expect(logged).toHaveBeenCalledWith('[PWA] Failed to apply the update.', error);
    expect(wrapper.get('[data-testid="pwa-update-button"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[data-testid="pwa-update-button"]').trigger('click');
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
