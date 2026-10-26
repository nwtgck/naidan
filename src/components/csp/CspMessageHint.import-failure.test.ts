import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import CspToolCardFrame from './CspToolCardFrame.vue';
import CspMessageHint from './CspMessageHint.vue';

vi.mock('@/composables/useCspMessageHintsOnly', () => {
  throw new Error('Optional diagnostic module could not load');
});

describe('CSP module load isolation', () => {
  it('keeps the original controls and card when a diagnostic import rejects', async () => {
    const applicationError = vi.fn();
    using mounted = {
      wrapper: mount(CspToolCardFrame, {
        props: { toolKey: 'builtin.wikipedia', enabled: true },
        slots: { default: '<button data-testid="existing-control">ON</button>' },
        global: { config: { errorHandler: applicationError } },
      }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    const original = mounted.wrapper.get('[data-testid="existing-control"]').element;
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(mounted.wrapper.get('[data-testid="existing-control"]').element).toBe(original);
    expect(mounted.wrapper.classes()).toContain('h-[52px]');
    expect(mounted.wrapper.find('[data-csp-tool-notice]').exists()).toBe(false);
    expect(applicationError).not.toHaveBeenCalled();
  });

  it('leaves the URL label row and focused input intact without an empty disclosure or popup', async () => {
    const applicationError = vi.fn();
    using mounted = {
      wrapper: mount(defineComponent({
        render: () => h('div', [
          h('div', { 'data-testid': 'url-label-row' }, [h('label', { for: 'existing-url' }, 'URL'), h(CspMessageHint, { activityForDisplayOnly: undefined, target: { kind: 'wikipedia' }, presentation: 'compact' })]),
          h('input', { id: 'existing-url', value: 'https://remote.invalid' }),
        ]),
      }), { attachTo: document.body, global: { config: { errorHandler: applicationError } } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    const input = mounted.wrapper.get<HTMLInputElement>('#existing-url').element;
    input.focus();
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(mounted.wrapper.get('#existing-url').element).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(mounted.wrapper.get('[data-testid="url-label-row"]').text()).toBe('URL');
    expect(mounted.wrapper.find('aside, [aria-controls], [aria-describedby]').exists()).toBe(false);
    expect(document.querySelector('[data-testid="csp-hint-popup"]')).toBeNull();
    expect(applicationError).not.toHaveBeenCalled();
  });
});
