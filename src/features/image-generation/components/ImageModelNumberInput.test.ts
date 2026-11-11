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

it('returns a fixed value to automatic with the two-choice menu and restores keyboard focus', async () => {
  wrapper = mount(ImageModelNumberInput, { attachTo: document.body, props: { id: 'steps', label: 'Steps', minimum: 1, maximum: 100, step: 1, origin: 'recommended', preference: 32, value: 32, disabled: false, inputTestId: 'number-input' } });
  const trigger = wrapper.get<HTMLButtonElement>('[data-testid="number-input-preference"]');
  expect(trigger.text()).toBe('Fixed');
  await trigger.trigger('keydown', { key: 'ArrowDown' });
  await flushPromises();
  const action = document.querySelector<HTMLButtonElement>('[data-testid="number-input-match-model"]')!;
  const fixed = document.querySelector<HTMLButtonElement>('[data-testid="number-input-fix-value"]')!;
  expect(action.querySelector('[data-testid="number-input-match-model-label"]')?.textContent).toBe('Auto');
  expect(fixed.querySelector('[data-testid="number-input-fix-value-label"]')?.textContent).toBe('Fixed');
  expect(action.querySelector('[data-testid="number-input-match-model-description"]')?.textContent).toBe('Change with the model');
  expect(fixed.querySelector('[data-testid="number-input-fix-value-description"]')?.textContent).toBe('Keep using this number');
  expect(action.getAttribute('aria-checked')).toBe('false');
  expect(fixed.getAttribute('aria-checked')).toBe('true');
  expect(fixed.querySelector('[data-testid="number-input-fix-value-selected"]')).not.toBeNull();
  expect(document.activeElement).toBe(fixed);
  fixed.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  expect(document.activeElement).toBe(action);
  action.click();
  await flushPromises();
  expect(wrapper.emitted('change')).toEqual([['auto']]);
  expect(trigger.attributes('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger.element);
});

it('keeps an empty numeric edit invalid instead of interpreting it as automatic', async () => {
  wrapper = mount(ImageModelNumberInput, { attachTo: document.body, props: { id: 'steps', label: 'Steps', minimum: 1, maximum: 100, step: 1, origin: 'recommended', preference: 'auto', value: 32, disabled: false, inputTestId: 'number-input' } });
  await wrapper.get('[data-testid="number-input"]').setValue('');
  expect(wrapper.emitted('change')).toEqual([[NaN]]);
  await wrapper.setProps({ preference: NaN, value: NaN });
  expect(wrapper.get<HTMLInputElement>('[data-testid="number-input"]').element.value).toBe('');
  expect(wrapper.get('[data-testid="number-input-preference"]').text()).toBe('Fixed');
  await wrapper.get('[data-testid="number-input-preference"]').trigger('click');
  await flushPromises();
  const fixed = document.querySelector<HTMLButtonElement>('[data-testid="number-input-fix-value"]')!;
  const automatic = document.querySelector<HTMLButtonElement>('[data-testid="number-input-match-model"]')!;
  expect(fixed.disabled).toBe(true);
  expect(document.activeElement).toBe(automatic);
  fixed.click();
  expect(wrapper.emitted('change')).toEqual([[NaN]]);
  automatic.click();
  await flushPromises();
  expect(wrapper.emitted('change')).toEqual([[NaN], ['auto']]);
});

it('shows and pins the fixed preference rather than a legacy numeric fallback', async () => {
  wrapper = mount(ImageModelNumberInput, { attachTo: document.body, props: { id: 'steps', label: 'Steps', minimum: 1, maximum: 100, step: 1, origin: 'recommended', preference: 64, value: 32, disabled: false, inputTestId: 'number-input' } });
  expect(wrapper.get<HTMLInputElement>('[data-testid="number-input"]').element.value).toBe('64');
  await wrapper.get('[data-testid="number-input-preference"]').trigger('click');
  await flushPromises();
  document.querySelector<HTMLButtonElement>('[data-testid="number-input-fix-value"]')!.click();
  await flushPromises();
  expect(wrapper.emitted('change')).toEqual([[64]]);
});

it('pins the displayed automatic number and returns focus without editing the input', async () => {
  wrapper = mount(ImageModelNumberInput, { attachTo: document.body, props: { id: 'steps', label: 'Steps', minimum: 1, maximum: 100, step: 1, origin: 'recommended', preference: 'auto', value: 16, disabled: false, inputTestId: 'number-input' } });
  const trigger = wrapper.get<HTMLButtonElement>('[data-testid="number-input-preference"]');
  await trigger.trigger('click');
  await flushPromises();
  const automatic = document.querySelector<HTMLButtonElement>('[data-testid="number-input-match-model"]')!;
  expect(automatic.getAttribute('aria-checked')).toBe('true');
  expect(automatic.querySelector('[data-testid="number-input-match-model-selected"]')).not.toBeNull();
  document.querySelector<HTMLButtonElement>('[data-testid="number-input-fix-value"]')!.click();
  await flushPromises();
  expect(wrapper.emitted('change')).toEqual([[16]]);
  expect(trigger.attributes('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger.element);
});

it('navigates the mode choices with arrow and endpoint keys and dismisses with Escape', async () => {
  wrapper = mount(ImageModelNumberInput, { attachTo: document.body, props: { id: 'steps', label: 'Steps', minimum: 1, maximum: 100, step: 1, origin: 'recommended', preference: 'auto', value: 16, disabled: false, inputTestId: 'number-input' } });
  const trigger = wrapper.get<HTMLButtonElement>('[data-testid="number-input-preference"]');
  await trigger.trigger('click');
  await flushPromises();
  const automatic = document.querySelector<HTMLButtonElement>('[data-testid="number-input-match-model"]')!;
  const fixed = document.querySelector<HTMLButtonElement>('[data-testid="number-input-fix-value"]')!;
  expect(document.activeElement).toBe(automatic);
  automatic.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  expect(document.activeElement).toBe(fixed);
  fixed.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(document.activeElement).toBe(automatic);
  automatic.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  expect(document.activeElement).toBe(fixed);
  fixed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  expect(document.activeElement).toBe(automatic);
  automatic.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flushPromises();
  expect(wrapper.emitted('change')).toBeUndefined();
  expect(trigger.attributes('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger.element);
});

it('closes for pending disabled or model updates without selecting a mode', async () => {
  wrapper = mount(ImageModelNumberInput, { attachTo: document.body, props: { id: 'steps', label: 'Steps', minimum: 1, maximum: 100, step: 1, origin: 'recommended', preference: 'auto', value: 16, disabled: false, inputTestId: 'number-input' } });
  const trigger = wrapper.get<HTMLButtonElement>('[data-testid="number-input-preference"]');
  trigger.element.click();
  await wrapper.setProps({ disabled: true });
  await flushPromises();
  expect(trigger.attributes('aria-expanded')).toBe('false');
  expect(document.querySelector('[data-testid="number-input-match-model"]')).toBeNull();
  await wrapper.setProps({ disabled: false });
  trigger.element.click();
  await wrapper.setProps({ value: 32 });
  await flushPromises();
  expect(trigger.attributes('aria-expanded')).toBe('false');
  expect(document.querySelector('[data-testid="number-input-match-model"]')).toBeNull();
  expect(wrapper.emitted('change')).toBeUndefined();
});

it('ignores stale actions while a dismissed menu is leaving', async () => {
  wrapper = mount(ImageModelNumberInput, {
    attachTo: document.body,
    props: { id: 'steps', label: 'Steps', minimum: 1, maximum: 100, step: 1, origin: 'recommended', preference: 'auto', value: 16, disabled: false, inputTestId: 'number-input' },
    // Retain the slot after dismissal to represent the transition's leaving DOM.
    global: { stubs: { MessageActionsMenu: { template: '<div><slot /></div>' } } },
  });
  const trigger = wrapper.get<HTMLButtonElement>('[data-testid="number-input-preference"]');
  await trigger.trigger('click');
  await flushPromises();
  await trigger.trigger('click');
  const fixed = wrapper.get('[data-testid="number-input-fix-value"]');
  await fixed.trigger('click');
  await fixed.trigger('keydown', { key: 'ArrowUp' });
  expect(wrapper.emitted('change')).toBeUndefined();
  expect(trigger.attributes('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger.element);
});

it.each([false, true])('closes on Tab without preventing normal navigation (shift=%s)', async shiftKey => {
  wrapper = mount(ImageModelNumberInput, { attachTo: document.body, props: { id: 'steps', label: 'Steps', minimum: 1, maximum: 100, step: 1, origin: 'recommended', preference: 'auto', value: 16, disabled: false, inputTestId: 'number-input' } });
  const trigger = wrapper.get<HTMLButtonElement>('[data-testid="number-input-preference"]');
  await trigger.trigger('click');
  await flushPromises();
  const automatic = document.querySelector<HTMLButtonElement>('[data-testid="number-input-match-model"]')!;
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
  automatic.dispatchEvent(event);
  await flushPromises();
  expect(event.defaultPrevented).toBe(false);
  expect(trigger.attributes('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger.element);
  expect(wrapper.emitted('change')).toBeUndefined();
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
