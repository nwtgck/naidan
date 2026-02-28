import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import PWAManager from './PWAManager.vue';
import { usePWAUpdate } from '../composables/usePWAUpdate';
import { useGlobalEvents } from '../composables/useGlobalEvents';

// 1. Mock the virtual module
vi.mock('virtual:pwa-register/vue', () => ({
  useRegisterSW: vi.fn(),
}));

import { useRegisterSW } from 'virtual:pwa-register/vue';

// 2. Mock usePWAUpdate
vi.mock('../composables/usePWAUpdate', () => ({
  usePWAUpdate: vi.fn(),
}));

// 3. Mock useGlobalEvents
vi.mock('../composables/useGlobalEvents', () => ({
  useGlobalEvents: vi.fn(),
}));

describe('PWAManager', () => {
  const offlineReady = ref(false);
  const needRefresh = ref(false);
  const updateServiceWorker = vi.fn();
  const setNeedRefresh = vi.fn();
  const addInfoEvent = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    offlineReady.value = false;
    needRefresh.value = false;

    (useRegisterSW as any).mockReturnValue({
      offlineReady,
      needRefresh,
      updateServiceWorker,
    });

    (usePWAUpdate as any).mockReturnValue({
      setNeedRefresh,
    });

    (useGlobalEvents as any).mockReturnValue({
      addInfoEvent,
    });
  });

  it('adds an info event when offlineReady becomes true', async () => {
    mount(PWAManager);
    offlineReady.value = true;

    await vi.waitFor(() => {
      expect(addInfoEvent).toHaveBeenCalledWith({
        source: 'PWA',
        message: 'App ready to work offline',
      });
    });
  });
  it('updates the PWAUpdate store when needRefresh becomes true', async () => {
    mount(PWAManager);
    needRefresh.value = true;

    await vi.waitFor(() => {
      expect(setNeedRefresh).toHaveBeenCalledWith(expect.objectContaining({
        refresh: true,
        handler: expect.any(Function),
      }));
    });

    // Verify the handler calls updateServiceWorker
    const { handler } = (setNeedRefresh as any).mock.calls[0][0];
    await handler();
    expect(updateServiceWorker).toHaveBeenCalledTimes(1);
  });

  it('clears the update state when needRefresh becomes false', async () => {
    mount(PWAManager);
    needRefresh.value = false;

    await vi.waitFor(() => {
      expect(setNeedRefresh).toHaveBeenCalledWith({
        refresh: false,
        handler: undefined,
      });
    });
  });
});
