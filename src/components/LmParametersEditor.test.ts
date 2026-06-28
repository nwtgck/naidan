import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import LmParametersEditor from './LmParametersEditor.vue';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import type { LmParameters } from '@/models/types';

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
