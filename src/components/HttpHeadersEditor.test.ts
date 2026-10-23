import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import HttpHeadersEditor from './HttpHeadersEditor.vue';

enableAutoUnmount(afterEach);

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('HttpHeadersEditor', () => {
  it('emits immutable input drafts and requests persistence only at the existing boundaries', async () => {
    const original: [string, string][] = [['Authorization', 'Bearer original']];
    const wrapper = mount(HttpHeadersEditor, { props: { modelValue: original, testIdPrefix: 'headers' } });
    await wrapper.get('[data-testid="headers-name-input"]').setValue('X-Key');
    expect(original).toEqual([['Authorization', 'Bearer original']]);
    expect(wrapper.emitted('update:modelValue')).toEqual([[[['X-Key', 'Bearer original']]]]);
    expect(wrapper.emitted('save')).toBeUndefined();
    await wrapper.get('[data-testid="headers-name-input"]').trigger('blur');
    expect(wrapper.emitted('save')).toHaveLength(1);
    await wrapper.get('[data-testid="headers-add-button"]').trigger('click');
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([[['Authorization', 'Bearer original'], ['', '']]]);
    expect(wrapper.emitted('save')).toHaveLength(1);
    await wrapper.get('[data-testid="headers-remove-button"]').trigger('click');
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([[]]);
    expect(wrapper.emitted('save')).toHaveLength(2);
  });

  it('keeps the default name hint and accepts a connection-specific example', async () => {
    const wrapper = mount(HttpHeadersEditor, { props: { modelValue: [['', '']], testIdPrefix: 'headers' } });
    expect(wrapper.get('[data-testid="headers-name-input"]').attributes('placeholder')).toBe('Name');
    await wrapper.setProps({ namePlaceholder: 'e.g. X-API-Key' });
    expect(wrapper.get('[data-testid="headers-name-input"]').attributes('placeholder')).toBe('e.g. X-API-Key');
  });

  it('lets an optional connection form name the editor while keeping the default elsewhere', async () => {
    const wrapper = mount(HttpHeadersEditor, { props: { modelValue: [], testIdPrefix: 'headers' } });
    expect(wrapper.get('button[aria-expanded]').text()).toContain('HTTP headers');
    await wrapper.setProps({ title: 'HTTP headers (optional)' });
    expect(wrapper.get('button[aria-expanded]').text()).toContain('HTTP headers (optional)');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('keeps row inputs while collapsing and does not materialize settings on disclosure', async () => {
    const wrapper = mount(HttpHeadersEditor, { props: { modelValue: [['X-Key', 'draft']], testIdPrefix: 'headers' } });
    const input = wrapper.get('[data-testid="headers-value-input"]').element;
    const disclosure = wrapper.get('button[aria-expanded]');
    await disclosure.trigger('click');
    await disclosure.trigger('click');
    expect(wrapper.get('[data-testid="headers-value-input"]').element).toBe(input);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    expect(wrapper.emitted('save')).toBeUndefined();
  });
});
