import { afterEach, beforeEach, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ImageModelNumberInput from './ImageModelNumberInput.vue';

let wrapper: VueWrapper | undefined;

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

it('shows automatic model numbers without fixing them on focus or model changes, and fixes same-value edits', async () => {
  wrapper = mount(ImageModelNumberInput, { props: { id: 'steps', label: 'Steps', minimum: 1, maximum: 100, step: 1, origin: 'recommended', preference: 'auto', value: 16, disabled: false, inputTestId: 'number-input' } });
  const input = wrapper.get<HTMLInputElement>('[data-testid="number-input"]');
  expect(input.element.value).toBe('16');
  expect(wrapper.get('[data-testid="number-input-preference"]').text()).toBe('Auto');
  expect(wrapper.get('[data-testid="number-input-preference"]').attributes('aria-label')).toBe('Steps: Auto');
  await input.trigger('focus');
  await wrapper.setProps({ value: 32 });
  expect(input.element.value).toBe('32');
  expect(wrapper.emitted('change')).toBeUndefined();
  await input.setValue('32');
  expect(wrapper.emitted('change')).toEqual([[32]]);
});

it('returns a fixed value to automatic with the model-following menu and restores keyboard focus', async () => {
  wrapper = mount(ImageModelNumberInput, { attachTo: document.body, props: { id: 'steps', label: 'Steps', minimum: 1, maximum: 100, step: 1, origin: 'recommended', preference: 32, value: 32, disabled: false, inputTestId: 'number-input' } });
  const trigger = wrapper.get<HTMLButtonElement>('[data-testid="number-input-preference"]');
  expect(trigger.text()).toBe('Fixed');
  await trigger.trigger('keydown', { key: 'ArrowDown' });
  await flushPromises();
  const action = document.querySelector<HTMLButtonElement>('[data-testid="number-input-match-model"]')!;
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
  wrapper = mount(ImageModelNumberInput, { props: { id: 'steps', label: 'Steps', minimum: 1, maximum: 100, step: 1, origin: 'recommended', preference: 'auto', value: 32, disabled: false, inputTestId: 'number-input' } });
  await wrapper.get('[data-testid="number-input"]').setValue('');
  expect(wrapper.emitted('change')).toEqual([[NaN]]);
  await wrapper.setProps({ preference: NaN, value: NaN });
  expect(wrapper.get<HTMLInputElement>('[data-testid="number-input"]').element.value).toBe('');
  expect(wrapper.get('[data-testid="number-input-preference"]').text()).toBe('Fixed');
});

it('shows the fixed preference rather than a legacy numeric fallback', () => {
  wrapper = mount(ImageModelNumberInput, { props: { id: 'steps', label: 'Steps', minimum: 1, maximum: 100, step: 1, origin: 'recommended', preference: 64, value: 32, disabled: false, inputTestId: 'number-input' } });
  expect(wrapper.get<HTMLInputElement>('[data-testid="number-input"]').element.value).toBe('64');
});

it('keeps both unavailable controls visible and disabled', () => {
  wrapper = mount(ImageModelNumberInput, { props: { id: 'steps', label: 'Steps', minimum: 1, maximum: 100, step: 1, origin: 'recommended', preference: 'auto', value: 16, disabled: true, inputTestId: 'number-input' } });
  expect(wrapper.get('[data-testid="number-input"]').attributes('disabled')).toBeDefined();
  expect(wrapper.get('[data-testid="number-input-preference"]').attributes('disabled')).toBeDefined();
});

it('identifies a browser standard separately from a model recommendation and hides it for a fixed value', async () => {
  wrapper = mount(ImageModelNumberInput, { props: { id: 'steps', label: 'Steps', minimum: 1, maximum: 100, step: 1, origin: 'standard', preference: 'auto', value: 20, disabled: false, inputTestId: 'number-input' } });
  expect(wrapper.get('[data-testid="number-input-origin"]').text()).toBe('Naidan standard value');
  await wrapper.setProps({ origin: 'recommended' });
  expect(wrapper.get('[data-testid="number-input-origin"]').text()).toBe('Model recommendation');
  await wrapper.setProps({ preference: 20 });
  expect(wrapper.find('[data-testid="number-input-origin"]').exists()).toBe(false);
});
