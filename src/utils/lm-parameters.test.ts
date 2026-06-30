import { describe, expect, it } from 'vitest';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Move this Naidan-specific helper into 01-models or application logic.
import type { LmParameters } from '@/01-models/types';
import {
  cloneLmParameters,
  hasLmParameterOverrides,
  LM_PARAMETER_KEYS,
  normalizeLmParameters,
  REASONING_PARAMETER_KEYS,
} from './lm-parameters';

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

describe('LM parameter override detection', () => {
  it('enumerates_the_complete_canonical_parameter_shape', () => {
    expect(LM_PARAMETER_KEYS).toEqual([
      'temperature',
      'topP',
      'maxCompletionTokens',
      'presencePenalty',
      'frequencyPenalty',
      'stop',
      'reasoning',
    ]);
    expect(REASONING_PARAMETER_KEYS).toEqual(['effort']);
  });

  it('clones_nested_parameter_values_without_aliasing', () => {
    const original = {
      ...emptyLmParameters(),
      stop: ['OLD'],
      reasoning: { effort: 'high' as const },
    };
    const cloned = cloneLmParameters({ lmParameters: original });

    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    expect(cloned?.stop).not.toBe(original.stop);
    expect(cloned?.reasoning).not.toBe(original.reasoning);
  });

  it('returns_false_for_empty_parameters', () => {
    expect(hasLmParameterOverrides({ lmParameters: undefined })).toBe(false);
    expect(hasLmParameterOverrides({ lmParameters: emptyLmParameters() })).toBe(false);
  });

  it.each([
    ['temperature', { temperature: 0.5 }],
    ['topP', { topP: 0.9 }],
    ['maxCompletionTokens', { maxCompletionTokens: 100 }],
    ['presencePenalty', { presencePenalty: 0.2 }],
    ['frequencyPenalty', { frequencyPenalty: 0.3 }],
    ['stop', { stop: ['STOP'] }],
  ] as const)('detects_%s_override', (_name, override) => {
    expect(hasLmParameterOverrides({
      lmParameters: {
        ...emptyLmParameters(),
        ...override,
      },
    })).toBe(true);
  });

  it('detects_reasoning_effort_override', () => {
    expect(hasLmParameterOverrides({
      lmParameters: {
        ...emptyLmParameters(),
        reasoning: { effort: 'high' },
      },
    })).toBe(true);
  });

  it('normalizes_only_fully_inherited_parameters', () => {
    expect(normalizeLmParameters({ lmParameters: emptyLmParameters() })).toBeUndefined();

    const overridden = {
      ...emptyLmParameters(),
      temperature: 0.5,
    };
    expect(normalizeLmParameters({ lmParameters: overridden })).toBe(overridden);
  });
});
