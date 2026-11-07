import type { ScopedTitleGeneration } from './types';
import { areEndpointsEqual } from './endpoint';
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

/** Compare protected endpoint values rather than their masked JSON representation. */
export function areScopedTitleGenerationsEqual({ left, right }: {
  left: ScopedTitleGeneration | undefined,
  right: ScopedTitleGeneration | undefined,
}): boolean {
  if (left === right) {
    return true;
  }
  if (left === undefined || right === undefined || typeof left === 'string' || typeof right === 'string') {
    return false;
  }
  const { endpoint: leftEndpoint, model: leftModel, lmParameters: leftParameters, ...leftRest } = left;
  const { endpoint: rightEndpoint, model: rightModel, lmParameters: rightParameters, ...rightRest } = right;
  leftRest satisfies Record<PropertyKey, never>;
  rightRest satisfies Record<PropertyKey, never>;
  if (leftModel === 'same_scope' || rightModel === 'same_scope') {
    if (leftModel !== rightModel) {
      return false;
    }
  } else {
    const { id: leftId, ...leftModelRest } = leftModel;
    const { id: rightId, ...rightModelRest } = rightModel;
    leftModelRest satisfies Record<PropertyKey, never>;
    rightModelRest satisfies Record<PropertyKey, never>;
    if (leftId !== rightId) {
      return false;
    }
  }
  // Parameters contain no credentials; preserve the existing field comparison semantics.
  if (JSON.stringify(leftParameters) !== JSON.stringify(rightParameters)) {
    return false;
  }
  return leftEndpoint === 'same_scope' || rightEndpoint === 'same_scope'
    ? leftEndpoint === rightEndpoint
    : areEndpointsEqual({ left: leftEndpoint, right: rightEndpoint });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
