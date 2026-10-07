import { afterEach, beforeEach, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { TEST_ONLY as recommendations } from '@/features/stable-diffusion-cpp-browser/recommendations';
import { parametersFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
import { applyImageRecommendedField, imageRecommendedHint } from '@/features/image-generation/recommended-fields';
import ImageRecommendedFieldHint from './ImageRecommendedFieldHint.vue';
let wrapper: VueWrapper | undefined;

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  wrapper?.unmount(); wrapper = undefined;
});

function openHint() {
  wrapper = mount(ImageRecommendedFieldHint, { attachTo: document.body, global: { stubs: { Teleport: true } }, props: { recommendation: recommendations.presets['z-image-turbo'], field: 'steps', current: 20, inputId: 'steps', context: 'A', disabled: false, busy: true } });
  return wrapper;
}

it('shows a gentle per-field action and rejects an open hint after the session changes', async () => {
  const view = openHint();
  expect(view.text()).toContain('8'); expect(view.find('[role="alert"]').exists()).toBe(false);
  await view.get('[data-testid="recommended-field-hint"]').trigger('click');
  expect(view.text()).toContain('next generation');
  await view.setProps({ context: 'B' });
  expect(view.find('[data-testid="recommended-field-apply"]').exists()).toBe(false);
  await view.get('[data-testid="recommended-field-hint"]').trigger('click');
  await view.get('[data-testid="recommended-field-apply"]').trigger('click');
  expect(view.emitted('apply')).toEqual([[{ field: 'steps', recommendationId: 'z-image-turbo', context: 'B' }]]);
  await view.setProps({ current: 8 }); expect(view.find('button').exists()).toBe(false);
});

it('accepts the entire recommended range, not just the representative preset', async () => {
  const view = openHint(); await view.setProps({ recommendation: recommendations.presets['anima-turbo-1.1'], current: 12 });
  expect(view.find('button').exists()).toBe(false);
  await view.setProps({ current: 13 }); expect(view.find('button').exists()).toBe(true);
});

it('changes only the requested field, keeping prompt, size and deliberate other deviations', () => {
  const parameters = { ...parametersFixture(), steps: 20, guidance: 7, prompt: 'mine', width: 1024 };
  const next = applyImageRecommendedField({ parameters, recommendation: recommendations.presets['z-image-turbo'], field: 'steps' });
  expect(next).toEqual({ ...parameters, steps: 8 }); expect(parameters.steps).toBe(20);
});

it('moves keyboard focus into the hint and returns it on Escape or applying the value', async () => {
  const input = document.createElement('input'); input.id = 'steps'; document.body.append(input);
  try {
    const view = openHint(), trigger = view.get('[data-testid="recommended-field-hint"]');
    await trigger.trigger('click');
    expect(document.activeElement).toBe(view.get('[data-testid="recommended-field-apply"]').element);
    await view.get('[data-testid="recommended-field-apply"]').trigger('keydown', { key: 'Escape' });
    expect(document.activeElement).toBe(trigger.element);
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(view.get('[data-testid="recommended-field-apply"]').element);
    await view.get('[data-testid="recommended-field-apply"]').trigger('click');
    expect(document.activeElement).toBe(input);
    expect(view.emitted('apply')).toHaveLength(1);
  } finally {
    input.remove();
  }
});

it.each(['width', 'height'] as const)('offers the browser %s starting size without changing the other dimension', async field => {
  const recommendation = recommendations.presets['z-image-turbo'];
  const parameters = { ...parametersFixture(), width: 1024, height: 768, steps: 20 };
  const hint = imageRecommendedHint({ recommendation, field });
  expect(hint).toEqual({ value: 512, origin: 'suggested', range: undefined });
  expect(applyImageRecommendedField({ parameters, recommendation, field })).toEqual({ ...parameters, [field]: 512 });
  const view = openHint(); await view.setProps({ field, current: parameters[field], inputId: field });
  expect(view.get('[data-testid="recommended-field-hint"]').text()).toContain('Starting value');
  await view.get('[data-testid="recommended-field-hint"]').trigger('click');
  await view.get('[data-testid="recommended-field-apply"]').trigger('click');
  expect(view.emitted('apply')).toEqual([[{ field, recommendationId: recommendation.id, context: 'A' }]]);
});

it('does not reopen a dismissed hint when the input first matches and then differs again', async () => {
  const view = openHint();
  await view.get('[data-testid="recommended-field-hint"]').trigger('click');
  expect(view.find('[data-testid="recommended-field-apply"]').exists()).toBe(true);
  await view.setProps({ current: 8 });
  expect(view.find('[data-testid="recommended-field-hint"]').exists()).toBe(false);
  await view.setProps({ current: 20 });
  expect(view.find('[data-testid="recommended-field-hint"]').exists()).toBe(true);
  expect(view.find('[data-testid="recommended-field-apply"]').exists()).toBe(false);
});
