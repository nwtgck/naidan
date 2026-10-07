import type { ImageGenerationRecommendation } from '@/features/stable-diffusion-cpp-browser/recommendations';
import type { Parameters } from '@/features/stable-diffusion-cpp-browser/types';

export type ImageRecommendedField = keyof ImageGenerationRecommendation['parameters'];
export type ImageRecommendedHint = { value: Parameters[ImageRecommendedField], origin: 'recommended' | 'suggested', range: { minimum: number, maximum: number } | undefined };

/** Passive presentation of the same values used by the existing preset action. */
export function imageRecommendedHint({ recommendation, field }: { recommendation: ImageGenerationRecommendation, field: ImageRecommendedField }): ImageRecommendedHint {
  const range = (() => {
    switch (field) {
    case 'steps': return recommendation.stepRange;
    case 'width': case 'height': case 'guidance': case 'sampler': case 'scheduler': case 'distilledGuidance': case 'vaeTiling': case 'vaeTileSize': case 'flashAttention': case 'bf16WeightType': case 'qwenVaePolicy': case 'conditioningCacheSize': case 'modelArguments': return undefined;
    default: { const exhaustive: never = field; throw new Error(String(exhaustive)); }
    }
  })();
  return {
    value: recommendation.parameters[field],
    origin: recommendation.recommendedFields?.includes(field) ? 'recommended' : 'suggested',
    range,
  };
}
export function differsFromImageRecommendation({ current, hint }: { current: unknown, hint: ImageRecommendedHint }): boolean {
  if (hint.range && typeof current === 'number' && Number.isFinite(current)) return current < hint.range.minimum || current > hint.range.maximum;
  return current !== hint.value;
}
export function applyImageRecommendedField({ parameters, recommendation, field }: { parameters: Parameters, recommendation: ImageGenerationRecommendation, field: ImageRecommendedField }): Parameters {
  // Explicitly update one field; a tile size action never enables tiling, etc.
  return { ...parameters, [field]: recommendation.parameters[field] };
}
export const TEST_ONLY = {
};
