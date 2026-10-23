import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { modelSuggestions } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import { browserModelShowcaseIds } from './browser-model-presentation';
import BrowserModelWelcome from './BrowserModelWelcome.vue';
import BrowserModelDialog from './BrowserModelDialog.vue';
import WelcomeScreenFrame from './layout/WelcomeScreenFrame.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function touchPointer({ type, x, y, pointerId, isPrimary }: { type: string, x: number, y: number, pointerId: number, isPrimary: boolean }): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: 'touch' },
    isPrimary: { value: isPrimary },
  });
  return event;
}

function renderTouchWelcome() {
  const wrapper = mount(BrowserModelWelcome, { props: { interaction: 'ready', selection: { suggestionId: 'gemma-4-e2b', quantizationId: 'qat-q4_0' }, startStatus: 'idle', startError: undefined } });
  const deck = wrapper.get<HTMLElement>('[data-testid="model-swipe"]').element;
  const card = wrapper.get<HTMLButtonElement>('[data-testid="start-model"]').element;
  const capture = vi.fn();
  Object.defineProperty(deck, 'setPointerCapture', { value: capture });
  return { wrapper, deck, card, capture };
}

describe('browser model welcome', () => {
  it('resolves every showcased model against the shared catalog', () => {
    expect(browserModelShowcaseIds.filter(id => !modelSuggestions.some(model => model.id === id))).toEqual([]);
  });

  it('keeps preview browsing local and emits the shared catalog identity', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const wrapper = mount(BrowserModelWelcome, { props: { interaction: 'ready', selection: { suggestionId: 'gemma-4-e2b', quantizationId: 'qat-q4_0' }, startStatus: 'idle', startError: undefined } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
        fetch.mockRestore();
      },
    };
    expect(wrapper.get('[data-testid="browser-model-heading"]').text()).toBe('Run AI directly in your web browser');
    const welcome = wrapper.getComponent(WelcomeScreenFrame);
    expect(welcome.props('placement')).toBe('contained');
    expect(wrapper.find('[data-testid="suggestions-container"]').exists()).toBe(false);
    expect(welcome.classes()).toEqual(expect.arrayContaining(['justify-center', 'p-6', 'sm:p-12']));
    await wrapper.get('[data-testid="next-model"]').trigger('click');
    const selected = wrapper.emitted('select')?.[0]?.[0];
    expect(selected).toEqual({ suggestionId: 'gpt-oss-20b', quantizationId: 'mxfp4' });
    expect(modelSuggestions.some(model => model.id === 'gpt-oss-20b')).toBe(true);
    expect(wrapper.emitted('start')).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="start-model"]').trigger('click');
    expect(wrapper.emitted('start')).toHaveLength(1);
  });

  it('disables initial entry actions until startup is ready', async () => {
    const wrapper = mount(BrowserModelWelcome, { props: { interaction: 'blocked', selection: { suggestionId: 'gemma-4-e2b', quantizationId: 'qat-q4_0' }, startStatus: 'idle', startError: undefined } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expect(wrapper.get('[data-testid="start-model"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="open-model-list"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="gguf-compatibility-info-trigger"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="browser-model-welcome"]').attributes('inert')).toBeDefined();
    await wrapper.get('[data-testid="next-model"]').trigger('click');
    expect(wrapper.emitted('select')).toBeUndefined();
    await wrapper.setProps({ interaction: 'ready' });
    expect(wrapper.get('[data-testid="browser-model-welcome"]').attributes('inert')).toBeUndefined();
    expect(wrapper.get('[data-testid="start-model"]').attributes('disabled')).toBeUndefined();
  });

  it('shows GGUF compatibility beside file selection on hover, focus, and pinned clicks without fetching', async () => {
    using fetch = vi.spyOn(globalThis, 'fetch');
    const wrapper = mount(BrowserModelWelcome, { props: { interaction: 'ready', selection: { suggestionId: 'gemma-4-e2b', quantizationId: 'qat-q4_0' }, startStatus: 'idle', startError: undefined }, attachTo: document.body });
    using _cleanup = { [Symbol.dispose]: () => wrapper.unmount() };
    const help = wrapper.get('[data-testid="gguf-compatibility-info"]');
    const trigger = wrapper.get<HTMLButtonElement>('[data-testid="gguf-compatibility-info-trigger"]');
    const explanation = 'Runs llama.cpp in your browser to support a wide range of GGUF models.';
    expect(wrapper.get('[data-testid="onboarding-local-files"]').element.contains(trigger.element)).toBe(true);
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain(explanation);
    await help.trigger('mouseenter');
    const tooltip = wrapper.get('[role="tooltip"]');
    expect(tooltip.text()).toBe(explanation);
    expect(trigger.attributes('aria-expanded')).toBe('true');
    expect(trigger.attributes('aria-describedby')).toBe(tooltip.attributes('id'));
    // The explanation remains a descendant, including the pointer bridge above
    // the file row, so entering its text does not leave the help boundary.
    expect(help.element.contains(tooltip.element)).toBe(true);
    await help.trigger('mouseleave');
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);

    trigger.element.focus();
    await nextTick();
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(true);
    await trigger.trigger('click');
    await help.trigger('mouseleave');
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(true);
    await wrapper.get('[data-testid="next-model"]').trigger('pointerdown');
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
    expect(trigger.attributes('aria-expanded')).toBe('false');
    await trigger.trigger('click');
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(true);
    await trigger.trigger('click');
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
    trigger.element.blur();
    trigger.element.focus();
    await nextTick();
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(true);
    await wrapper.setProps({ startStatus: 'starting' });
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(wrapper.emitted('start')).toBeUndefined();
    expect(wrapper.emitted('select')).toBeUndefined();
  });

  it('dismisses compatibility help before its containing model dialog on Escape', async () => {
    const wrapper = mount(BrowserModelDialog, {
      props: { open: true, dismissible: true, suspended: false },
      slots: { default: () => h(BrowserModelWelcome, { interaction: 'ready', selection: { suggestionId: 'gemma-4-e2b', quantizationId: 'qat-q4_0' }, startStatus: 'idle', startError: undefined }) },
      global: { stubs: { teleport: true } },
      attachTo: document.body,
    });
    using _cleanup = { [Symbol.dispose]: () => wrapper.unmount() };
    await nextTick();
    const trigger = wrapper.get('[data-testid="gguf-compatibility-info-trigger"]');
    await trigger.trigger('click');
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(true);
    await trigger.trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
    expect(wrapper.emitted('close')).toBeUndefined();
    await trigger.trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('keeps a touch swipe alive through the child capture handoff and suppresses its click', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const { wrapper, deck, card, capture } = renderTouchWelcome();
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
        now.mockRestore();
      },
    };
    const pointer = { pointerId: 1, isPrimary: true, x: 100, y: 20 };
    card.dispatchEvent(touchPointer({ ...pointer, type: 'pointerdown' }));
    card.dispatchEvent(touchPointer({ ...pointer, type: 'pointermove', x: 80 }));
    expect(capture).toHaveBeenCalledExactlyOnceWith(1);
    // The touch's original button loses its implicit capture when the deck
    // takes over. This event bubbles, but does not end the deck's gesture.
    card.dispatchEvent(touchPointer({ ...pointer, type: 'lostpointercapture', x: 80 }));
    deck.dispatchEvent(touchPointer({ ...pointer, type: 'pointermove', x: 40 }));
    deck.dispatchEvent(touchPointer({ ...pointer, type: 'pointerup', x: 40 }));
    expect(capture).toHaveBeenCalledOnce();
    expect(wrapper.emitted('select')).toHaveLength(1);
    expect(wrapper.emitted('select')?.[0]).toEqual([{ suggestionId: 'gpt-oss-20b', quantizationId: 'mxfp4' }]);
    await wrapper.setProps({ selection: { suggestionId: 'gpt-oss-20b', quantizationId: 'mxfp4' } });
    card.click();
    expect(wrapper.emitted('select')).toHaveLength(1);
    await wrapper.get('[data-testid="start-model"]').trigger('click');
    expect(wrapper.emitted('start')).toBeUndefined();
    now.mockReturnValue(1500);
    await wrapper.get('[data-testid="start-model"]').trigger('click');
    expect(wrapper.emitted('start')).toHaveLength(1);
  });

  it('selects the previous model on a rightward touch swipe', () => {
    const { wrapper, deck, card, capture } = renderTouchWelcome();
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const pointer = { pointerId: 1, isPrimary: true, x: 100, y: 20 };
    card.dispatchEvent(touchPointer({ ...pointer, type: 'pointerdown' }));
    card.dispatchEvent(touchPointer({ ...pointer, type: 'pointermove', x: 160 }));
    deck.dispatchEvent(touchPointer({ ...pointer, type: 'pointerup', x: 160 }));
    expect(capture).toHaveBeenCalledExactlyOnceWith(1);
    expect(wrapper.emitted('select')?.[0]).toEqual([{ suggestionId: 'qwen-3-8-flash-next', quantizationId: 'q4_k_m' }]);
    expect(wrapper.emitted('start')).toBeUndefined();
  });

  it('snaps a short drag back and permits a deliberate tap immediately afterwards', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const { wrapper, deck, card, capture } = renderTouchWelcome();
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
        now.mockRestore();
      },
    };
    const pointer = { pointerId: 1, isPrimary: true, x: 100, y: 20 };
    card.dispatchEvent(touchPointer({ ...pointer, type: 'pointerdown' }));
    card.dispatchEvent(touchPointer({ ...pointer, type: 'pointermove', x: 80 }));
    deck.dispatchEvent(touchPointer({ ...pointer, type: 'pointerup', x: 80 }));
    card.click();
    expect(wrapper.emitted('start')).toBeUndefined();
    expect(wrapper.emitted('select')).toBeUndefined();
    capture.mockClear();
    card.dispatchEvent(touchPointer({ ...pointer, type: 'pointerdown' }));
    card.dispatchEvent(touchPointer({ ...pointer, type: 'pointermove', x: 103, y: 22 }));
    card.dispatchEvent(touchPointer({ ...pointer, type: 'pointerup', x: 103, y: 22 }));
    card.click();
    expect(capture).not.toHaveBeenCalled();
    expect(wrapper.emitted('start')).toHaveLength(1);
  });

  it('leaves vertical movement to page scrolling without later changing models', () => {
    const { wrapper, deck, card, capture } = renderTouchWelcome();
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const pointer = { pointerId: 1, isPrimary: true, x: 100, y: 20 };
    card.dispatchEvent(touchPointer({ ...pointer, type: 'pointerdown' }));
    const verticalMove = touchPointer({ ...pointer, type: 'pointermove', x: 104, y: 60 });
    card.dispatchEvent(verticalMove);
    deck.dispatchEvent(touchPointer({ ...pointer, type: 'pointermove', x: 40, y: 60 }));
    deck.dispatchEvent(touchPointer({ ...pointer, type: 'pointerup', x: 40, y: 60 }));
    expect(verticalMove.defaultPrevented).toBe(false);
    expect(capture).not.toHaveBeenCalled();
    expect(wrapper.emitted('select')).toBeUndefined();
    expect(wrapper.emitted('start')).toBeUndefined();
  });

  it('ignores secondary touches and their cancellation while tracking the primary finger', () => {
    const { wrapper, deck, card } = renderTouchWelcome();
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const pointer = { pointerId: 1, isPrimary: true, x: 100, y: 20 };
    const secondary = { pointerId: 2, isPrimary: false, x: 160, y: 20 };
    card.dispatchEvent(touchPointer({ ...pointer, type: 'pointerdown' }));
    card.dispatchEvent(touchPointer({ ...pointer, type: 'pointermove', x: 80 }));
    card.dispatchEvent(touchPointer({ ...secondary, type: 'pointerdown' }));
    deck.dispatchEvent(touchPointer({ ...secondary, type: 'pointermove', x: 230 }));
    deck.dispatchEvent(touchPointer({ ...secondary, type: 'pointercancel' }));
    deck.dispatchEvent(touchPointer({ ...secondary, type: 'lostpointercapture' }));
    deck.dispatchEvent(touchPointer({ ...secondary, type: 'pointerup' }));
    deck.dispatchEvent(touchPointer({ ...pointer, type: 'pointerup', x: 40 }));
    expect(wrapper.emitted('select')?.[0]).toEqual([{ suggestionId: 'gpt-oss-20b', quantizationId: 'mxfp4' }]);
    expect(wrapper.emitted('start')).toBeUndefined();
  });

  it('accepts a fresh primary press after an unfinished tap candidate', () => {
    const { wrapper, deck, card } = renderTouchWelcome();
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const pointer = { pointerId: 1, isPrimary: true, x: 100, y: 20 };
    card.dispatchEvent(touchPointer({ ...pointer, type: 'pointerdown' }));
    card.dispatchEvent(touchPointer({ ...pointer, type: 'pointerdown', pointerId: 3 }));
    card.dispatchEvent(touchPointer({ ...pointer, type: 'pointermove', pointerId: 3, x: 40 }));
    deck.dispatchEvent(touchPointer({ ...pointer, type: 'pointerup', pointerId: 3, x: 40 }));
    expect(wrapper.emitted('select')).toHaveLength(1);
    expect(wrapper.emitted('start')).toBeUndefined();
  });

  it.each(['pointercancel', 'lostpointercapture'])('resets a cancelled swipe on %s and accepts the next gesture', type => {
    const { wrapper, deck, card } = renderTouchWelcome();
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const pointer = { pointerId: 1, isPrimary: true, x: 100, y: 20 };
    card.dispatchEvent(touchPointer({ ...pointer, type: 'pointerdown' }));
    card.dispatchEvent(touchPointer({ ...pointer, type: 'pointermove', x: 40 }));
    deck.dispatchEvent(touchPointer({ ...pointer, type, x: 40 }));
    deck.dispatchEvent(touchPointer({ ...pointer, type: 'pointerup', x: 40 }));
    expect(wrapper.emitted('select')).toBeUndefined();
    card.dispatchEvent(touchPointer({ ...pointer, type: 'pointerdown', pointerId: 3 }));
    card.dispatchEvent(touchPointer({ ...pointer, type: 'pointermove', pointerId: 3, x: 160 }));
    deck.dispatchEvent(touchPointer({ ...pointer, type: 'pointerup', pointerId: 3, x: 160 }));
    expect(wrapper.emitted('select')).toHaveLength(1);
    expect(wrapper.emitted('start')).toBeUndefined();
  });
});
