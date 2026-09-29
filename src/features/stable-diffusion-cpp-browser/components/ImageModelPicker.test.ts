import { beforeEach, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageModelPicker from './ImageModelPicker.vue';
import type { ImageModelChoice } from '@/features/stable-diffusion-cpp-browser/library-view';
const choices: ImageModelChoice[] = [
  { id: 'matching', label: 'Compatible dimensions', detail: 'user/encoder/model.gguf', evidence: ['width: 2560; layers: 36'], status: 'matching', issue: undefined },
  { id: 'wrong', label: 'Wrong model family', detail: 'user/gemma/model.gguf', evidence: ['architecture: gemma'], status: 'incompatible', issue: undefined },
  { id: 'unknown', label: 'Unverified', detail: 'user/custom/model.gguf', evidence: [], status: 'unverified', issue: undefined },
];
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});
it('shows structural evidence, and never emits a known-incompatible choice', async () => {
  const view = mount(ImageModelPicker, { props: { label: 'Text encoder', modelValue: 'matching', choices, required: true, disabled: false } });
  expect(view.text()).toContain('width: 2560'); expect(view.get('option[value="wrong"]').attributes('disabled')).toBeDefined();
  await view.get('select').setValue('wrong'); expect(view.emitted('update:modelValue')).toBeUndefined();
  await view.get('select').setValue('unknown'); expect(view.emitted('update:modelValue')).toEqual([['unknown']]); view.unmount();
});
it('keeps the currently selected candidate visible while filtering, and is inert when disabled', async () => {
  const many = [...choices, ...Array.from({ length: 6 }, (_, i) => ({ ...choices[0]!, id: `extra-${i}` }))];
  const view = mount(ImageModelPicker, { props: { label: 'VAE', modelValue: 'matching', choices: many, required: true, disabled: false } });
  await view.get('input[type="search"]').setValue('nothing matches'); expect(view.find('option[value="matching"]').exists()).toBe(true);
  await view.setProps({ disabled: true }); expect(view.get('select').element.matches(':disabled')).toBe(true);
  await view.get('select').setValue(''); expect(view.emitted('update:modelValue')).toBeUndefined(); view.unmount();
});
