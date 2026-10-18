import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { flushPromises, mount } from '@vue/test-utils';
import ReasoningSettings from './ReasoningSettings.vue';
import SettingsSourceBadge from './SettingsSourceBadge.vue';
import { nextTick } from 'vue';
import type { Reasoning } from '@/01-models/types';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('ReasoningSettings Component', () => {
  const getWrapper = async (selectedEffort: Reasoning['effort'] = undefined) => {
    const wrapper = mount(ReasoningSettings, {
      props: { selectedEffort },
    });
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="reasoning-effort-default"]').exists()).toBe(true);
    });
    return wrapper;
  };

  it('renders all effort options with segmented control style', async () => {
    const wrapper = await getWrapper();
    // Labels are: Default, Off, Low, Medium, High -> toLowerCase()
    const options = ['default', 'off', 'low', 'medium', 'high'];

    options.forEach(opt => {
      expect(wrapper.find(`[data-testid="reasoning-effort-${opt}"]`).exists()).toBe(true);
    });
  });

  it('emits update:effort when a button is clicked', async () => {
    const wrapper = await getWrapper();

    await wrapper.find('[data-testid="reasoning-effort-high"]').trigger('click');
    expect(wrapper.emitted('update:effort')).toEqual([['high']]);

    await wrapper.find('[data-testid="reasoning-effort-off"]').trigger('click');
    expect(wrapper.emitted('update:effort')).toContainEqual(['none']);
  });

  it('keeps plain inherited selection, pending controls, and button identity stable', async () => {
    using testCase = {
      wrapper: mount(ReasoningSettings, {
        props: { selectedEffort: undefined, defaultLabel: 'A long provider reasoning description', defaultSource: { label: 'Inherit', description: undefined }, surface: 'plain', notice: 'inline-help' },
        slots: { 'heading-extra': '<span data-testid="reasoning-source">Global</span>' },
      }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    const { wrapper } = testCase;
    await nextTick();
    const inherited = wrapper.get<HTMLButtonElement>('[data-testid="reasoning-effort-default"]');
    const high = wrapper.get<HTMLButtonElement>('[data-testid="reasoning-effort-high"]');
    const highButton = high.element;
    expect(inherited.attributes('title')).toBe('A long provider reasoning description · Inherit');
    expect(inherited.getComponent(SettingsSourceBadge).props('source')).toEqual({ label: 'Inherit', description: undefined });
    expect(inherited.attributes('aria-pressed')).toBe('true');
    expect(high.attributes('aria-pressed')).toBe('false');
    const slider = wrapper.get<HTMLElement>('[data-testid="reasoning-effort-slider"]');
    expect(slider.element.style.opacity).toBe('1');
    expect(wrapper.find('[data-testid="reasoning-help-button"]').exists()).toBe(true);
    const source = wrapper.get('[data-testid="reasoning-source"]').element;
    expect(source.parentElement?.contains(wrapper.get('[data-testid="reasoning-help-button"]').element)).toBe(true);
    expect(source.compareDocumentPosition(wrapper.get('[data-testid="reasoning-effort-options"]').element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await high.trigger('click');
    expect(wrapper.emitted('update:effort')).toEqual([['high']]);
    expect(inherited.attributes('aria-pressed')).toBe('true');
    await wrapper.setProps({ selectedEffort: 'high', disabled: true });
    expect(high.element).toBe(highButton);
    expect(high.attributes('aria-pressed')).toBe('true');
    expect(high.element.disabled).toBe(true);
    expect(slider.element.style.opacity).toBe('1');
    await inherited.trigger('click');
    expect(wrapper.emitted('update:effort')).toEqual([['high']]);
    await wrapper.setProps({ disabled: false });
    expect(high.element).toBe(highButton);
    await inherited.trigger('click');
    expect(wrapper.emitted('update:effort')).toEqual([['high'], [undefined]]);
  });

  it('keeps the default notice paragraph and offers opt-in keyboard and touch help', async () => {
    using testCase = {
      wrapper: mount(ReasoningSettings, { props: { selectedEffort: undefined }, attachTo: document.body }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    const { wrapper } = testCase;
    expect(wrapper.text()).toContain('Effort levels may be ignored by some models');
    expect(wrapper.find('[data-testid="reasoning-help-button"]').exists()).toBe(false);
    await wrapper.setProps({ notice: 'inline-help', surface: 'plain' });
    expect(wrapper.text()).not.toContain('Effort levels may be ignored by some models');
    const button = wrapper.get<HTMLButtonElement>('[data-testid="reasoning-help-button"]');
    button.element.focus();
    await nextTick();
    expect(document.body.querySelector('[data-testid="reasoning-help"]')?.textContent).toContain('Effort levels may be ignored by some models');
    await button.trigger('keydown', { key: 'Escape' });
    expect(!!document.body.querySelector('[data-testid="reasoning-help"]')).toBe(false);
    expect(document.activeElement).toBe(button.element);
    await button.trigger('click');
    expect(document.body.querySelector('[data-testid="reasoning-help"]')?.getAttribute('role')).toBe('tooltip');
    const tooltip = document.body.querySelector<HTMLElement>('[data-testid="reasoning-help"]')!;
    expect(wrapper.element.contains(tooltip)).toBe(false);
    expect(tooltip.style.position).toBe('fixed');
    expect(wrapper.emitted('update:effort')).toBeUndefined();
    await button.trigger('click');
    expect(!!document.body.querySelector('[data-testid="reasoning-help"]')).toBe(false);
  });

  it('highlights the correctly selected effort button', async () => {
    const wrapper = await getWrapper('medium');

    const medBtn = wrapper.find('[data-testid="reasoning-effort-medium"]');
    expect(medBtn.classes()).toContain('text-blue-600');
    expect(medBtn.classes()).toContain('font-bold');

    const highBtn = wrapper.find('[data-testid="reasoning-effort-high"]');
    expect(highBtn.classes()).not.toContain('text-blue-600');
  });

  it('applies flex-[1.4] to the Default button for better readability', async () => {
    const wrapper = await getWrapper();
    const defaultBtn = wrapper.find('[data-testid="reasoning-effort-default"]');
    expect(defaultBtn.classes()).toContain('flex-[1.4]');

    const lowBtn = wrapper.find('[data-testid="reasoning-effort-low"]');
    expect(lowBtn.classes()).toContain('flex-1');
    expect(lowBtn.classes()).not.toContain('flex-[1.4]');
  });

  it('renders and emits leading source options without emitting an effort', async () => {
    const wrapper = mount(ReasoningSettings, {
      props: {
        selectedEffort: undefined,
        selectedValue: 'inherit',
        leadingOptions: [
          {
            value: 'inherit',
            label: 'Global: Default',
            shortLabel: 'Global: Default',
            testId: 'inherit',
          },
        ],
      },
    });

    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="reasoning-effort-inherit"]').exists()).toBe(true);
    });

    const inheritButton = wrapper.find('[data-testid="reasoning-effort-inherit"]');
    expect(inheritButton.classes()).toContain('text-blue-600');

    await inheritButton.trigger('click');

    expect(wrapper.emitted('update:value')).toEqual([['inherit']]);
    expect(wrapper.emitted('update:effort')).toBeUndefined();
  });

  it('initializes slider position on mount', async () => {
    const wrapper = await getWrapper('high');
    await nextTick();

    const slider = wrapper.find('[data-testid="reasoning-effort-slider"]');
    expect(slider.exists()).toBe(true);
    expect(slider.attributes('style')).toContain('opacity: 1');
  });

  describe('slider layout measurements', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    function mockSliderResize() {
      const observers: { notify: () => void, observe: ReturnType<typeof vi.fn>, disconnect: ReturnType<typeof vi.fn> }[] = [];
      vi.stubGlobal('ResizeObserver', vi.fn(function (notify: () => void) {
        const observer = { notify, observe: vi.fn(), disconnect: vi.fn() };
        observers.push(observer);
        return observer;
      }));
      return observers;
    }

    function mockButtonLayout({ measurements }: { measurements: Record<string, { left: number, width: number }> }) {
      const leftReads = vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
        const effort = this.dataset.testid?.replace('reasoning-effort-', '') ?? '';
        return measurements[effort]?.left ?? 0;
      });
      const widthReads = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
        const effort = this.dataset.testid?.replace('reasoning-effort-', '') ?? '';
        return measurements[effort]?.width ?? 0;
      });
      return { leftReads, widthReads };
    }

    it.each(['flat', 'card', 'plain'] as const)('remeasures the selected %s button immediately on resize and still animates selection changes', async surface => {
      const observers = mockSliderResize();
      const measurements = {
        high: { left: 300, width: 72 },
        medium: { left: 110, width: 40 },
      };
      mockButtonLayout({ measurements });
      const wrapper = mount(ReasoningSettings, { props: { selectedEffort: 'high', surface } });
      using _cleanupResource = {
        [Symbol.dispose]() {
          wrapper.unmount();
        },
      };
      await nextTick();
      const slider = wrapper.get<HTMLElement>('[data-testid="reasoning-effort-slider"]');
      expect(observers).toHaveLength(1);
      expect(observers[0]!.observe).toHaveBeenCalledWith(wrapper.get('[data-testid="reasoning-effort-options"]').element);
      expect(observers[0]!.observe).toHaveBeenCalledWith(wrapper.get('[data-testid="reasoning-effort-high"]').element);
      expect(slider.element.style.left).toBe('300px');
      expect(slider.element.style.width).toBe('72px');
      expect(slider.element.style.transitionDuration).toBe('0ms');

      vi.advanceTimersByTime(50);
      measurements.high = { left: 150, width: 36 };
      observers[0]!.notify();
      await nextTick();

      expect(slider.element.style.left).toBe('150px');
      expect(slider.element.style.width).toBe('36px');
      expect(slider.element.style.transitionDuration).toBe('0ms');
      expect(wrapper.emitted('update:effort')).toBeUndefined();
      expect(wrapper.emitted('update:value')).toBeUndefined();

      await wrapper.setProps({ selectedEffort: 'medium' });
      // Flush the watcher, its nextTick measurement, and the resulting style update.
      await flushPromises();

      expect(slider.element.style.left).toBe('110px');
      expect(slider.element.style.width).toBe('40px');
      expect(slider.element.style.transitionDuration).toBe('300ms');
    });

    it('immediately aligns the slider when the plain inherited label or surface changes', async () => {
      const observers = mockSliderResize();
      const measurements = { default: { left: 0, width: 80 } };
      mockButtonLayout({ measurements });
      using testCase = {
        wrapper: mount(ReasoningSettings, { props: { selectedEffort: undefined, defaultLabel: 'Inherit (Low)', surface: 'plain' } }),
        [Symbol.dispose]() {
          this.wrapper.unmount();
        },
      };
      const { wrapper } = testCase;
      await nextTick();
      const slider = wrapper.get<HTMLElement>('[data-testid="reasoning-effort-slider"]');
      expect(observers).toHaveLength(1);
      expect(slider.element.style.width).toBe('80px');
      vi.advanceTimersByTime(50);
      measurements.default = { left: 0, width: 120 };
      await wrapper.setProps({ defaultLabel: 'Inherit (A much longer label)' });
      await flushPromises();
      expect(slider.element.style.width).toBe('120px');
      expect(slider.element.style.transitionDuration).toBe('0ms');
      await wrapper.setProps({ surface: 'card' });
      await flushPromises();
      expect(observers).toHaveLength(1);
      expect(slider.element.style.transitionDuration).toBe('0ms');
      await wrapper.setProps({ surface: 'plain' });
      await flushPromises();
      expect(slider.element.style.transitionDuration).toBe('0ms');
      expect(observers[0]!.disconnect).not.toHaveBeenCalled();
      expect(wrapper.emitted('update:effort')).toBeUndefined();
    });

    it.each([0, 180])('keeps plain selection within a measurable %spx track without scrolling the page', async clientWidth => {
      mockSliderResize();
      mockButtonLayout({ measurements: { high: { left: 300, width: 72 }, default: { left: 2, width: 80 } } });
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'reasoning-effort-options' ? clientWidth : 0;
      });
      const scrollPage = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
      using testCase = {
        wrapper: mount(ReasoningSettings, { props: { selectedEffort: 'high', surface: 'plain' } }),
        [Symbol.dispose]() {
          this.wrapper.unmount();
        },
      };
      const { wrapper } = testCase;
      const track = wrapper.get<HTMLElement>('[data-testid="reasoning-effort-options"]');
      await nextTick();
      expect(track.element.scrollLeft).toBe(clientWidth ? 192 : 0);
      await wrapper.setProps({ selectedEffort: undefined });
      await flushPromises();
      expect(track.element.scrollLeft).toBe(clientWidth ? 2 : 0);
      expect(scrollPage).not.toHaveBeenCalled();
      expect(wrapper.emitted('update:effort')).toBeUndefined();
    });

    it('recovers from zero-size hidden layout for a leading source option', async () => {
      const observers = mockSliderResize();
      const measurements = { same_scope: { left: 0, width: 0 } };
      mockButtonLayout({ measurements });
      const wrapper = mount(ReasoningSettings, {
        props: {
          selectedEffort: undefined,
          selectedValue: 'same_scope',
          leadingOptions: [{ value: 'same_scope', label: 'Current chat model', shortLabel: 'Current chat', testId: 'same_scope' }],
        },
      });
      using _cleanupResource = {
        [Symbol.dispose]() {
          wrapper.unmount();
        },
      };
      await nextTick();
      const slider = wrapper.get<HTMLElement>('[data-testid="reasoning-effort-slider"]');
      expect(slider.element.style.width).toBe('0px');

      vi.advanceTimersByTime(50);
      measurements.same_scope = { left: 2, width: 128 };
      observers[0]!.notify();
      await nextTick();

      expect(slider.element.style.left).toBe('2px');
      expect(slider.element.style.width).toBe('128px');
      expect(slider.element.style.opacity).toBe('1');
      expect(slider.element.style.transitionDuration).toBe('0ms');
    });

    it.each(['flat', 'card', 'plain'] as const)('disconnects %s observation, clears initialization, and ignores queued measurements after unmount', async surface => {
      const observers = mockSliderResize();
      const { leftReads, widthReads } = mockButtonLayout({ measurements: { high: { left: 300, width: 72 } } });
      const wrapper = mount(ReasoningSettings, { props: { selectedEffort: 'high', surface } });
      using _cleanupResource = {
        [Symbol.dispose]() {
          if (wrapper.exists()) {
            wrapper.unmount();
          }
        },
      };
      expect(vi.getTimerCount()).toBe(1);

      const selectionUpdate = wrapper.setProps({ selectedEffort: 'medium' });
      await nextTick(() => {
        wrapper.unmount();
        leftReads.mockClear();
        widthReads.mockClear();
      });
      await selectionUpdate;
      observers[0]!.notify();
      await nextTick();

      expect(observers[0]!.disconnect).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect(leftReads).not.toHaveBeenCalled();
      expect(widthReads).not.toHaveBeenCalled();
    });

    it.each(['flat', 'card', 'plain'] as const)('keeps %s mount and animated selection changes working without ResizeObserver', async surface => {
      vi.stubGlobal('ResizeObserver', undefined);
      mockButtonLayout({ measurements: { default: { left: 2, width: 100 }, high: { left: 300, width: 72 } } });
      const wrapper = mount(ReasoningSettings, { props: { selectedEffort: undefined, surface } });
      using _cleanupResource = {
        [Symbol.dispose]() {
          wrapper.unmount();
        },
      };
      await nextTick();
      const slider = wrapper.get<HTMLElement>('[data-testid="reasoning-effort-slider"]');
      expect(slider.element.style.left).toBe('2px');
      expect(slider.element.style.width).toBe('100px');

      vi.advanceTimersByTime(50);
      await wrapper.setProps({ selectedEffort: 'high' });
      await flushPromises();

      expect(slider.element.style.left).toBe('300px');
      expect(slider.element.style.width).toBe('72px');
      expect(slider.element.style.transitionDuration).toBe('300ms');
    });
  });
});
