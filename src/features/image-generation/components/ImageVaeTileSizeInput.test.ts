import { afterEach, beforeEach, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ImageVaeTileSizeInput from './ImageVaeTileSizeInput.vue';

let wrapper: VueWrapper | undefined;

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

it('shows automatic numbers without fixing them on focus or model changes, and fixes same-value edits', async () => {
  wrapper = mount(ImageVaeTileSizeInput, { props: { id: 'tile', preference: 'auto', value: 16, disabled: false, inputTestId: 'tile-input' } });
  const input = wrapper.get<HTMLInputElement>('[data-testid="tile-input"]');
  expect(input.element.value).toBe('16');
  expect(wrapper.get('[data-testid="vae-tile-size-preference"]').text()).toBe('Auto');
  expect(wrapper.get('[data-testid="vae-tile-size-preference"]').attributes('aria-label')).toBe('VAE tile size (latent pixels): Auto');
  await input.trigger('focus');
  await wrapper.setProps({ value: 32 });
  expect(input.element.value).toBe('32');
  expect(wrapper.emitted('change')).toBeUndefined();
  await input.setValue('32');
  expect(wrapper.emitted('change')).toEqual([[32]]);
});

it('returns a fixed value to automatic with the model-following menu and restores keyboard focus', async () => {
  wrapper = mount(ImageVaeTileSizeInput, { attachTo: document.body, props: { id: 'tile', preference: 32, value: 32, disabled: false, inputTestId: 'tile-input' } });
  const trigger = wrapper.get<HTMLButtonElement>('[data-testid="vae-tile-size-preference"]');
  expect(trigger.text()).toBe('Fixed');
  await trigger.trigger('keydown', { key: 'ArrowDown' });
  await flushPromises();
  const action = document.querySelector<HTMLButtonElement>('[data-testid="vae-tile-size-match-model"]')!;
  expect(action.textContent).toBe('Match model');
  expect(action.getAttribute('aria-checked')).toBe('false');
  expect(document.activeElement).toBe(action);
  action.click();
  await flushPromises();
  expect(wrapper.emitted('change')).toEqual([['auto']]);
  expect(trigger.attributes('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger.element);
});

it('keeps an empty numeric edit invalid instead of interpreting it as automatic', async () => {
  wrapper = mount(ImageVaeTileSizeInput, { props: { id: 'tile', preference: 'auto', value: 32, disabled: false, inputTestId: 'tile-input' } });
  await wrapper.get('[data-testid="tile-input"]').setValue('');
  expect(wrapper.emitted('change')).toEqual([[NaN]]);
  await wrapper.setProps({ preference: NaN, value: NaN });
  expect(wrapper.get<HTMLInputElement>('[data-testid="tile-input"]').element.value).toBe('');
  expect(wrapper.get('[data-testid="vae-tile-size-preference"]').text()).toBe('Fixed');
});

it('shows the fixed preference rather than a legacy numeric fallback', () => {
  wrapper = mount(ImageVaeTileSizeInput, { props: { id: 'tile', preference: 64, value: 32, disabled: false, inputTestId: 'tile-input' } });
  expect(wrapper.get<HTMLInputElement>('[data-testid="tile-input"]').element.value).toBe('64');
});

it('keeps both unavailable controls visible and disabled', () => {
  wrapper = mount(ImageVaeTileSizeInput, { props: { id: 'tile', preference: 'auto', value: 16, disabled: true, inputTestId: 'tile-input' } });
  expect(wrapper.get('[data-testid="tile-input"]').attributes('disabled')).toBeDefined();
  expect(wrapper.get('[data-testid="vae-tile-size-preference"]').attributes('disabled')).toBeDefined();
});
