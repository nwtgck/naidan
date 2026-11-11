import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { parametersFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
import ImageBenchmarkParameters from './ImageBenchmarkParameters.vue';

vi.mock('@/components/SettingsSelect.vue', async () => ({
  default: (await import('@/components/settings-select.test-support')).SettingsSelectStub,
}));

let wrapper: VueWrapper | undefined;

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

it('shows a model-resolved automatic tile and fixes a same-value edit in common settings', async () => {
  wrapper = mount(ImageBenchmarkParameters, { props: { values: { ...parametersFixture(), vaeTileSize: 16, vaeTileSizePreference: 'auto' }, overrides: undefined, disabled: false, bf16RetentionSupported: true } });
  const input = wrapper.get<HTMLInputElement>('[data-testid="parameter-vaeTileSize"]');
  expect(input.element.value).toBe('16');
  expect(wrapper.get('[data-testid="vae-tile-size-preference"]').text()).toBe('Auto');
  await input.trigger('focus');
  expect(wrapper.emitted('change')).toBeUndefined();
  await input.setValue('16');
  expect(wrapper.emitted('change')).toEqual([[{ key: 'vaeTileSizePreference', value: 16 }]]);
});

it('copies automatic intent when enabling a target override and removes the whole intent on inheritance', async () => {
  wrapper = mount(ImageBenchmarkParameters, { props: { values: { ...parametersFixture(), vaeTileSize: 16, vaeTileSizePreference: 'auto' }, overrides: {}, disabled: false, bf16RetentionSupported: true } });
  expect(wrapper.get('[data-testid="parameter-vaeTileSize"]').attributes('disabled')).toBeDefined();
  const override = wrapper.get<HTMLInputElement>('[data-testid="override-vaeTileSize"]');
  await override.setValue(true);
  expect(wrapper.emitted('change')).toEqual([[{ key: 'vaeTileSizePreference', value: 'auto' }]]);
  await wrapper.setProps({ overrides: { vaeTileSizePreference: 'auto' } });
  expect(wrapper.get('[data-testid="parameter-vaeTileSize"]').attributes('disabled')).toBeUndefined();
  await override.setValue(false);
  expect(wrapper.emitted('inherit')).toEqual([['vaeTileSizePreference']]);
});

it('keeps a legacy numeric override visibly fixed until inheritance is requested', async () => {
  wrapper = mount(ImageBenchmarkParameters, { props: { values: { ...parametersFixture(), vaeTileSize: 32 }, overrides: { vaeTileSize: 32 }, disabled: false, bf16RetentionSupported: true } });
  expect(wrapper.get('[data-testid="override-vaeTileSize"]').element).toHaveProperty('checked', true);
  expect(wrapper.get('[data-testid="vae-tile-size-preference"]').text()).toBe('Fixed');
  await wrapper.get('[data-testid="override-vaeTileSize"]').setValue(false);
  expect(wrapper.emitted('inherit')).toEqual([['vaeTileSizePreference']]);
});

it.each(['steps', 'guidance'] as const)('uses %s preference rather than materializing an inherited automatic number', async field => {
  const preferenceKey = field === 'steps' ? 'stepsPreference' : 'guidancePreference';
  const value = field === 'steps' ? 6 : 1;
  wrapper = mount(ImageBenchmarkParameters, { props: { values: { ...parametersFixture(), [field]: value, [preferenceKey]: 'auto' }, overrides: {}, disabled: false, bf16RetentionSupported: true, modelFacts: { family: 'minimax-h3-image', variant: 'unknown', evidence: [] } } });
  const input = wrapper.get<HTMLInputElement>(`[data-testid="parameter-${field}"]`);
  expect(input.element.value).toBe(String(value));
  expect(input.attributes('disabled')).toBeDefined();
  await wrapper.get(`[data-testid="override-${field}"]`).setValue(true);
  expect(wrapper.emitted('change')).toEqual([[{ key: preferenceKey, value: 'auto' }]]);
  await wrapper.setProps({ overrides: { [preferenceKey]: 'auto' } });
  await input.setValue(String(value));
  expect(wrapper.emitted('change')?.at(-1)).toEqual([{ key: preferenceKey, value }]);
  await wrapper.get(`[data-testid="override-${field}"]`).setValue(false);
  expect(wrapper.emitted('inherit')).toEqual([[preferenceKey]]);
});

it('labels Qwen Base step 20 as a browser standard and keeps legacy numeric CFG visibly fixed', () => {
  wrapper = mount(ImageBenchmarkParameters, { props: { values: { ...parametersFixture(), stepsPreference: 'auto', guidance: 6 }, overrides: { guidance: 6 }, disabled: false, bf16RetentionSupported: true, modelFacts: { family: 'qwen-image-2.1', variant: 'base', evidence: [] } } });
  expect(wrapper.get('[data-testid="parameter-steps-origin"]').text()).toBe('Naidan standard value');
  expect(wrapper.get('[data-testid="parameter-guidance-preference"]').text()).toBe('Fixed');
  expect(wrapper.get('[data-testid="override-guidance"]').element).toHaveProperty('checked', true);
});

it('projects shared automatic values from browser standards instead of legacy numeric fallbacks', () => {
  wrapper = mount(ImageBenchmarkParameters, { props: { values: { ...parametersFixture(), steps: 8, guidance: 6, stepsPreference: 'auto', guidancePreference: 'auto' }, overrides: undefined, disabled: false, bf16RetentionSupported: true } });
  expect(wrapper.get<HTMLInputElement>('[data-testid="parameter-steps"]').element.value).toBe('20');
  expect(wrapper.get<HTMLInputElement>('[data-testid="parameter-guidance"]').element.value).toBe('7');
});
