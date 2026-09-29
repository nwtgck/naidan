import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageInputControls from './ImageInputControls.vue';
import { emptyImageInputs } from '@/features/stable-diffusion-cpp-browser/image-input-form';
import { requestFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
import { requestSchema } from '@/features/stable-diffusion-cpp-browser/types';

let wrapper: VueWrapper<InstanceType<typeof ImageInputControls>> | undefined;
let inputs = emptyImageInputs();
const createUrl = vi.fn(), revokeUrl = vi.fn();
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' }); inputs = emptyImageInputs();
  createUrl.mockReset(); revokeUrl.mockReset();
  let sequence = 0; createUrl.mockImplementation(() => 'blob:input-' + ++sequence);
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = createUrl; static override revokeObjectURL = revokeUrl;
  });
  wrapper = mount(ImageInputControls, { props: { modelValue: inputs, disabled: false, active: true,
    'onUpdate:modelValue': value => {
      inputs = value; void wrapper?.setProps({ modelValue: value });
    },
  } });
});
afterEach(() => {
  wrapper?.unmount(); vi.unstubAllGlobals();
});
async function expand(): Promise<void> {
  wrapper!.get<HTMLDetailsElement>('details').element.open = true;
  await wrapper!.get('details').trigger('toggle');
}
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
it.each([
  { label: 'empty', input: '', valid: false, expected: 0.75 },
  { label: 'below minimum', input: '-0.1', valid: false, expected: 0.75 },
  { label: 'above maximum', input: '1.1', valid: false, expected: 0.75 },
  { label: 'minimum', input: '0', valid: true, expected: 0 },
  { label: 'intermediate', input: '0.4', valid: true, expected: 0.4 },
  { label: 'maximum', input: '1', valid: true, expected: 1 },
])('removes the initial image without leaving a hidden invalid $label strength', async ({ input, valid, expected }) => {
  const image = new File(['image'], 'initial.png', { type: 'image/png' });
  const reference = new File(['reference'], 'reference.webp', { type: 'image/webp' });
  await choose({ selector: 'image-input-initial', files: [image] });
  await choose({ selector: 'image-input-references', files: [reference] });
  await wrapper!.get('[data-testid="image-input-strength"]').setValue(input);
  const request = requestFixture(); request.imageInputs = inputs;
  expect(requestSchema.safeParse(request).success).toBe(valid);
  await wrapper!.get('[data-testid="image-input-clear-initial"]').trigger('click');
  expect(inputs).toEqual({ initImage: undefined, strength: expected, referenceImages: [reference] });
  expect(inputs.referenceImages[0]).toBe(reference);
  expect(wrapper!.find('[data-testid="image-input-strength"]').exists()).toBe(false);
  request.imageInputs = inputs;
  expect(requestSchema.safeParse(request).success).toBe(true);
  await wrapper!.get('[data-testid="image-input-remove-reference"]').trigger('click');
  request.imageInputs = inputs;
  expect(requestSchema.safeParse(request).success).toBe(true);
  await choose({ selector: 'image-input-initial', files: [image] });
  expect(wrapper!.get<HTMLInputElement>('[data-testid="image-input-strength"]').element.valueAsNumber).toBe(expected);
});
it('rejects an invalid selection without losing existing files', async () => {
  const file = new File(['image'], 'image.png', { type: 'image/png' });
  await choose({ selector: 'image-input-references', files: [file] });
  await choose({ selector: 'image-input-references', files: [new File(['unsupported'], 'image.svg', { type: 'image/svg+xml' })] });
  expect(inputs.referenceImages).toEqual([file]); expect(wrapper!.get('[role="alert"]').text()).toContain('PNG');
});
it('accepts local drops, reorders duplicate references and changes strength through the slider', async () => {
  const first = new File(['one'], 'same.png', { type: 'image/png' });
  const second = new File(['two'], 'same.png', { type: 'image/png' });
  await wrapper!.get('[data-testid="image-input-initial-drop"]').trigger('drop', { dataTransfer: { files: [first] } });
  await wrapper!.get('[data-testid="image-input-reference-drop"]').trigger('drop', { dataTransfer: { files: [first, second, first] } });
  await wrapper!.get('[data-testid="image-input-strength-slider"]').setValue('0.25');
  await wrapper!.findAll('[data-testid="image-input-reference-earlier"]')[2]!.trigger('click');
  expect(inputs).toEqual({ initImage: first, strength: 0.25, referenceImages: [first, first, second] });
  await wrapper!.findAll('[data-testid="image-input-remove-reference"]')[0]!.trigger('click');
  expect(inputs.referenceImages).toEqual([first, second]);
  expect(createUrl).toHaveBeenCalledTimes(2); expect(revokeUrl).not.toHaveBeenCalled();
  await wrapper!.setProps({ disabled: true });
  await wrapper!.get('[data-testid="image-input-reference-drop"]').trigger('drop', { dataTransfer: { files: [second] } });
  expect(inputs.referenceImages).toEqual([first, second]);
});
it('replaces one reference without rewriting bytes and releases only unused Blob URLs', async () => {
  const first = new File(['first'], 'first.png', { type: 'image/png' });
  const replacement = new File(['replacement'], 'replacement.webp', { type: 'image/webp' });
  await choose({ selector: 'image-input-initial', files: [first] });
  await choose({ selector: 'image-input-references', files: [first, first] });
  const input = wrapper!.findAll<HTMLInputElement>('[data-testid="image-input-replace-reference"]')[1]!;
  Object.defineProperty(input.element, 'files', { configurable: true, value: [replacement] }); await input.trigger('change');
  expect(inputs.referenceImages).toEqual([first, replacement]); expect(inputs.referenceImages[1]).toBe(replacement);
  expect(revokeUrl).not.toHaveBeenCalled();
  await wrapper!.get('[data-testid="image-input-clear-initial"]').trigger('click');
  await wrapper!.findAll('[data-testid="image-input-remove-reference"]')[0]!.trigger('click');
  expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:input-1');
  wrapper!.unmount(); wrapper = undefined;
  expect(revokeUrl.mock.calls.map(call => call[0])).toEqual(['blob:input-1', 'blob:input-2']);
});
it('shows image-specific preview errors and ignores late errors from replaced thumbnails', async () => {
  const first = new File(['first'], 'first.png', { type: 'image/png' });
  const second = new File(['second'], 'second.png', { type: 'image/png' });
  await choose({ selector: 'image-input-initial', files: [first] }); await expand();
  const old = wrapper!.get('[data-testid="image-input-expand-initial"] img');
  await choose({ selector: 'image-input-initial', files: [second] });
  await old.trigger('error'); expect(wrapper!.find('[role="alert"]').exists()).toBe(false);
  await wrapper!.get('[data-testid="image-input-expand-initial"] img').trigger('error');
  expect(wrapper!.get('[role="alert"]').text()).toContain('preview');
  expect(inputs.initImage).toBe(second);
});
it('opens an image preview and closes it when the pane becomes inactive or the file changes', async () => {
  const file = new File(['image'], 'image.png', { type: 'image/png' });
  await choose({ selector: 'image-input-initial', files: [file] });
  await wrapper!.get('[data-testid="image-input-expand-initial"]').trigger('click');
  expect(document.querySelector('[data-testid="image-viewer"]')).not.toBeNull();
  await wrapper!.setProps({ active: false });
  expect(document.querySelector('[data-testid="image-viewer"]')).toBeNull();
  await wrapper!.setProps({ active: true });
  expect(document.querySelector('[data-testid="image-viewer"]')).toBeNull();
  await wrapper!.get('[data-testid="image-input-expand-initial"]').trigger('click');
  await wrapper!.get('[data-testid="image-input-clear-initial"]').trigger('click');
  expect(document.querySelector('[data-testid="image-viewer"]')).toBeNull();
});
