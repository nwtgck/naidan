import { defineComponent, h, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { useLiveHistoryScroll } from './useLiveHistoryScroll';

function fixture() {
  const viewport = ref<HTMLElement>();
  const content = ref<HTMLElement>();
  const revision = ref(0);
  const enabled = ref(true);
  const notifications: (() => void)[] = [];
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) {
      notifications.push(callback);
    }

    observe = vi.fn();
    disconnect = disconnect;
  });
  let api: ReturnType<typeof useLiveHistoryScroll> | undefined;
  const wrapper = mount(defineComponent({
    setup() {
      api = useLiveHistoryScroll({ viewport, content, revision: () => revision.value, enabled: () => enabled.value });
      return () => h('div', { ref: viewport }, h('div', { ref: content }));
    },
  }));
  if (!api || !viewport.value) {
    throw new Error('Scroll fixture did not mount');
  }
  const element = viewport.value;
  let height = 1500;
  Object.defineProperties(element, { scrollHeight: { get: () => height }, clientHeight: { value: 500 } });
  api.toLatest();
  return {
    api,
    element,
    revision,
    enabled,
    disconnect,
    wrapper,
    resize({ nextHeight }: { nextHeight: number }) {
      height = nextHeight;
      notifications.forEach(notify => notify());
    },
    [Symbol.dispose]() {
      wrapper.unmount();
      vi.unstubAllGlobals();
    },
  };
}

describe('message-only scroll ownership', () => {
  it('leaves the initial model catalog at the top and follows only an active conversation', async () => {
    using f = fixture();
    f.enabled.value = false;
    await flushPromises();
    expect(f.element.scrollTop).toBe(0);
    f.resize({ nextHeight: 3000 });
    f.revision.value++;
    await flushPromises();
    expect(f.element.scrollTop).toBe(0);
    // Scrolling onboarding does not offer a jump-to-latest chat action.
    f.element.scrollTop = 180;
    f.api.rememberScroll();
    f.resize({ nextHeight: 3200 });
    expect(f.element.scrollTop).toBe(180);
    expect(f.api.following.value).toBe(true);
    f.enabled.value = true;
    await flushPromises();
    expect(f.element.scrollTop).toBe(3200);
    f.enabled.value = false;
    await flushPromises();
    expect(f.element.scrollTop).toBe(0);
  });

  it('follows new content only while already following the bottom', async () => {
    using f = fixture();
    expect(f.element.scrollTop).toBe(1500);
    f.element.scrollTop = 200;
    f.api.rememberScroll();
    f.revision.value++;
    await flushPromises();
    expect(f.api.following.value).toBe(false);
    expect(f.element.scrollTop).toBe(200);
    f.resize({ nextHeight: 1800 });
    expect(f.element.scrollTop).toBe(200);
    f.api.toLatest();
    expect(f.element.scrollTop).toBe(1800);
    f.resize({ nextHeight: 2000 });
    expect(f.element.scrollTop).toBe(2000);
  });

  it('resumes following when the user returns near the bottom', async () => {
    using f = fixture();
    f.element.scrollTop = 100;
    f.api.rememberScroll();
    expect(f.api.following.value).toBe(false);
    f.element.scrollTop = 980;
    f.api.rememberScroll();
    f.resize({ nextHeight: 2100 });
    f.revision.value++;
    await flushPromises();
    expect(f.api.following.value).toBe(true);
    expect(f.element.scrollTop).toBe(2100);
  });

  it('disconnects observation and ignores a scheduled update after unmount', async () => {
    using f = fixture();
    f.revision.value++;
    f.wrapper.unmount();
    f.element.scrollTop = 55;
    f.resize({ nextHeight: 4000 });
    await flushPromises();
    expect(f.disconnect).toHaveBeenCalledOnce();
    expect(f.element.scrollTop).toBe(55);
  });
});
