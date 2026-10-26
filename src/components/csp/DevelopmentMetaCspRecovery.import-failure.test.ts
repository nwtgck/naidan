import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import DevelopmentMetaCspRecovery from './DevelopmentMetaCspRecovery.vue';

vi.mock('./DevelopmentMetaCspRecoveryContent.vue', () => {
  throw new Error('Optional resident recovery could not load');
});

describe('optional recovery host loading', () => {
  it('keeps ordinary auxiliary controls intact when recovery cannot be prepared', async () => {
    const clicked = vi.fn();
    const applicationError = vi.fn();
    using mounted = {
      wrapper: mount(defineComponent({ render: () => h('div', [h(DevelopmentMetaCspRecovery), h('button', { 'data-testid': 'existing-export-host', onClick: clicked }, 'Export')]) }), { global: { config: { errorHandler: applicationError } } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    const original = mounted.wrapper.get('[data-testid="existing-export-host"]').element;
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(mounted.wrapper.find('[data-testid="development-meta-csp-recovery"]').exists()).toBe(false);
    expect(mounted.wrapper.get('[data-testid="existing-export-host"]').element).toBe(original);
    await mounted.wrapper.get('[data-testid="existing-export-host"]').trigger('click');
    expect(clicked).toHaveBeenCalledOnce();
    expect(applicationError).not.toHaveBeenCalled();
  });
});
