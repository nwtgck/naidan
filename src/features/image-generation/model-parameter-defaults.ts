import type { ImageModelParameterPreference } from '@/01-models/image-generation';
import { recommendationForSelection, type ImageModelFacts } from '@/features/stable-diffusion-cpp-browser/recommendations';
import { imageRecommendedHint } from './recommended-fields';

export type ImageModelParameterDefault = { value: number, origin: 'recommended' | 'standard' };

export function imageModelParameterDefaults({ model }: { model: ImageModelFacts | undefined }): { steps: ImageModelParameterDefault, guidance: ImageModelParameterDefault } {
  // Qwen's shared architecture cannot distinguish its Base/Turbo sampling
  // contract. Unknown or unrelated variants must not inherit the Base hint.
  const verified = (() => {
    if (!model) {
      return undefined;
    }
    switch (model.family) {
    case 'qwen-image-2.1':
      switch (model.variant) {
      case 'base': case 'turbo': return model;
      case 'unknown': case 'distilled': return undefined;
      default: {
        const exhaustive: never = model.variant;
        throw new Error(String(exhaustive));
      }
      }
    case 'sd-checkpoint': case 'z-image': case 'flux1': case 'flux2-klein-4b': case 'anima': case 'krea2': case 'ernie-image': case 'minimax-h3-image': case 'unknown': return model;
    default: {
      const exhaustive: never = model.family;
      throw new Error(String(exhaustive));
    }
    }
  })();
  const recommendation = recommendationForSelection({ model: verified });
  function fieldDefault({ field, standard }: { field: 'steps' | 'guidance', standard: number }): ImageModelParameterDefault {
    const hint = recommendation && imageRecommendedHint({ recommendation, field });
    const origin = hint?.origin;
    switch (origin) {
    case 'recommended':
      if (typeof hint?.value === 'number') {
        return { value: hint.value, origin: 'recommended' };
      }
      throw new Error('A numeric image parameter recommendation must be a number');
    case 'suggested': case undefined: return { value: standard, origin: 'standard' };
    default: {
      const exhaustive: never = origin;
      throw new Error(String(exhaustive));
    }
    }
  }
  // Preserve the shared form's standards where no reviewed model value exists.
  // Qwen Base's twenty steps are a Naidan standard, not a provider recommendation.
  return { steps: fieldDefault({ field: 'steps', standard: 20 }), guidance: fieldDefault({ field: 'guidance', standard: 7 }) };
}

export function resolveImageModelParameter({ preference, fallback }: { preference: ImageModelParameterPreference, fallback: number }): number {
  if (typeof preference === 'number') {
    return preference;
  }
  switch (preference) {
  case 'auto': return fallback;
  default: {
    const exhaustive: never = preference;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
