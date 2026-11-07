import { beforeEach, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import TranslationInputProgress from './TranslationInputProgress.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

it('only reports numeric progress for measured input evaluation, never for unknown totals', async () => {
  const wrapper = mount(TranslationInputProgress, { props: { progress: undefined } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  const bar = wrapper.get('[role="progressbar"]');
  expect(bar.attributes('aria-valuenow')).toBeUndefined();
  await wrapper.setProps({ progress: { phase: 'prefill', completed: 5, total: 20 } });
  expect(bar.attributes('aria-valuenow')).toBe('25');
  expect(wrapper.text()).toContain('25%');
  await wrapper.setProps({ progress: { phase: 'prefill', completed: 0, total: 0 } });
  expect(bar.attributes('aria-valuenow')).toBeUndefined();
  expect(wrapper.find('progress').exists()).toBe(false);
});
