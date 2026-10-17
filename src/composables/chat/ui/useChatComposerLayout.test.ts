import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { useChatComposerLayout } from './useChatComposerLayout';

enableAutoUnmount(afterEach);

describe('useChatComposerLayout', () => {
  const observers: { notify: () => void, disconnect: ReturnType<typeof vi.fn> }[] = [];

  beforeEach(() => {
    observers.length = 0;
    vi.stubGlobal('ResizeObserver', vi.fn(function (notify: () => void) {
      const observer = { notify, observe: vi.fn(), disconnect: vi.fn() };
      observers.push(observer);
      return observer;
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  function setupLayout({ initialDisplay }: { initialDisplay: 'visible' | 'hidden' }) {
    const input = document.createElement('div');
    const scroll = document.createElement('div');
    const composer = ref<HTMLElement | null>(input);
    const viewport = ref<HTMLElement | null>(scroll);
    const visibility = ref<'submerged' | 'peeking' | 'active'>('active');
    const display = ref<'visible' | 'hidden'>(initialDisplay);
    let inputBounds = new DOMRect(0, 480, 800, 120);
    let viewportBounds = new DOMRect(0, 80, 800, 520);
    input.getBoundingClientRect = () => inputBounds;
    scroll.getBoundingClientRect = () => viewportBounds;
    let layout: ReturnType<typeof useChatComposerLayout>;
    Object.defineProperty(scroll, 'clientHeight', { get: () => viewportBounds.height });
    Object.defineProperty(scroll, 'scrollHeight', { get: () => 2000 + (layout?.bottomPaddingPx.value ?? 0) });
    scroll.scrollTop = 1600;
    scroll.scrollTo = vi.fn();
    const wrapper = mount(defineComponent({
      setup() {
        layout = useChatComposerLayout({ composer, editor: ref(undefined), viewport, visibility, display });
        return () => h('div');
      },
    }), { attachTo: document.body });
    wrapper.element.append(input, scroll);
    return {
      layout: layout!,
      wrapper,
      composer,
      viewport,
      visibility,
      display,
      scroll,
      changeInput({ bounds }: { bounds: DOMRect }) {
        inputBounds = bounds;
      },
      changeViewport({ bounds }: { bounds: DOMRect }) {
        viewportBounds = bounds;
      },
    };
  }

  it('reserves the actual overlap rather than the full composer or a fixed height', async () => {
    const state = setupLayout({ initialDisplay: 'visible' });
    expect(state.layout.bottomPaddingPx.value).toBe(128);
    expect(state.layout.availableSpace.value).toEqual({ width: 800, height: 520 });
    // A flow sibling has already shortened the message viewport.
    state.changeViewport({ bounds: new DOMRect(0, 80, 800, 450) });
    observers[0]!.notify();
    await nextTick();
    expect(state.layout.bottomPaddingPx.value).toBe(58);
  });

  it('keeps a reader following the end when a taller composer changes the reserve', async () => {
    const state = setupLayout({ initialDisplay: 'visible' });
    await nextTick();
    vi.mocked(state.scroll.scrollTo).mockClear();
    state.scroll.scrollTop = state.scroll.scrollHeight - state.scroll.clientHeight - 20;
    state.changeInput({ bounds: new DOMRect(0, 300, 800, 300) });
    observers[0]!.notify();
    await nextTick();
    expect(state.layout.bottomPaddingPx.value).toBe(308);
    expect(state.scroll.scrollTo).toHaveBeenCalledWith({ top: 2308, behavior: 'instant' });
  });

  it('does not move a reader upthread or override a scroll made before the next render', async () => {
    const state = setupLayout({ initialDisplay: 'visible' });
    await nextTick();
    vi.mocked(state.scroll.scrollTo).mockClear();
    state.scroll.scrollTop = 200;
    state.changeInput({ bounds: new DOMRect(0, 300, 800, 300) });
    observers[0]!.notify();
    await nextTick();
    expect(state.scroll.scrollTop).toBe(200);
    expect(state.scroll.scrollTo).not.toHaveBeenCalled();
    state.scroll.scrollTop = state.scroll.scrollHeight - state.scroll.clientHeight;
    state.changeInput({ bounds: new DOMRect(0, 480, 800, 120) });
    observers[0]!.notify();
    state.scroll.scrollTop -= 100;
    await nextTick();
    expect(state.scroll.scrollTo).not.toHaveBeenCalled();
  });

  it('remeasures the visible strip after a transform and clears hidden or unmeasurable input', async () => {
    const state = setupLayout({ initialDisplay: 'visible' });
    state.changeInput({ bounds: new DOMRect(0, 568, 800, 120) });
    state.visibility.value = 'submerged';
    await nextTick();
    await nextTick();
    expect(state.layout.bottomPaddingPx.value).toBe(40);
    state.display.value = 'hidden';
    await nextTick();
    await nextTick();
    expect(state.layout.bottomPaddingPx.value).toBe(0);
    state.display.value = 'visible';
    state.changeInput({ bounds: new DOMRect() });
    state.layout.measure();
    expect(state.layout.bottomPaddingPx.value).toBe(0);
  });

  it('disconnects observers and ignores delayed measurements after unmount', async () => {
    const state = setupLayout({ initialDisplay: 'visible' });
    await nextTick();
    state.wrapper.unmount();
    expect(observers[0]!.disconnect).toHaveBeenCalled();
    state.changeInput({ bounds: new DOMRect(0, 200, 800, 400) });
    observers[0]!.notify();
    expect(state.layout.bottomPaddingPx.value).toBe(128);
  });

  it('requests one reflow for typography changes without repeating it for unchanged measurements', () => {
    const state = setupLayout({ initialDisplay: 'visible' });
    const initial = state.layout.availableSpace.value;
    state.composer.value!.style.fontSize = '20px';
    observers[0]!.notify();
    expect(state.layout.availableSpace.value).not.toBe(initial);
    const measured = state.layout.availableSpace.value;
    observers[0]!.notify();
    expect(state.layout.availableSpace.value).toBe(measured);
  });

  it('leaves the initial anchor alone but follows the end after hidden setup becomes visible', async () => {
    const initial = setupLayout({ initialDisplay: 'visible' });
    await nextTick();
    expect(initial.scroll.scrollTo).not.toHaveBeenCalled();
    initial.wrapper.unmount();
    const restored = setupLayout({ initialDisplay: 'hidden' });
    restored.scroll.scrollTop = restored.scroll.scrollHeight - restored.scroll.clientHeight;
    restored.display.value = 'visible';
    await flushPromises();
    expect(restored.scroll.scrollTo).toHaveBeenCalledWith({ top: 2128, behavior: 'instant' });
  });

  it('does not jump to the end when a shrinking composer moves a reader inside the new threshold', async () => {
    const state = setupLayout({ initialDisplay: 'visible' });
    state.changeInput({ bounds: new DOMRect(0, 300, 800, 300) });
    state.scroll.scrollTop = 200;
    state.layout.measure();
    await nextTick();
    vi.mocked(state.scroll.scrollTo).mockClear();
    state.scroll.scrollTop = state.scroll.scrollHeight - state.scroll.clientHeight - 170;
    state.changeInput({ bounds: new DOMRect(0, 480, 800, 120) });
    state.layout.measure();
    await nextTick();
    expect(state.scroll.scrollTo).not.toHaveBeenCalled();
  });

  it('does not reclassify a reader as following halfway through a shrinking animation', async () => {
    const state = setupLayout({ initialDisplay: 'visible' });
    state.scroll.scrollTop = state.scroll.scrollHeight - state.scroll.clientHeight - 170;
    state.layout.beginTransition({ event: { target: state.composer.value!, propertyName: 'transform' } });
    state.changeInput({ bounds: new DOMRect(0, 520, 800, 120) });
    state.layout.measure();
    await nextTick();
    // The first frame has moved the new distance inside the 150px threshold.
    state.changeInput({ bounds: new DOMRect(0, 560, 800, 120) });
    state.layout.measure();
    await nextTick();
    expect(state.scroll.scrollTo).not.toHaveBeenCalled();
    state.layout.finishTransition({ event: { target: state.composer.value!, propertyName: 'transform' } });
    expect(state.scroll.scrollTo).not.toHaveBeenCalled();
  });
});
