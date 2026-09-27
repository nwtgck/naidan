import { afterEach, beforeEach, expect, it } from 'vitest';
import { DOMWrapper, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageModelPicker from './ImageModelPicker.vue';
import type { ImageModelChoice } from '@/features/stable-diffusion-cpp-browser/library-view';
const choices: ImageModelChoice[] = [
  { id: 'matching', label: 'Compatible dimensions', detail: 'OPFS: user/encoder/model.gguf', evidence: ['width: 2560; layers: 36'], status: 'matching', issue: undefined },
  { id: 'wrong', label: 'Wrong model family', detail: 'Host folder: user/gemma/model.gguf', evidence: ['architecture: gemma'], status: 'incompatible', issue: 'Wrong encoder dimensions' },
  { id: 'unknown', label: 'Unverified', detail: 'Host folder: user/custom/model.gguf', evidence: [], status: 'unverified', issue: undefined },
];
let view: VueWrapper | undefined;
let host: HTMLElement | undefined;
function create({ props }: { props: Partial<InstanceType<typeof ImageModelPicker>['$props']> }) {
  host = document.createElement('div'); document.body.append(host);
  view = mount(ImageModelPicker, { attachTo: host, props: { label: 'VAE', modelValue: 'matching', choices, required: false, disabled: false, active: true, ...props } });
  return view;
}
function popup() {
  const element = document.querySelector('[data-testid="image-model-picker-popup"]');
  if (!(element instanceof HTMLElement)) throw new Error('Picker popup is missing');
  return new DOMWrapper(element);
}
function activeOption({ input }: { input: Element }): HTMLElement {
  const id = input.getAttribute('aria-activedescendant');
  const option = id ? document.getElementById(id) : undefined;
  if (!option) throw new Error('Active option is missing');
  return option;
}
async function open({ wrapper }: { wrapper: VueWrapper }) {
  await wrapper.get('[data-testid="image-model-picker-trigger"]').trigger('click'); await nextTick();
  return popup();
}
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  view?.unmount(); view = undefined; host?.remove(); host = undefined;
});

