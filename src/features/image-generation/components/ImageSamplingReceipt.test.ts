import { afterEach, beforeEach, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ImageSamplingReceipt from './ImageSamplingReceipt.vue';

let wrapper: VueWrapper | undefined;

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

it('does not claim a resolved setting for old or unreported outputs', () => {
  wrapper = mount(ImageSamplingReceipt, { props: { sampling: undefined } });
  expect(wrapper.find('[data-testid="image-sampling-receipt"]').exists()).toBe(false);
});

it('shows reported names outside the editable enum without changing them', () => {
  wrapper = mount(ImageSamplingReceipt, { props: { sampling: { sampler: { id: 17, name: 'native-method' }, scheduler: { id: 8, name: 'flux' } } } });
  expect(wrapper.get('[data-testid="image-sampling-sampler"]').text()).toBe('native-method');
  expect(wrapper.get('[data-testid="image-sampling-scheduler"]').text()).toBe('flux');
  expect(wrapper.text()).toContain('Used for generation');
});

it('keeps absent names visibly unreported instead of substituting an editor choice', () => {
  wrapper = mount(ImageSamplingReceipt, { props: { sampling: { sampler: { id: 17 }, scheduler: { id: 8, name: 'flux' } } } });
  expect(wrapper.get('[data-testid="image-sampling-sampler"]').text()).toBe('Name not reported');
  expect(wrapper.get('[data-testid="image-sampling-scheduler"]').text()).toBe('flux');
});
