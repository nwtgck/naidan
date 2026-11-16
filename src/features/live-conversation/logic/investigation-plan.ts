import type { SpeechInvestigationOperation, SpeechInvestigationPlan } from '@/features/speech-cpp-browser/investigation/types';
import { exactObject } from '@/utils/exact-object';

/** Keep private bodies and live File/controller objects out of public plan data. */
export function createInvestigationPlan({ operation, trials, tailSeconds }: { operation: SpeechInvestigationOperation, trials: SpeechInvestigationPlan['trials'], tailSeconds: SpeechInvestigationPlan['tailSeconds'] }): SpeechInvestigationPlan {
  const { task, model, source, requested, privateInputs, effective: _effective, processing: _processing, result: _result, measurements: _measurements, failure: _failure, ...unhandled } = operation;
  unhandled satisfies Record<PropertyKey, never>;
  const { persona, instructions, name, ...unhandledPrivate } = privateInputs;
  unhandledPrivate satisfies Record<PropertyKey, never>;
  return exactObject<SpeechInvestigationPlan>()({
    task,
    model,
    source,
    requested,
    tailSeconds,
    privateInputs: { persona: persona === undefined ? 'unset' : 'set', instructions: instructions === undefined ? 'unset' : 'set', name: name === undefined ? 'unset' : 'set' },
    trials,
  });
}

export const TEST_ONLY = {
};
