import type { PreviewSettings, Parameters } from './types';
import type { ModelCandidate } from './logic/model-candidates';

type Recommendation = {
  id: 'z-image-turbo' | 'qwen-image-2.1';
  title: string;
  summary: string;
  parameters: Partial<Parameters>;
  preview: Pick<PreviewSettings, 'mode' | 'interval' | 'startStep' | 'maxEdge'>;
};

const recommendations: Record<Recommendation['id'], Recommendation> = {
  'z-image-turbo': {
    id: 'z-image-turbo',
    title: 'Z-Image-Turbo',
    summary: 'Fast draft settings for the reviewed Z-Image Turbo recipe.',
    parameters: {
      width: 512,
      height: 512,
      steps: 8,
      guidance: 1,
      sampler: 'auto',
      scheduler: 'auto',
      distilledGuidance: 3.5,
      vaeTiling: true,
      vaeTileSize: 32,
      flashAttention: false,
      qwenVaePolicy: 'bounded',
      conditioningCacheSize: 0,
      modelArguments: '',
    },
    preview: { mode: 'vae', interval: 2, startStep: 4, maxEdge: 512 },
  },
  'qwen-image-2.1': {
    id: 'qwen-image-2.1',
    title: 'Qwen Image 2.1',
    summary: 'Balanced settings for the reviewed Qwen Image 2.1 recipe.',
    parameters: {
      width: 512,
      height: 512,
      steps: 20,
      guidance: 6,
      sampler: 'auto',
      scheduler: 'auto',
      distilledGuidance: 3.5,
      vaeTiling: true,
      vaeTileSize: 32,
      flashAttention: false,
      qwenVaePolicy: 'bounded',
      conditioningCacheSize: 0,
      modelArguments: 'qwen_image_2_1_prefix_cache=false',
    },
    preview: { mode: 'vae', interval: 2, startStep: 8, maxEdge: 512 },
  },
};

export type ImageGenerationRecommendation = Recommendation;

export function recommendationForSelection({ family, turbo }: { family: ModelCandidate['family'], turbo: boolean }): Recommendation | undefined {
  switch (family) {
  case 'z-image': return turbo ? recommendations['z-image-turbo'] : undefined;
  case 'qwen-image-2.1': return recommendations['qwen-image-2.1'];
  case 'sd-checkpoint': case 'flux1': case 'unknown': return undefined;
  default: { const exhaustive: never = family; throw new Error(String(exhaustive)); }
  }
}

export const TEST_ONLY = {
  recommendations,
};
