import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, shallowRef } from 'vue';
import { mount } from '@vue/test-utils';
import { calculateChatModelRecoveryLayout, useChatModelRecoveryLayout } from './useChatModelRecoveryLayout';

function rect({ left, top, width, height }: { left: number, top: number, width: number, height: number }) {
  return { left, top, right: left + width, bottom: top + height };
}

function geometry() {
  return {
    anchor: rect({ left: 120, top: 700, width: 700, height: 100 }),
    anchorViewport: rect({ left: 120, top: 700, width: 700, height: 100 }),
    anchorClip: rect({ left: 100, top: 700, width: 800, height: 300 }),
    root: rect({ left: 100, top: 40, width: 800, height: 960 }),
    viewport: rect({ left: 100, top: 100, width: 800, height: 900 }),
    visual: rect({ left: 0, top: 0, width: 1200, height: 1000 }),
  };
}

describe('recovery frame geometry', () => {
  it('keeps a common bottom and compact reserve while expanding below the header', () => {
    const value = calculateChatModelRecoveryLayout(geometry());
    expect(value).toEqual({ left: 20, bottom: 200, width: 700, compactHeight: 100, expandedHeight: 688 });
  });

  it('caps expansion at 720 without changing the compact footprint', () => {
    const input = geometry();
    input.viewport.top = 0;
    expect(calculateChatModelRecoveryLayout(input)).toMatchObject({ compactHeight: 100, expandedHeight: 720 });
  });

  it('uses the visible slot instead of the natural height of a long model ID', () => {
    const input = geometry();
    input.anchor = rect({ left: 120, top: 600, width: 700, height: 500 });
    input.anchorViewport = rect({ left: 120, top: 600, width: 700, height: 180 });
    input.anchorClip.top = 600;
    expect(calculateChatModelRecoveryLayout(input)).toMatchObject({ compactHeight: 180, bottom: 220, expandedHeight: 668 });
  });

  it('intersects both composer overflow and the visual viewport during keyboard or pinch changes', () => {
    const input = geometry();
    input.visual = rect({ left: 150, top: 150, width: 500, height: 600 });
    input.anchorClip.top = 720;
    expect(calculateChatModelRecoveryLayout(input)).toEqual({ left: 50, bottom: 250, width: 500, compactHeight: 30, expandedHeight: 600 });
  });

  it('does not cover the header in a low viewport or render an offscreen anchor', () => {
    const input = geometry();
    input.viewport.top = 750;
    expect(calculateChatModelRecoveryLayout(input)).toMatchObject({ compactHeight: 38, expandedHeight: 38 });
    input.visual.bottom = 700;
    expect(calculateChatModelRecoveryLayout(input)).toBeUndefined();
  });

  it('does not position a zero-width or disconnected layout placeholder', () => {
    const input = geometry();
    input.anchor.right = input.anchor.left;
    expect(calculateChatModelRecoveryLayout(input)).toBeUndefined();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function measuredElement({ bounds, height }: { bounds: ReturnType<typeof rect>, height: number }) {
  const element = document.createElement('div');
  let currentBounds = bounds;
  let currentHeight = height;
  const read = vi.fn(() => new DOMRect(currentBounds.left, currentBounds.top, currentBounds.right - currentBounds.left, currentBounds.bottom - currentBounds.top));
  element.getBoundingClientRect = read;
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => currentHeight });
  return {
    element,
    read,
    change({ bounds, height }: { bounds: ReturnType<typeof rect>, height: number }) {
      currentBounds = bounds;
      currentHeight = height;
    },
  };
}

function mountRecoveryLayout({ attachment }: { attachment: 'ready' | 'waiting' }) {
  const input = geometry();
  const elements = {
    anchor: measuredElement({ bounds: input.anchor, height: 100 }),
    anchorViewport: measuredElement({ bounds: input.anchorViewport, height: 100 }),
    anchorClip: measuredElement({ bounds: input.anchorClip, height: 300 }),
    root: measuredElement({ bounds: input.root, height: 960 }),
    viewport: measuredElement({ bounds: input.viewport, height: 900 }),
    toolbar: measuredElement({ bounds: rect({ left: 120, top: 700, width: 700, height: 40 }), height: 40 }),
  };
  const refs = {
    anchor: shallowRef<HTMLElement>(),
    anchorViewport: shallowRef<HTMLElement>(),
    anchorClip: shallowRef<HTMLElement>(),
    root: shallowRef<HTMLElement>(),
    viewport: shallowRef<HTMLElement>(),
    toolbar: shallowRef<HTMLElement>(),
  };
  const host = document.createElement('div');
  document.body.append(host);
  const scrollTarget = document.createElement('div');
  host.append(scrollTarget, ...Object.values(elements).map(value => value.element));
  function attach(): void {
    for (const key of Object.keys(refs) as (keyof typeof refs)[]) {
      refs[key].value = elements[key].element;
    }
  }
  if (attachment === 'ready') {
    attach();
  }

  const observers: { observed: Set<Element>, notify(): void, disconnect: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal('ResizeObserver', vi.fn(function (notify: ResizeObserverCallback) {
    const observed = new Set<Element>();
    const observer = {
      observe: vi.fn((element: Element) => {
        observed.add(element);
      }),
      unobserve: vi.fn((element: Element) => {
        observed.delete(element);
      }),
      disconnect: vi.fn(() => {
        observed.clear();
      }),
    };
    observers.push({ observed, notify: () => notify([], observer), disconnect: observer.disconnect });
    return observer;
  }));
  const frames = new Map<number, FrameRequestCallback>();
  let frameSequence = 0;
  const requestFrame = vi.fn((callback: FrameRequestCallback) => {
    const id = ++frameSequence;
    frames.set(id, callback);
    return id;
  });
  const cancelFrame = vi.fn((id: number) => {
    frames.delete(id);
  });
  vi.stubGlobal('requestAnimationFrame', requestFrame);
  vi.stubGlobal('cancelAnimationFrame', cancelFrame);
  const visual = Object.assign(new EventTarget(), { offsetLeft: 0, offsetTop: 0, width: 1200, height: 1000 });
  vi.stubGlobal('visualViewport', visual);
  const fonts = new EventTarget();
  const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  const listeners = {
    windowAdd: vi.spyOn(window, 'addEventListener'),
    windowRemove: vi.spyOn(window, 'removeEventListener'),
    documentAdd: vi.spyOn(document, 'addEventListener'),
    documentRemove: vi.spyOn(document, 'removeEventListener'),
    visualAdd: vi.spyOn(visual, 'addEventListener'),
    visualRemove: vi.spyOn(visual, 'removeEventListener'),
    fontsAdd: vi.spyOn(fonts, 'addEventListener'),
    fontsRemove: vi.spyOn(fonts, 'removeEventListener'),
  };
  let layout: ReturnType<typeof useChatModelRecoveryLayout> | undefined;
  const wrapper = mount(defineComponent({
    setup() {
      layout = useChatModelRecoveryLayout(refs);
      return () => h('div');
    },
  }), { attachTo: host });
  let mounted = true;
  function unmount(): void {
    if (mounted) {
      mounted = false;
      wrapper.unmount();
    }
  }
  return {
    layout: layout!,
    refs,
    elements,
    attach,
    visual,
    fonts,
    listeners,
    scrollTarget,
    observer: observers[0]!,
    frames,
    requestFrame,
    cancelFrame,
    unmount,
    flushFrame() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) {
        callback(16);
      }
    },
    [Symbol.dispose]() {
      unmount();
      host.remove();
      if (originalFonts === undefined) {
        Reflect.deleteProperty(document, 'fonts');
      } else {
        Object.defineProperty(document, 'fonts', originalFonts);
      }
    },
  };
}

describe('recovery layout DOM lifecycle', () => {
  it('waits for refs, reconnects observers when an anchor changes, and clears lost placements', async () => {
    using view = mountRecoveryLayout({ attachment: 'waiting' });
    expect(view.layout.layout.value).toBeUndefined();
    expect(view.observer.observed.size).toBe(0);
    view.attach();
    await nextTick();
    expect(view.layout.layout.value).toEqual({ left: 20, bottom: 200, width: 700, compactHeight: 100, expandedHeight: 688 });
    expect(view.observer.observed).toEqual(new Set(Object.values(view.elements).map(value => value.element)));

    const replacement = measuredElement({ bounds: rect({ left: 140, top: 720, width: 600, height: 60 }), height: 60 });
    view.elements.anchor.element.after(replacement.element);
    const disconnections = view.observer.disconnect.mock.calls.length;
    view.refs.anchor.value = replacement.element;
    await nextTick();
    expect(view.observer.disconnect).toHaveBeenCalledTimes(disconnections + 1);
    expect(view.observer.observed.has(view.elements.anchor.element)).toBe(false);
    expect(view.observer.observed.has(replacement.element)).toBe(true);
    expect(view.layout.layout.value).toEqual({ left: 40, bottom: 220, width: 600, compactHeight: 60, expandedHeight: 668 });

    view.refs.anchorClip.value = undefined;
    await nextTick();
    expect(view.layout.layout.value).toBeUndefined();
    expect(view.observer.observed.has(view.elements.anchorClip.element)).toBe(false);
    view.refs.anchorClip.value = view.elements.anchorClip.element;
    await nextTick();
    expect(view.layout.layout.value).toMatchObject({ compactHeight: 60, expandedHeight: 668 });
  });

  it('remeasures a resized viewport and late toolbar content without polling or a new ref', () => {
    using view = mountRecoveryLayout({ attachment: 'ready' });
    expect(view.layout.scrollMode.value).toBe('source');
    const initial = view.layout.layout.value;
    view.elements.viewport.change({ bounds: rect({ left: 100, top: 650, width: 800, height: 350 }), height: 350 });
    view.elements.toolbar.change({ bounds: rect({ left: 120, top: 700, width: 700, height: 48 }), height: 48 });
    view.observer.notify();
    expect(view.layout.layout.value).toBe(initial);
    view.flushFrame();
    expect(view.layout.layout.value).toMatchObject({ compactHeight: 100, expandedHeight: 138 });
    expect(view.layout.scrollMode.value).toBe('frame');

    view.elements.toolbar.change({ bounds: rect({ left: 120, top: 700, width: 700, height: 20 }), height: 20 });
    view.observer.notify();
    view.flushFrame();
    expect(view.layout.scrollMode.value).toBe('source');
  });

  it('coalesces resize, captured nested scroll, visual viewport and font notifications into one measurement', () => {
    using view = mountRecoveryLayout({ attachment: 'ready' });
    const initial = view.layout.layout.value;
    const reads = view.elements.anchor.read.mock.calls.length;
    view.elements.anchor.change({ bounds: rect({ left: 130, top: 710, width: 680, height: 80 }), height: 80 });
    view.observer.notify();
    window.dispatchEvent(new Event('resize'));
    view.scrollTarget.dispatchEvent(new Event('scroll'));
    view.visual.dispatchEvent(new Event('resize'));
    view.visual.dispatchEvent(new Event('scroll'));
    view.fonts.dispatchEvent(new Event('loadingdone'));
    expect(view.requestFrame).toHaveBeenCalledOnce();
    expect(view.frames.size).toBe(1);
    expect(view.layout.layout.value).toBe(initial);
    expect(view.elements.anchor.read).toHaveBeenCalledTimes(reads);
    view.flushFrame();
    expect(view.elements.anchor.read).toHaveBeenCalledTimes(reads + 1);
    expect(view.layout.layout.value).toEqual({ left: 30, bottom: 210, width: 680, compactHeight: 80, expandedHeight: 678 });
    view.scrollTarget.dispatchEvent(new Event('scroll'));
    expect(view.requestFrame).toHaveBeenCalledTimes(2);
    view.flushFrame();
    expect(view.elements.anchor.read).toHaveBeenCalledTimes(reads + 2);
  });

  it('uses visual viewport offsets and size on resize and pan while layout rectangles stay unchanged', () => {
    using view = mountRecoveryLayout({ attachment: 'ready' });
    Object.assign(view.visual, { offsetLeft: 150, offsetTop: 150, width: 500, height: 600 });
    view.visual.dispatchEvent(new Event('resize'));
    view.flushFrame();
    expect(view.layout.layout.value).toEqual({ left: 50, bottom: 250, width: 500, compactHeight: 50, expandedHeight: 600 });
    Object.assign(view.visual, { offsetLeft: 200, offsetTop: 180, width: 400, height: 540 });
    view.visual.dispatchEvent(new Event('scroll'));
    view.flushFrame();
    expect(view.layout.layout.value).toEqual({ left: 100, bottom: 280, width: 400, compactHeight: 20, expandedHeight: 540 });
    view.visual.height = 400;
    view.visual.dispatchEvent(new Event('resize'));
    view.flushFrame();
    expect(view.layout.layout.value).toBeUndefined();
  });

  it('disconnects every resource and ignores queued or delayed notifications after unmount', async () => {
    using view = mountRecoveryLayout({ attachment: 'ready' });
    const value = view.layout.layout.value;
    const reads = view.elements.anchor.read.mock.calls.length;
    expect(view.listeners.visualAdd).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(view.listeners.visualAdd).toHaveBeenCalledWith('scroll', expect.any(Function));
    expect(view.listeners.fontsAdd).toHaveBeenCalledWith('loadingdone', expect.any(Function));
    const windowResize = view.listeners.windowAdd.mock.calls.find(([type]) => type === 'resize')![1];
    const capturedScroll = view.listeners.documentAdd.mock.calls.find(([type, , options]) => type === 'scroll' && typeof options === 'object' && options.capture)![1];
    view.observer.notify();
    const [pendingId, delayedFrame] = [...view.frames.entries()][0]!;
    view.unmount();
    expect(view.observer.disconnect).toHaveBeenCalled();
    expect(view.observer.observed.size).toBe(0);
    expect(view.cancelFrame).toHaveBeenCalledWith(pendingId);
    expect(view.frames.size).toBe(0);
    expect(view.listeners.windowRemove).toHaveBeenCalledWith('resize', windowResize);
    expect(view.listeners.documentRemove).toHaveBeenCalledWith('scroll', capturedScroll, true);
    for (const [type, listener] of view.listeners.visualAdd.mock.calls) {
      expect(view.listeners.visualRemove).toHaveBeenCalledWith(type, listener);
    }
    for (const [type, listener] of view.listeners.fontsAdd.mock.calls) {
      expect(view.listeners.fontsRemove).toHaveBeenCalledWith(type, listener);
    }

    view.elements.anchor.change({ bounds: rect({ left: 300, top: 200, width: 100, height: 50 }), height: 50 });
    view.refs.anchor.value = undefined;
    await nextTick();
    delayedFrame(32);
    view.observer.notify();
    window.dispatchEvent(new Event('resize'));
    view.scrollTarget.dispatchEvent(new Event('scroll'));
    view.visual.dispatchEvent(new Event('resize'));
    view.visual.dispatchEvent(new Event('scroll'));
    view.fonts.dispatchEvent(new Event('loadingdone'));
    expect(view.requestFrame).toHaveBeenCalledOnce();
    expect(view.elements.anchor.read).toHaveBeenCalledTimes(reads);
    expect(view.layout.layout.value).toBe(value);
  });
});
