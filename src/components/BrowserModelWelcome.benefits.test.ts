import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '@/strings';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import BrowserModelWelcome from './BrowserModelWelcome.vue';

enableAutoUnmount(afterEach);
const bounds = { available: 600, required: 500 };
const observers: { notify(): void, observe: ReturnType<typeof vi.fn>, disconnect: ReturnType<typeof vi.fn> }[] = [];

beforeEach(() => {
  bounds.available = 600;
  bounds.required = 500;
  observers.length = 0;
  vi.stubGlobal('ResizeObserver', vi.fn(function (notify: () => void) {
    const observer = { notify, observe: vi.fn(), disconnect: vi.fn() };
    observers.push(observer);
    return observer;
  }));
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    switch (this.getAttribute('data-testid')) {
    case 'onboarding-benefits': return new DOMRect(0, 0, bounds.available, 28);
    case 'onboarding-benefit-measurement': return new DOMRect(0, 0, bounds.required, 20);
    default: return new DOMRect();
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderWelcome() {
  return mount(BrowserModelWelcome, {
    props: { interaction: 'ready', selection: { suggestionId: 'gemma-4-e2b', quantizationId: 'qat-q4_0' }, startStatus: 'idle', startError: undefined },
    global: { stubs: { LanguageSelector: true } },
  });
}

describe('model welcome benefits fitting', () => {
  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
  });

  it.each([
    { available: 600, required: 500, layout: 'inline' },
    { available: 500, required: 500, layout: 'inline' },
    { available: 499.5, required: 500, layout: 'rotating' },
  ])('uses $layout when $required pixels are needed within $available pixels', async ({ available, required, layout }) => {
    bounds.available = available;
    bounds.required = required;
    const wrapper = renderWelcome();
    await nextTick();
    expect(wrapper.get('[data-testid="onboarding-benefits"]').attributes('data-benefit-layout')).toBe(layout);
  });

  it('observes the available width and translated content, and responds in both directions', async () => {
    using fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external request'));
    const wrapper = renderWelcome();
    await nextTick();
    const row = wrapper.get('[data-testid="onboarding-benefits"]');
    const measurement = wrapper.get('[data-testid="onboarding-benefit-measurement"]');
    const observer = observers[0]!;
    expect(observers).toHaveLength(1);
    expect(observer.observe.mock.calls.map(call => call[0])).toEqual([row.element, measurement.element]);
    expect(row.attributes('data-benefit-layout')).toBe('inline');
    bounds.available = 400;
    observer.notify();
    await nextTick();
    expect(row.attributes('data-benefit-layout')).toBe('rotating');
    bounds.available = 800;
    observer.notify();
    await nextTick();
    expect(row.attributes('data-benefit-layout')).toBe('inline');
    bounds.required = 820;
    observer.notify();
    await nextTick();
    expect(row.attributes('data-benefit-layout')).toBe('rotating');
    bounds.required = 700;
    observer.notify();
    await nextTick();
    expect(row.attributes('data-benefit-layout')).toBe('inline');
    expect(wrapper.emitted('select')).toBeUndefined();
    expect(wrapper.emitted('start')).toBeUndefined();
    expect(wrapper.emitted('open-connections')).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('waits for meaningful dimensions before treating all claims as fitting', async () => {
    bounds.available = 0;
    bounds.required = 0;
    const wrapper = renderWelcome();
    await nextTick();
    const row = wrapper.get('[data-testid="onboarding-benefits"]');
    expect(row.attributes('data-benefit-layout')).toBe('rotating');
    bounds.available = 600;
    observers[0]!.notify();
    await nextTick();
    expect(row.attributes('data-benefit-layout')).toBe('rotating');
    bounds.required = 500;
    observers[0]!.notify();
    await nextTick();
    expect(row.attributes('data-benefit-layout')).toBe('inline');
  });

  it('keeps the measuring copy outside accessible reading and avoids live announcements', () => {
    const wrapper = renderWelcome();
    const row = wrapper.get('[data-testid="onboarding-benefits"]');
    expect(row.attributes('role')).toBe('list');
    expect(row.attributes('aria-live')).toBeUndefined();
    expect(row.findAll('[role="listitem"]')).toHaveLength(3);
    const measurement = row.get('[data-testid="onboarding-benefit-measurement"]');
    expect(measurement.attributes('aria-hidden')).toBe('true');
    expect(measurement.find('[role="listitem"]').exists()).toBe(false);
  });

  it('does not remeasure on model selection or a short pointer gesture', async () => {
    const wrapper = renderWelcome();
    await flushPromises();
    using rects = vi.spyOn(Element.prototype, 'getBoundingClientRect');
    rects.mockClear();
    await wrapper.setProps({ selection: { suggestionId: 'gpt-oss-20b', quantizationId: 'mxfp4' } });
    const deck = wrapper.get('[data-testid="model-swipe"]').element;
    for (const type of ['pointerdown', 'pointerup']) {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: 100, clientY: 100 });
      Object.defineProperties(event, { isPrimary: { value: true }, pointerId: { value: 1 } });
      deck.dispatchEvent(event);
    }
    await nextTick();
    expect(rects).not.toHaveBeenCalled();
  });

  it('disconnects on unmount and tolerates an already queued observer callback', () => {
    const wrapper = renderWelcome();
    const observer = observers[0]!;
    wrapper.unmount();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    using rects = vi.spyOn(Element.prototype, 'getBoundingClientRect');
    rects.mockClear();
    expect(() => observer.notify()).not.toThrow();
    expect(rects).not.toHaveBeenCalled();
  });

  it('uses and removes the resize fallback without ResizeObserver', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    using added = vi.spyOn(window, 'addEventListener');
    using removed = vi.spyOn(window, 'removeEventListener');
    const wrapper = renderWelcome();
    await nextTick();
    const row = wrapper.get('[data-testid="onboarding-benefits"]');
    expect(row.attributes('data-benefit-layout')).toBe('inline');
    bounds.available = 400;
    window.dispatchEvent(new Event('resize'));
    await nextTick();
    expect(row.attributes('data-benefit-layout')).toBe('rotating');
    const listener = added.mock.calls.find(call => call[0] === 'resize')?.[1];
    expect(listener).toBeTypeOf('function');
    wrapper.unmount();
    expect(removed).toHaveBeenCalledWith('resize', listener);
    using rects = vi.spyOn(Element.prototype, 'getBoundingClientRect');
    rects.mockClear();
    window.dispatchEvent(new Event('resize'));
    expect(rects).not.toHaveBeenCalled();
  });
});

describe('model welcome benefits language changes', () => {
  it('remeasures after real locale updates even without a resize notification', async () => {
    await setLocale({ locale: 'en' });
    const wrapper = renderWelcome();
    await flushPromises();
    const row = wrapper.get('[data-testid="onboarding-benefits"]');
    expect(row.attributes('data-benefit-layout')).toBe('inline');
    expect(row.findAll('[role="listitem"]')[0]!.text()).toContain('Prompts');
    bounds.required = 700;
    await setLocale({ locale: 'ja' });
    await flushPromises();
    expect(row.findAll('[role="listitem"]')[0]!.text()).toContain('プロンプト');
    expect(row.attributes('data-benefit-layout')).toBe('rotating');
    expect(observers[0]!.observe).toHaveBeenCalledTimes(2);
  });
});
