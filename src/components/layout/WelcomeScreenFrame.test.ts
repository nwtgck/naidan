import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import WelcomeScreenFrame from './WelcomeScreenFrame.vue';

describe('shared welcome frame', () => {
  it('keeps contained entry content in normal flow with the established spacing', () => {
    const wrapper = mount(WelcomeScreenFrame, { props: { placement: 'contained' }, slots: { default: '<section data-testid="entry-content">Entry</section>' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expect(wrapper.classes()).toEqual(expect.arrayContaining(['relative', 'w-full', 'min-h-full', 'justify-center', 'p-6', 'sm:p-12']));
    expect(wrapper.classes()).not.toContain('absolute');
    expect(wrapper.get('[data-testid="entry-content"]').text()).toBe('Entry');
    const body = wrapper.get('.max-w-4xl');
    expect(body.classes()).toEqual(expect.arrayContaining(['space-y-8', 'sm:space-y-12']));
    expect(body.classes()).not.toContain('translate-y-[-25%]');
  });

  it('preserves floating welcome placement and forwards native interaction boundaries', async () => {
    const drop = vi.fn();
    const wrapper = mount(WelcomeScreenFrame, { props: { placement: 'floating' }, attrs: { inert: true, 'data-testid': 'welcome-frame', onDrop: drop } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expect(wrapper.classes()).toEqual(expect.arrayContaining(['absolute', 'inset-0', 'pointer-events-none']));
    expect(wrapper.get('.max-w-4xl').classes()).toEqual(expect.arrayContaining(['animate-in', 'fade-in', 'zoom-in', 'translate-y-[-25%]', 'sm:translate-y-[-30%]']));
    expect(wrapper.attributes('inert')).toBeDefined();
    await wrapper.trigger('drop');
    expect(drop).toHaveBeenCalledOnce();
  });
});
