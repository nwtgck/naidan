import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageInputControls from './ImageInputControls.vue';
import { emptyImageInputs } from '@/features/image-generation/image-input-form';
import { requestFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
import { requestSchema } from '@/features/stable-diffusion-cpp-browser/types';

let wrapper: VueWrapper<InstanceType<typeof ImageInputControls>> | undefined;
let inputs = emptyImageInputs();
const createUrl = vi.fn(), revokeUrl = vi.fn();
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
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
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
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

function clipboard({ read }: { read: () => Promise<ClipboardItem[]> }): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read } });
}
function clipboardItem({ types }: { types: string[] }): ClipboardItem {
  return { types, presentationStyle: 'unspecified', getType: vi.fn(async (type: string) => new Blob(['pixels'], { type })) };
}
function pasteEvent({ files, items }: { files: File[], items: { type: string, getAsFile(): File | undefined }[] }): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files, items } });
  return event as ClipboardEvent;
}
it('pastes into the explicitly focused role, preserves reference order and never imports both files and items', async () => {
  await expand();
  const first = new File(['one'], 'first.png', { type: 'image/png' }), second = new File(['two'], 'second.webp', { type: 'image/webp' });
  const initial = pasteEvent({ files: [first, second], items: [{ type: 'image/png', getAsFile: () => first }] });
  wrapper!.get('[data-testid="image-input-initial-drop"]').element.dispatchEvent(initial); await flushPromises();
  expect(initial.defaultPrevented).toBe(true); expect(inputs.initImage).toBe(first);
  const reference = pasteEvent({ files: [], items: [{ type: 'image/webp', getAsFile: () => second }, { type: 'image/png', getAsFile: () => first }] });
  wrapper!.get('[data-testid="image-input-reference-drop"]').element.dispatchEvent(reference); await flushPromises();
  expect(inputs.referenceImages).toEqual([second, first]); expect(inputs.initImage).toBe(first);
});
it('leaves text paste and strength editing alone and reports unsupported image types without replacing inputs', async () => {
  await expand();
  const file = new File(['one'], 'first.png', { type: 'image/png' }); await choose({ selector: 'image-input-initial', files: [file] });
  const plain = pasteEvent({ files: [], items: [{ type: 'text/plain', getAsFile: () => undefined }] });
  wrapper!.get('[data-testid="image-input-reference-drop"]').element.dispatchEvent(plain);
  const inNumber = pasteEvent({ files: [file], items: [] });
  wrapper!.get('[data-testid="image-input-strength"]').element.dispatchEvent(inNumber);
  await flushPromises();
  expect(plain.defaultPrevented).toBe(false); expect(inNumber.defaultPrevented).toBe(false);
  expect(inputs.referenceImages).toHaveLength(0);
  const unsupported = pasteEvent({ files: [new File(['svg'], 'unsupported.svg', { type: 'image/svg+xml' })], items: [] });
  wrapper!.get('[data-testid="image-input-initial-drop"]').element.dispatchEvent(unsupported); await flushPromises();
  expect(inputs.initImage).toBe(file); expect(wrapper!.get('[role="alert"]').text()).toContain('PNG');
});
it.each(['inactive', 'disabled', 'collapsed'] as const)('does not intercept native image paste while %s', async state => {
  await expand();
  switch (state) {
  case 'inactive': await wrapper!.setProps({ active: false }); break;
  case 'disabled': await wrapper!.setProps({ disabled: true }); break;
  case 'collapsed': wrapper!.get<HTMLDetailsElement>('details').element.open = false; await wrapper!.get('details').trigger('toggle'); break;
  default: { const exhaustive: never = state; throw new Error(String(exhaustive)); }
  }
  const event = pasteEvent({ files: [new File(['x'], 'paste.png', { type: 'image/png' })], items: [] });
  wrapper!.get('[data-testid="image-input-initial-drop"]').element.dispatchEvent(event); await flushPromises();
  expect(event.defaultPrevented).toBe(false); expect(inputs.initImage).toBeUndefined();
});
it('requests clipboard access only after a click and imports one representation per clipboard image', async () => {
  const first = clipboardItem({ types: ['text/html', 'image/webp', 'image/png'] }), second = clipboardItem({ types: ['image/jpeg'] });
  const read = vi.fn(async () => [first, second]); clipboard({ read });
  await expand(); expect(read).not.toHaveBeenCalled();
  await wrapper!.get('[data-testid="image-input-paste-reference"]').trigger('click'); await flushPromises();
  expect(read).toHaveBeenCalledOnce(); expect(first.getType).toHaveBeenCalledExactlyOnceWith('image/png');
  expect(inputs.referenceImages.map(file => file.type)).toEqual(['image/png', 'image/jpeg']);
  expect(inputs.referenceImages.map(file => file.name)).toEqual(['clipboard-1.png', 'clipboard-2.jpg']);
});
it.each(['unavailable', 'denied', 'no-image'] as const)('explains %s clipboard access and preserves native-paste fallback', async state => {
  switch (state) {
  case 'unavailable': Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); break;
  case 'denied': clipboard({ read: async () => {
    throw new DOMException('Denied', 'NotAllowedError');
  } }); break;
  case 'no-image': clipboard({ read: async () => [clipboardItem({ types: ['text/plain'] })] }); break;
  default: { const exhaustive: never = state; throw new Error(String(exhaustive)); }
  }
  await expand(); await wrapper!.get('[data-testid="image-input-paste-initial"]').trigger('click'); await flushPromises();
  expect(wrapper!.get('[data-testid="image-input-clipboard-feedback-initial"]').text()).not.toBe('');
  expect(inputs.initImage).toBeUndefined();
  const file = new File(['fallback'], 'fallback.png', { type: 'image/png' });
  wrapper!.get('[data-testid="image-input-initial-drop"]').element.dispatchEvent(pasteEvent({ files: [file], items: [] })); await flushPromises();
  expect(inputs.initImage).toBe(file);
});
it.each(['inputs-replaced', 'disabled-then-enabled', 'inactive', 'unmounted'] as const)('discards a pending permission read after %s', async change => {
  const gate = Promise.withResolvers<ClipboardItem[]>(); const read = vi.fn(() => gate.promise); clipboard({ read });
  await expand(); await wrapper!.get('[data-testid="image-input-paste-initial"]').trigger('click');
  const emittedBefore = wrapper!.emitted('update:modelValue')?.length ?? 0;
  const captured = wrapper!;
  switch (change) {
  case 'inputs-replaced': inputs = { ...emptyImageInputs() }; await wrapper!.setProps({ modelValue: inputs }); break;
  case 'disabled-then-enabled': await wrapper!.setProps({ disabled: true }); await wrapper!.setProps({ disabled: false }); break;
  case 'inactive': await wrapper!.setProps({ active: false }); break;
  case 'unmounted': wrapper!.unmount(); wrapper = undefined; break;
  default: { const exhaustive: never = change; throw new Error(String(exhaustive)); }
  }
  gate.resolve([clipboardItem({ types: ['image/png'] })]); await flushPromises();
  expect(captured.emitted('update:modelValue')?.length ?? 0).toBe(emittedBefore);
  expect(inputs.initImage).toBeUndefined();
});
