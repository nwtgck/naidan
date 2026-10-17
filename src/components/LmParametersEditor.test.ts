import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import LmParametersEditor from './LmParametersEditor.vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { LmParameters } from '@/01-models/types';

function emptyLmParameters(): LmParameters {
  return {
    temperature: undefined,
    topP: undefined,
    maxCompletionTokens: undefined,
    presencePenalty: undefined,
    frequencyPenalty: undefined,
    stop: undefined,
    reasoning: { effort: undefined },
  };
}

describe('LmParametersEditor', () => {
  it('keeps the inheritance explanation separate from short numeric placeholders', async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    using testCase = {
      wrapper: mount(LmParametersEditor, {
        props: {
          modelValue: emptyLmParameters(),
          inheritanceLabel: 'Inherit',
          inheritanceHint: 'Unset fields use parent settings',
        },
      }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    const { wrapper } = testCase;

    expect(wrapper.get('[data-testid="lm-parameters-inheritance-hint"]').text()).toBe('Unset fields use parent settings');
    const numericInputs = wrapper.findAll('input[type="number"]');
    expect(numericInputs).toHaveLength(4);
    expect(numericInputs.map(input => input.attributes('placeholder'))).toEqual(Array(4).fill('Inherit'));
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('preserves label-only callers and provider-default fallbacks', async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    using testCase = {
      wrapper: mount(LmParametersEditor, {
        props: { modelValue: emptyLmParameters(), inheritanceLabel: 'Inherit' },
      }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    const { wrapper } = testCase;
    const hint = () => wrapper.get('[data-testid="lm-parameters-inheritance-hint"]').text();
    const placeholders = () => wrapper.findAll('input[type="number"]').map(input => input.attributes('placeholder'));

    expect(hint()).toBe('Inherit');
    expect(placeholders()).toEqual(Array(4).fill('Inherit'));
    await wrapper.setProps({ inheritanceLabel: undefined });
    expect(hint()).toBe('Empty fields use provider defaults');
    expect(placeholders()).toEqual(Array(4).fill('Default'));
    await wrapper.setProps({ inheritanceHint: 'Unset fields use parent settings' });
    expect(hint()).toBe('Unset fields use parent settings');
    expect(placeholders()).toEqual(Array(4).fill('Default'));
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('does not treat an empty reasoning object as an override', async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    const wrapper = mount(LmParametersEditor, {
      props: { modelValue: emptyLmParameters() },
    });

    expect(wrapper.text()).not.toContain('Reset All');

    await wrapper.setProps({
      modelValue: {
        ...emptyLmParameters(),
        temperature: 0.7,
      },
    });

    expect(wrapper.text()).toContain('Reset All');
  });
});
