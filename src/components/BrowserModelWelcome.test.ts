import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { modelSuggestions } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import { browserModelShowcaseIds } from './browser-model-presentation';
import BrowserModelWelcome from './BrowserModelWelcome.vue';
import WelcomeScreenFrame from './layout/WelcomeScreenFrame.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

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
    expect(wrapper.get('[data-testid="browser-model-heading"]').text()).toBe('Run AI in your web browser');
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
    expect(wrapper.get('[data-testid="browser-model-welcome"]').attributes('inert')).toBeDefined();
    await wrapper.get('[data-testid="next-model"]').trigger('click');
    expect(wrapper.emitted('select')).toBeUndefined();
    await wrapper.setProps({ interaction: 'ready' });
    expect(wrapper.get('[data-testid="browser-model-welcome"]').attributes('inert')).toBeUndefined();
    expect(wrapper.get('[data-testid="start-model"]').attributes('disabled')).toBeUndefined();
  });

  it('does not treat the click following a swipe as Start', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const wrapper = mount(BrowserModelWelcome, { props: { interaction: 'ready', selection: { suggestionId: 'gemma-4-e2b', quantizationId: 'qat-q4_0' }, startStatus: 'idle', startError: undefined } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
        now.mockRestore();
      },
    };
    const swipe = wrapper.get('[data-testid="model-swipe"]');
    const down = new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 20 });
    const up = new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 40, clientY: 20 });
    Object.defineProperty(down, 'pointerId', { value: 1 });
    Object.defineProperty(up, 'pointerId', { value: 1 });
    swipe.element.dispatchEvent(down);
    swipe.element.dispatchEvent(up);
    expect(wrapper.emitted('select')).toHaveLength(1);
    await wrapper.get('[data-testid="start-model"]').trigger('click');
    expect(wrapper.emitted('start')).toBeUndefined();
    now.mockReturnValue(1500);
    await wrapper.get('[data-testid="start-model"]').trigger('click');
    expect(wrapper.emitted('start')).toHaveLength(1);
  });
});
