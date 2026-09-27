import { afterEach, beforeEach, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageLoraControls from './ImageLoraControls.vue';
import type { ImageLoraSelection } from '@/features/stable-diffusion-cpp-browser/lora-form';

let wrapper: VueWrapper<InstanceType<typeof ImageLoraControls>> | undefined;
let selections: ImageLoraSelection[];
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  selections = [];
  wrapper = mount(ImageLoraControls, { props: { modelValue: selections, disabled: false,
    'onUpdate:modelValue': value => {
      selections = value;
      void wrapper?.setProps({ modelValue: value });
    },
  } });
});
afterEach(() => wrapper?.unmount());

async function choose({ files }: { files: File[] }): Promise<void> {
  const input = wrapper!.get<HTMLInputElement>('[data-testid="image-lora-files"]');
  Object.defineProperty(input.element, 'files', { configurable: true, value: files });
  await input.trigger('change');
}
it('keeps original files, allows strength edits and disables without losing the chosen strength', async () => {
  const file = new File(['original adapter bytes'], 'style.safetensors');
  await choose({ files: [file] });
  expect(selections[0]?.file).toBe(file);
  expect(wrapper!.get('[data-testid="image-lora-row"]').text()).toContain(file.name);
  await wrapper!.get('[data-testid="image-lora-strength"]').setValue('-0.75');
  await wrapper!.get('[data-testid="image-lora-enabled"]').setValue(false);
  expect(selections[0]).toEqual({ file, strength: -0.75, enabled: false });
  expect(wrapper!.get('[data-testid="image-lora-strength"]').element.matches(':disabled')).toBe(true);
  await wrapper!.get('[data-testid="image-lora-enabled"]').setValue(true);
  expect(selections[0]?.strength).toBe(-0.75);
  await wrapper!.get('[data-testid="image-lora-remove"]').trigger('click');
  expect(selections).toEqual([]);
});
it('rejects an entire over-limit selection without silently truncating it', async () => {
  await choose({ files: [new File(['original'], 'original.gguf')] });
  await choose({ files: Array.from({ length: 16 }, (_, index) => new File(['adapter fixture'], `${index}.gguf`)) });
  expect(selections.map(selection => selection.file.name)).toEqual(['original.gguf']);
  expect(wrapper!.get('[data-testid="image-lora-file-error"]').text()).toContain('16');
});
it.each([new File(['not an adapter'], 'model.json'), new File([], 'empty.safetensors'), new File(['1234567'], 'short.gguf')])('rejects invalid file input %s', async file => {
  await choose({ files: [file] });
  expect(selections).toEqual([]);
  expect(wrapper!.find('[data-testid="image-lora-file-error"]').exists()).toBe(true);
});
it('preserves an invalid empty strength for request validation rather than silently substituting a value', async () => {
  await choose({ files: [new File(['adapter fixture'], 'style.gguf')] });
  await wrapper!.get('[data-testid="image-lora-strength"]').setValue('');
  expect(Number.isNaN(selections[0]?.strength)).toBe(true);
});
it('keeps unavailable controls visible and rejects programmatic file changes', async () => {
  await wrapper!.setProps({ disabled: true });
  expect(wrapper!.get('[data-testid="image-lora-files"]').element.matches(':disabled')).toBe(true);
  await choose({ files: [new File(['adapter fixture'], 'style.gguf')] });
  expect(selections).toEqual([]);
});
