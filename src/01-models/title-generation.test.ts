import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, EMPTY_LM_PARAMETERS, type SettingsTitleGeneration } from './types';
import { retargetTitleGenerationToSameScope } from './title-generation';

describe('new title defaults versus existing preferences', () => {
  it('only gives fresh settings a thinking-off default', () => {
    expect(DEFAULT_SETTINGS.titleGeneration).toMatchObject({ lmParameters: { reasoning: { effort: 'none' } } });
    expect(EMPTY_LM_PARAMETERS.reasoning.effort).toBeUndefined();
    expect(retargetTitleGenerationToSameScope({ source: DEFAULT_SETTINGS.titleGeneration, model: 'same_scope' }))
      .toMatchObject({ lmParameters: { reasoning: { effort: 'none' } } });
  });

  it.each([undefined, 'none', 'low', 'medium', 'high'] as const)('preserves saved reasoning %s during automatic setup', effort => {
    const source: SettingsTitleGeneration = {
      endpoint: { type: 'openai', url: 'https://example.test' }, model: { id: 'old' },
      lmParameters: { ...EMPTY_LM_PARAMETERS, temperature: 0.4, stop: ['end'], reasoning: { effort } },
    };
    const result = retargetTitleGenerationToSameScope({ source, model: { id: 'new' } });
    expect(result).toEqual({ endpoint: 'same_scope', model: { id: 'new' }, lmParameters: source.lmParameters });
    if (result === 'disabled' || result.lmParameters === 'same_scope') throw new Error('Expected explicit parameters');
    result.lmParameters.reasoning.effort = 'high';
    result.lmParameters.stop?.push('another');
    expect(source.lmParameters.reasoning.effort).toBe(effort);
    expect(source.lmParameters.stop).toEqual(['end']);
  });

  it('preserves explicit same-scope inheritance and disabled titles', () => {
    const source: SettingsTitleGeneration = { endpoint: 'same_scope', model: 'same_scope', lmParameters: 'same_scope' };
    expect(retargetTitleGenerationToSameScope({ source, model: 'same_scope' })).toEqual(source);
    expect(retargetTitleGenerationToSameScope({ source: 'disabled', model: 'same_scope' })).toBe('disabled');
  });
});
