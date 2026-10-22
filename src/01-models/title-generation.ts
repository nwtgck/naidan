import type { SettingsTitleGeneration } from './types';
import { cloneLmParameters } from '@/utils/lm-parameters';
import { cloneEndpoint } from './endpoint';
import { exactObject } from '@/utils/exact-object';

function cloneTitleModel({ model }: { model: { id: string } }): { id: string } {
  const { id, ...unhandled } = model;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<{ id: string }>()({ id });
}

export function cloneSettingsTitleGeneration({ source }: { source: SettingsTitleGeneration }): SettingsTitleGeneration {
  if (source === 'disabled') {
    return 'disabled';
  }
  const { endpoint, model, lmParameters, ...unhandled } = source;
  unhandled satisfies Record<PropertyKey, never>;
  if (endpoint === 'same_scope') {
    return exactObject<Extract<SettingsTitleGeneration, { endpoint: 'same_scope' }>>()({ endpoint, model: model === 'same_scope' ? model : cloneTitleModel({ model }), lmParameters: lmParameters === 'same_scope' ? lmParameters : cloneLmParameters({ lmParameters })! });
  }
  return exactObject<Exclude<SettingsTitleGeneration, 'disabled' | { endpoint: 'same_scope' }>>()({ endpoint: cloneEndpoint({ endpoint }), model: cloneTitleModel({ model }), lmParameters: cloneLmParameters({ lmParameters })! });
}

/** Retarget automatic setup without resetting an existing user's preferences. */
export function retargetTitleGenerationToSameScope({ source, model }: {
  source: SettingsTitleGeneration,
  model: 'same_scope' | { id: string },
}): SettingsTitleGeneration {
  if (source === 'disabled') {
    return 'disabled';
  }
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