it('makes clearing an optional checkpoint override an explicit built-in component choice', async () => {
  const wrapper = create({ props: {} });
  const menu = await open({ wrapper });
  expect(menu.get('[data-value=""]').text()).toBe('Use built-in component');
  await menu.get('[data-value=""]').trigger('click');
  expect(wrapper.emitted('update:modelValue')).toEqual([['']]);
  expect(document.activeElement).toBe(wrapper.get('[data-testid="image-model-picker-trigger"]').element);
  await wrapper.setProps({ required: true });
  expect((await open({ wrapper })).get('[data-value=""]').text()).not.toBe('Use built-in component');
});
it('shows structural evidence, and never emits a known-incompatible choice', async () => {
  const wrapper = create({ props: { label: 'Text encoder', required: true } });
  expect(wrapper.text()).toContain('width: 2560');
  const menu = await open({ wrapper });
  expect(menu.get('[data-value="wrong"]').attributes('disabled')).toBeDefined();
  expect(menu.get('[data-value="wrong"]').attributes('aria-disabled')).toBe('true');
  expect(menu.get('[data-value="wrong"]').text()).toContain('Wrong encoder dimensions');
  await menu.get('[data-value="wrong"]').trigger('click'); expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  await menu.get('[data-value="unknown"]').trigger('click'); expect(wrapper.emitted('update:modelValue')).toEqual([['unknown']]);
});
it('keeps the current selection inspectable while filtering, and closes when disabled', async () => {
  const many = [...choices, ...Array.from({ length: 6 }, (_, i) => ({ ...choices[0]!, id: `extra-${i}` }))];
  const wrapper = create({ props: { choices: many, required: true } });
  const menu = await open({ wrapper });
  await menu.get('[data-testid="image-model-picker-search"]').setValue('nothing matches');
  expect(menu.find('[data-value="matching"]').exists()).toBe(true);
  expect(menu.find('[data-value="unknown"]').exists()).toBe(false);
  expect(menu.find('[data-testid="image-model-picker-empty"]').exists()).toBe(true);
  await wrapper.setProps({ disabled: true });
  expect(document.querySelector('[data-testid="image-model-picker-popup"]')).toBeNull();
  expect(wrapper.get('button').element.matches(':disabled')).toBe(true);
  await wrapper.get('button').trigger('click'); expect(wrapper.emitted('update:modelValue')).toBeUndefined();
});
it('always offers search in compact mode and distinguishes duplicate filenames by their local paths', async () => {
  const wrapper = create({ props: { compact: true, choices: choices.map(choice => ({ ...choice, label: 'weights.gguf' })) } });
  expect(wrapper.get('[data-testid="image-model-picker-trigger"]').text()).toBe('weights.gguf');
  const menu = await open({ wrapper });
  expect(menu.get('[data-testid="image-model-picker-search"]').attributes('placeholder')).toBe('Search choices');
  expect(menu.get('[data-testid="image-model-picker-search"]').attributes('aria-label')).toBe('Search choices');
  expect(menu.get('[data-value="matching"]').text()).toContain('OPFS: user/encoder/model.gguf');
  expect(menu.get('[data-value="unknown"]').text()).toContain('Host folder: user/custom/model.gguf');
  await menu.get('[data-testid="image-model-picker-search"]').setValue('host custom');
  expect(menu.find('[data-value="unknown"]').exists()).toBe(true);
  expect(menu.find('[data-value="wrong"]').exists()).toBe(false);
});
it('supports keyboard navigation, skipping incompatible options and restoring trigger focus on selection', async () => {
  const wrapper = create({ props: {} });
  const trigger = wrapper.get('[data-testid="image-model-picker-trigger"]');
  await trigger.trigger('keydown', { key: 'ArrowDown' }); await nextTick();
  const input = popup().get('[data-testid="image-model-picker-search"]');
  expect(document.activeElement).toBe(input.element);
  expect(activeOption({ input: input.element }).getAttribute('data-value')).toBe('matching');
  await input.trigger('keydown', { key: 'ArrowDown' });
  expect(activeOption({ input: input.element }).getAttribute('data-value')).toBe('unknown');
  await input.trigger('keydown', { key: 'Enter' });
  expect(wrapper.emitted('update:modelValue')).toEqual([['unknown']]);
  expect(trigger.attributes('aria-expanded')).toBe('false'); expect(document.activeElement).toBe(trigger.element);
});
it('ignores composition Enter, closes on Escape/Tab, and does not trap tab navigation', async () => {
  const wrapper = create({ props: {} });
  let menu = await open({ wrapper });
  await menu.get('input').trigger('keydown', { key: 'Enter', isComposing: true });
  expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  await menu.get('input').trigger('keydown', { key: 'Escape' });
  expect(document.querySelector('[data-testid="image-model-picker-popup"]')).toBeNull();
  expect(document.activeElement).toBe(wrapper.get('button').element);
  menu = await open({ wrapper });
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  menu.get('input').element.dispatchEvent(tab); await nextTick();
  expect(tab.defaultPrevented).toBe(false); expect(document.querySelector('[data-testid="image-model-picker-popup"]')).toBeNull();
});
it('removes the teleported menu when its pane becomes inactive and never moves focus into the hidden pane', async () => {
  const wrapper = create({ props: {} }); await open({ wrapper });
  const outside = document.createElement('button'); document.body.append(outside); outside.focus();
  await wrapper.setProps({ active: false });
  expect(document.querySelector('[data-testid="image-model-picker-popup"]')).toBeNull(); expect(document.activeElement).toBe(outside);
  await wrapper.get('button').trigger('click'); expect(document.querySelector('[data-testid="image-model-picker-popup"]')).toBeNull();
  outside.remove();
});
it('closes when the containing settings section is collapsed', async () => {
  const wrapper = create({ props: {} });
  const section = document.createElement('details'); section.open = true;
  host?.parentElement?.append(section); if (host) section.append(host);
  await open({ wrapper });
  section.open = false; section.dispatchEvent(new Event('toggle')); await nextTick();
  expect(document.querySelector('[data-testid="image-model-picker-popup"]')).toBeNull();
  if (host) document.body.append(host); section.remove();
});
it('closes on outside pointer/focus while keeping focus with the destination', async () => {
  const wrapper = create({ props: {} }); await open({ wrapper });
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); await nextTick();
  expect(document.querySelector('[data-testid="image-model-picker-popup"]')).toBeNull();
  await open({ wrapper });
  const outside = document.createElement('button'); document.body.append(outside); outside.focus(); await nextTick();
  expect(document.querySelector('[data-testid="image-model-picker-popup"]')).toBeNull(); expect(document.activeElement).toBe(outside);
  outside.remove();
});
it('bounds a large local candidate list to the viewport and cleans up its portal on unmount', async () => {
  const wrapper = create({ props: { choices: Array.from({ length: 250 }, (_, i) => ({ ...choices[0]!, id: `file-${i}`, label: `Model ${i}` })) } });
  const menu = await open({ wrapper });
  expect(menu.findAll('[role="option"]')).toHaveLength(251);
  expect(Number.parseInt(menu.element.style.maxHeight)).toBeLessThanOrEqual(400);
  expect(Number.parseInt(menu.element.style.width)).toBeLessThanOrEqual(window.innerWidth - 24);
  expect(menu.get('[role="listbox"]').attributes('aria-labelledby')).toBe(wrapper.get('label').attributes('id'));
  wrapper.unmount(); view = undefined;
  expect(document.querySelector('[data-testid="image-model-picker-popup"]')).toBeNull();
});
