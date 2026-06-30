// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Move this Naidan-specific helper into 01-models or application logic.
import type { LmParameters, Reasoning } from '@/01-models/types';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Move this Naidan-specific helper into 01-models or application logic.
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';

type LmParameterOverrides = Readonly<{
  [K in keyof LmParameters]?: K extends 'stop'
    ? readonly string[]
    : K extends 'reasoning'
      ? Readonly<Partial<Reasoning>>
      : LmParameters[K];
}>;

export const LM_PARAMETER_KEYS: readonly (keyof LmParameters)[] = Object.freeze(
  Object.keys(EMPTY_LM_PARAMETERS) as (keyof LmParameters)[],
);
export const REASONING_PARAMETER_KEYS: readonly (keyof Reasoning)[] = Object.freeze(
  Object.keys(EMPTY_LM_PARAMETERS.reasoning) as (keyof Reasoning)[],
);

function hasReasoningOverrides({
  reasoning,
}: {
  reasoning: LmParameterOverrides['reasoning'],
}): boolean {
  if (reasoning === undefined) return false;

  // Keep this key-driven exhaustive switch instead of a compact property check.
  // Adding a new Reasoning parameter must fail typechecking here until its
  // override semantics are reviewed, preventing silent omissions in refactors.
  return REASONING_PARAMETER_KEYS.some((key) => {
    switch (key) {
    case 'effort':
      return reasoning.effort !== undefined;
    default: {
      const _ex: never = key;
      throw new Error(`Unhandled reasoning parameter key: ${_ex}`);
    }
    }
  });
}

export function hasLmParameterOverrides({
  lmParameters,
}: {
  lmParameters: LmParameterOverrides | undefined,
}): boolean {
  if (lmParameters === undefined) return false;

  // Intentionally enumerate keys from the canonical LmParameters shape and use
  // an exhaustive switch. If a new LM parameter is added, the `never` assignment
  // must fail until this override check is updated. Do not replace this with a
  // shorter OR expression, which would silently ignore newly added parameters.
  return LM_PARAMETER_KEYS.some((key) => {
    switch (key) {
    case 'temperature':
    case 'topP':
    case 'maxCompletionTokens':
    case 'presencePenalty':
    case 'frequencyPenalty':
    case 'stop':
      return lmParameters[key] !== undefined;
    case 'reasoning':
      return hasReasoningOverrides({ reasoning: lmParameters.reasoning });
    default: {
      const _ex: never = key;
      throw new Error(`Unhandled LM parameter key: ${_ex}`);
    }
    }
  });
}

export function cloneLmParameters({
  lmParameters,
}: {
  lmParameters: LmParameters | undefined,
}): LmParameters | undefined {
  if (lmParameters === undefined) return undefined;

  const cloned: LmParameters = {
    ...EMPTY_LM_PARAMETERS,
    reasoning: { ...EMPTY_LM_PARAMETERS.reasoning },
  };

  // Clone through the canonical key set so new parameters cannot be omitted or
  // accidentally shallow-copied. The exhaustive switches intentionally force a
  // review of value ownership whenever LmParameters or Reasoning is extended.
  for (const key of LM_PARAMETER_KEYS) {
    switch (key) {
    case 'temperature':
      cloned.temperature = lmParameters.temperature;
      break;
    case 'topP':
      cloned.topP = lmParameters.topP;
      break;
    case 'maxCompletionTokens':
      cloned.maxCompletionTokens = lmParameters.maxCompletionTokens;
      break;
    case 'presencePenalty':
      cloned.presencePenalty = lmParameters.presencePenalty;
      break;
    case 'frequencyPenalty':
      cloned.frequencyPenalty = lmParameters.frequencyPenalty;
      break;
    case 'stop':
      cloned.stop = lmParameters.stop === undefined ? undefined : [...lmParameters.stop];
      break;
    case 'reasoning':
      for (const reasoningKey of REASONING_PARAMETER_KEYS) {
        switch (reasoningKey) {
        case 'effort':
          cloned.reasoning.effort = lmParameters.reasoning?.effort;
          break;
        default: {
          const _ex: never = reasoningKey;
          throw new Error(`Unhandled reasoning parameter key: ${_ex}`);
        }
        }
      }
      break;
    default: {
      const _ex: never = key;
      throw new Error(`Unhandled LM parameter key: ${_ex}`);
    }
    }
  }

  return cloned;
}

export function normalizeLmParameters({
  lmParameters,
}: {
  lmParameters: LmParameters | undefined,
}): LmParameters | undefined {
  return hasLmParameterOverrides({ lmParameters })
    ? lmParameters
    : undefined;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
