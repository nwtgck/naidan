import type { SettingsTitleGeneration } from './types';
import { cloneLmParameters } from '@/utils/lm-parameters';

/** Retarget automatic setup without resetting an existing user's preferences. */
export function retargetTitleGenerationToSameScope({ source, model }: {
  source: SettingsTitleGeneration,
  model: 'same_scope' | { id: string },
}): SettingsTitleGeneration {
  if (source === 'disabled') return 'disabled';
  const { endpoint: _endpoint, model: _model, lmParameters, ...unhandled } = source;
  unhandled satisfies Record<PropertyKey, never>;
  return {
    endpoint: 'same_scope',
    model: model === 'same_scope' ? model : { id: model.id },
    lmParameters: lmParameters === 'same_scope'
      ? 'same_scope'
      : cloneLmParameters({ lmParameters })!,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
