import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import OpenSourceLicenseFilter from './OpenSourceLicenseFilter.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('OpenSourceLicenseFilter', () => {
  it('emits typed and cleared values and returns focus to the search input', async () => {
    const wrapper = mount(OpenSourceLicenseFilter, {
      props: { modelValue: '', disabled: false },
      attachTo: document.body,
    });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const input = wrapper.get<HTMLInputElement>('input');
    expect(input.attributes('aria-label')).toBe('Filter licenses');
    expect(wrapper.find('[data-testid="oss-license-filter-clear"]').exists()).toBe(false);

    await input.setValue('MIT');
    expect(wrapper.emitted('update:modelValue')).toEqual([['MIT']]);
    await wrapper.get('[data-testid="oss-license-filter-clear"]').trigger('click');

    expect(wrapper.emitted('update:modelValue')).toEqual([['MIT'], ['']]);
    expect(input.element.value).toBe('');
    expect(document.activeElement).toBe(input.element);
    expect(wrapper.find('[data-testid="oss-license-filter-clear"]').exists()).toBe(false);
  });

  it('keeps both search and clear disabled when unavailable', async () => {
    const wrapper = mount(OpenSourceLicenseFilter, {
      props: { modelValue: 'MIT', disabled: true },
    });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expect(wrapper.get<HTMLInputElement>('input').element.disabled).toBe(true);
    const clear = wrapper.get<HTMLButtonElement>('[data-testid="oss-license-filter-clear"]');
    expect(clear.element.disabled).toBe(true);
    await clear.trigger('click');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });
});
