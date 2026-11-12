import { beforeEach, expect, it } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ImageCompositionModeSelect from './ImageCompositionModeSelect.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

it('offers the next mode and restores keyboard focus after replacing the editor', async () => {
  const wrapper = mount(defineComponent({
    setup() {
      const mode = ref<'single' | 'multiple'>('single');
      return () => h(mode.value === 'single' ? 'section' : 'article', { key: mode.value }, [h(ImageCompositionModeSelect, {
        id: 'input-mode',
        mode: mode.value,
        disabled: false,
        'onUpdate:mode': (value: 'single' | 'multiple') => {
          mode.value = value;
        },
      })]);
    },
  }), { attachTo: document.body });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };

  await wrapper.get('[data-testid="composition-mode-multiple"]').trigger('click');
  await flushPromises();
  expect(wrapper.get('[data-testid="composition-mode-multiple"]').attributes('aria-pressed')).toBe('true');
  expect(wrapper.get('[data-testid="composition-mode-single"]').text()).toBe('Single prompt');
  expect(document.activeElement).toBe(wrapper.get('[data-testid="composition-mode-multiple"]').element);

  await wrapper.get('[data-testid="composition-mode-single"]').trigger('click');
  await flushPromises();
  expect(wrapper.find('[data-testid="composition-mode-single"]').exists()).toBe(false);
  expect(document.activeElement).toBe(wrapper.get('[data-testid="composition-mode-multiple"]').element);
  expect(wrapper.findAll('button')).toHaveLength(1);
});

it('does not change mode while editing is disabled', async () => {
  const wrapper = mount(ImageCompositionModeSelect, { props: { id: 'input-mode', mode: 'multiple', disabled: true } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await wrapper.get('[data-testid="composition-mode-single"]').trigger('click');
  expect(wrapper.emitted('update:mode')).toBeUndefined();
  expect(wrapper.get('[data-testid="composition-mode-single"]').attributes('disabled')).toBeDefined();
  expect(wrapper.get('[data-testid="composition-mode-multiple"]').attributes('aria-pressed')).toBe('true');
});
