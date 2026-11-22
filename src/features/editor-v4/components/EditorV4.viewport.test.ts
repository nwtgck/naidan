import { mount } from '@vue/test-utils';
import { expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import EditorV4 from './EditorV4.vue';

it('measures wrapped line markers at the resized mirror width without a second resize', async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
  let notifyResize: (() => void) | undefined;
  vi.stubGlobal('ResizeObserver', vi.fn(function (notify: () => void) {
    notifyResize = notify;
    return { observe: vi.fn(), disconnect: vi.fn() };
  }));
  const createRange = document.createRange.bind(document);
  const rangeMock = vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = createRange();
    range.getBoundingClientRect = () => {
      const viewport = range.startContainer.parentElement?.closest<HTMLElement>('[data-testid="editor-v4-mirror-viewport"]');
      const width = parseFloat(viewport?.style.width ?? '0');
      const top = range.startOffset === 0 ? 8 : width >= 200 ? 28 : 48;
      return new DOMRect(0, top, 0, 20);
    };
    return range;
  });
  using _restore = {
    [Symbol.dispose]() {
      rangeMock.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    },
  };
  const wrapper = mount(EditorV4, {
    props: {
      initialText: `\
abcdefghijklmnopqrst
second line`,
      readOnly: false,
    },
  });
  using _unmount = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  let width = 320;
  const textarea = wrapper.get<HTMLTextAreaElement>('[data-testid="editor-v4-input"]').element;
  Object.defineProperty(textarea, 'clientWidth', { get: () => width });
  expect(notifyResize).toBeDefined();
  notifyResize?.();
  await vi.advanceTimersByTimeAsync(20);
  await wrapper.get('[data-testid="editor-v4-wrap-toggle"]').trigger('click');
  await vi.advanceTimersByTimeAsync(20);
  await nextTick();

  const secondLine = () => wrapper.findAll<HTMLElement>('[data-testid="editor-v4-line-marker"]').at(1)?.element.style.top;
  expect(wrapper.get<HTMLElement>('[data-testid="editor-v4-mirror-viewport"]').element.style.width).toBe('320px');
  expect(secondLine()).toBe('28px');

  width = 120;
  notifyResize?.();
  await vi.advanceTimersByTimeAsync(20);
  await nextTick();

  expect(wrapper.get<HTMLElement>('[data-testid="editor-v4-mirror-viewport"]').element.style.width).toBe('120px');
  expect(secondLine()).toBe('48px');
});
