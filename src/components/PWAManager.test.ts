import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import PWAManager from './PWAManager.vue';

// Mock one public boundary, typed against the real runtime. No App/router/theme
// substitutes are needed, and an added application dependency needs no fixture edit.
const runtime = vi.hoisted(() => ({
  imported: vi.fn(),
  start: vi.fn<typeof import('@/composables/pwa-update-runtime').startPWAUpdateRuntime>(),
}));
vi.mock('@/composables/pwa-update-runtime', () => {
  runtime.imported();
  return { startPWAUpdateRuntime: runtime.start };
});

enableAutoUnmount(afterEach);
let frames: FrameRequestCallback[];

beforeEach(() => {
  frames = [];
  vi.clearAllMocks();
  runtime.start.mockReset();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    frames.push(callback);
    return frames.length;
  });
});
afterEach(() => vi.restoreAllMocks());

async function paint(): Promise<void> {
  await nextTick();
  frames.shift()?.(0);
  await flushPromises();
  frames.shift()?.(16);
  await flushPromises();
  await vi.dynamicImportSettled();
}

describe('PWAManager post-surface-paint startup', () => {
  it('does not import or start registration before a full paint opportunity', async () => {
    mount(PWAManager);
    expect(runtime.imported).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
    await nextTick();
    expect(frames).toHaveLength(1);
    frames.shift()?.(0);
    await flushPromises();
    expect(runtime.imported).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
    frames.shift()?.(16);
    await flushPromises();
    await vi.dynamicImportSettled();
    expect(runtime.start).toHaveBeenCalledOnce();
  });

  it('does not start after the auxiliary UI unmounts during its paint wait', async () => {
    const wrapper = mount(PWAManager);
    await nextTick();
    wrapper.unmount();
    await paint();
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it('does not schedule a frame if unmounted before the DOM flush', async () => {
    const wrapper = mount(PWAManager);
    wrapper.unmount();
    await nextTick();
    expect(frames).toHaveLength(0);
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it('isolates registration startup failure from the Vue app', async () => {
    const error = new Error('registration failed');
    runtime.start.mockImplementation(() => {
      throw error;
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mount(PWAManager);
    await paint();
    expect(logged).toHaveBeenCalledWith('[PWA] Failed to start post-paint update checks.', error);
  });

  it.each([1, 2])('isolates failure while scheduling frame %s', async failingFrame => {
    const error = new Error('frame scheduling failed');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    vi.mocked(window.requestAnimationFrame).mockImplementation(callback => {
      if (++calls === failingFrame) throw error;
      frames.push(callback);
      return calls;
    });
    mount(PWAManager);
    await paint();
    expect(runtime.start).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith('[PWA] Failed to start post-paint update checks.', error);
  });
});
