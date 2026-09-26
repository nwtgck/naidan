import type { PreviewSettings, Parameters } from './types';
import type { ModelCandidate } from './logic/model-candidates';
export type ImageModelFacts = Pick<ModelCandidate, 'family' | 'variant' | 'evidence'>;
export type ImageGenerationRecommendation = {
  id: 'z-image-turbo' | 'z-image-base' | 'qwen-image-2.1';
  title: string;
  parameters: Omit<Parameters, 'prompt' | 'negativePrompt' | 'seed'>;
  preview: Pick<PreviewSettings, 'mode' | 'interval' | 'startStep' | 'maxEdge'>;
  sources: readonly { label: string, url: string }[];
  checkedAt: string;
};
const upstream = 'https://github.com/leejet/stable-diffusion.cpp/blob/88411ef1e0688ff2df1010aeeb5d92b2d8cea2be';
const zSource = { label: 'stable-diffusion.cpp · Z-Image', url: `${upstream}/docs/z_image.md` };
// Browser defaults are explicitly identified as Naidan policy in the UI. They
// are NOT claimed as provider recommendations: 512px, tiling, cache, preview
// start/interval/size and disabling the Qwen prefix cache for this backend.
const browserDefaults: ImageGenerationRecommendation['parameters'] = {
  width: 512, height: 512, steps: 20, guidance: 6, sampler: 'auto', scheduler: 'auto',
  distilledGuidance: 3.5, vaeTiling: true, vaeTileSize: 32, flashAttention: false,
  qwenVaePolicy: 'bounded', conditioningCacheSize: 0, modelArguments: '',
};
const presets = {
  'z-image-turbo': {
    id: 'z-image-turbo', title: 'Z-Image-Turbo', checkedAt: '2026-09-26',
    // sd.cpp's eight steps / CFG 1 are not Diffusers' nine / CFG 0 API values.
    parameters: { ...browserDefaults, steps: 8, guidance: 1 },
    preview: { mode: 'vae', interval: 2, startStep: 4, maxEdge: 256 },
    sources: [zSource, { label: 'Tongyi-MAI · Z-Image-Turbo', url: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo' }],
  },
  'z-image-base': {
    id: 'z-image-base', title: 'Z-Image Base', checkedAt: '2026-09-26',
    parameters: { ...browserDefaults, steps: 50, guidance: 5 },
    preview: { mode: 'vae', interval: 5, startStep: 10, maxEdge: 256 },
    sources: [zSource, { label: 'Tongyi-MAI · Z-Image', url: 'https://huggingface.co/Tongyi-MAI/Z-Image' }],
  },
  'qwen-image-2.1': {
    id: 'qwen-image-2.1', title: 'Qwen Image 2.1', checkedAt: '2026-09-26',
    // Upstream example specifies CFG 6 and Euler, not a recommended step count.
    // Twenty steps here remain an explicit Naidan starting point.
    parameters: { ...browserDefaults, sampler: 'euler', modelArguments: 'qwen_image_2_1_prefix_cache=false' },
    preview: { mode: 'vae', interval: 2, startStep: 8, maxEdge: 256 },
    sources: [{ label: 'stable-diffusion.cpp · Qwen Image 2.1', url: `${upstream}/docs/qwen_image_2.1.md` }],
  },
} as const satisfies Record<ImageGenerationRecommendation['id'], ImageGenerationRecommendation>;

/** Tensor structure identifies a family; only metadata/receipts select variants.
 * Unknown families and unlabelled Z-Image variants have no guessed preset. */
export function recommendationForSelection({ model }: { model: ImageModelFacts | undefined }): ImageGenerationRecommendation | undefined {
  if (!model) return undefined;
  switch (model.family) {
  case 'z-image':
    switch (model.variant) {
    case 'turbo': return presets['z-image-turbo'];
    case 'base': return presets['z-image-base'];
    case 'unknown': return undefined;
    default: { const exhaustive: never = model.variant; throw new Error(String(exhaustive)); }
    }
  case 'qwen-image-2.1': return presets['qwen-image-2.1'];
  case 'sd-checkpoint': case 'flux1': case 'unknown': return undefined;
  default: { const exhaustive: never = model.family; throw new Error(String(exhaustive)); }
  }
}
export const TEST_ONLY = {
  presets,
};
