import { afterEach, beforeEach, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageInputControls from './ImageInputControls.vue';
import { emptyImageInputs } from '@/features/stable-diffusion-cpp-browser/image-input-form';

let wrapper: VueWrapper<InstanceType<typeof ImageInputControls>> | undefined;
let inputs = emptyImageInputs();
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' }); inputs = emptyImageInputs();
  wrapper = mount(ImageInputControls, { props: { modelValue: inputs, disabled: false,
    'onUpdate:modelValue': value => {
      inputs = value; void wrapper?.setProps({ modelValue: value });
    },
  } });
});
afterEach(() => wrapper?.unmount());
async function choose({ selector, files }: { selector: string, files: File[] }): Promise<void> {
  const input = wrapper!.get<HTMLInputElement>(`[data-testid="${selector}"]`);
  Object.defineProperty(input.element, 'files', { configurable: true, value: files }); await input.trigger('change');
}
it('keeps init and ordered references independent and removes each without changing the other', async () => {
  const first = new File(['image'], 'first.png', { type: 'image/png' });
  const second = new File(['another image'], 'second.png', { type: 'image/png' });
  await choose({ selector: 'image-input-initial', files: [first] });
  await wrapper!.get('[data-testid="image-input-strength"]').setValue('0.4');
  await choose({ selector: 'image-input-references', files: [second, first] });
  expect(inputs).toEqual({ initImage: first, strength: 0.4, referenceImages: [second, first] });
  await wrapper!.findAll('[data-testid="image-input-remove-reference"]')[0]!.trigger('click');
  expect(inputs.referenceImages).toEqual([first]);
  await wrapper!.get('[data-testid="image-input-clear-initial"]').trigger('click');
  expect(inputs).toEqual({ initImage: undefined, strength: 0.4, referenceImages: [first] });
});
it('keeps unavailable inputs visible and rejects programmatic file changes', async () => {
  await wrapper!.setProps({ disabled: true });
  expect(wrapper!.get('[data-testid="image-input-initial"]').element.matches(':disabled')).toBe(true);
  expect(wrapper!.get('[data-testid="image-input-references"]').element.matches(':disabled')).toBe(true);
  await choose({ selector: 'image-input-initial', files: [new File(['image'], 'image.png', { type: 'image/png' })] });
  expect(inputs.initImage).toBeUndefined();
});
it('rejects an invalid selection without losing existing files', async () => {
  const file = new File(['image'], 'image.png', { type: 'image/png' });
  await choose({ selector: 'image-input-references', files: [file] });
  await choose({ selector: 'image-input-references', files: [new File(['unsupported'], 'image.svg', { type: 'image/svg+xml' })] });
  expect(inputs.referenceImages).toEqual([file]); expect(wrapper!.get('[role="alert"]').text()).toContain('PNG');
});
