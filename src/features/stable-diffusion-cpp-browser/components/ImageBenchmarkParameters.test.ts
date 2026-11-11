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
