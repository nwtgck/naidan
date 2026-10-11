import type { PreviewSettings, Parameters } from './types';
import type { ModelCandidate } from './logic/model-candidates';
export type ImageModelFacts = Pick<ModelCandidate, 'family' | 'variant' | 'evidence'>;
export type ImageGenerationRecommendation = {
  id: 'z-image-turbo' | 'z-image-base' | 'qwen-image-2.1' | 'qwen-image-2.1-turbo' | 'flux2-klein-4b' | 'anima-turbo-1.1' | 'krea2-turbo' | 'ernie-image-turbo';
  title: string;
  parameters: Omit<Parameters, 'prompt' | 'negativePrompt' | 'seed'>;
  preview: Pick<PreviewSettings, 'mode' | 'interval' | 'startStep' | 'maxEdge'>;
  sources: readonly { label: string, url: string }[];
  checkedAt: string;
  recommendedFields?: readonly (keyof ImageGenerationRecommendation['parameters'])[];
  // For an incomplete inference preset, expose and apply only validated fields.
  // In particular, Turbo's custom sigma schedule is not yet supported.
  recommendedFieldsOnly?: boolean;
  stepRange?: { minimum: number, maximum: number };
};
const upstream = 'https://github.com/leejet/stable-diffusion.cpp/blob/88411ef1e0688ff2df1010aeeb5d92b2d8cea2be';
const zSource = { label: 'stable-diffusion.cpp · Z-Image', url: `${upstream}/docs/z_image.md` };
// Browser defaults are explicitly identified as Naidan policy in the UI. They
// are NOT claimed as provider recommendations: 512px, tiling, cache, preview
// start/interval/size and disabling the Qwen prefix cache for this backend.
const browserDefaults: ImageGenerationRecommendation['parameters'] = {
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
  bf16WeightType: 'f32',
  qwenVaePolicy: 'bounded',
  conditioningCacheSize: 0,
  modelArguments: '',
};
const presets = {
  'z-image-turbo': {
    recommendedFields: ['steps', 'guidance'],
    id: 'z-image-turbo',
    title: 'Z-Image-Turbo',
    checkedAt: '2026-09-26',
    // sd.cpp's eight steps / CFG 1 are not Diffusers' nine / CFG 0 API values.
    parameters: { ...browserDefaults, steps: 8, guidance: 1 },
    preview: { mode: 'vae', interval: 2, startStep: 4, maxEdge: 256 },
    sources: [zSource, { label: 'Tongyi-MAI · Z-Image-Turbo', url: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo' }],
  },
  'z-image-base': {
    recommendedFields: ['steps', 'guidance'],
    id: 'z-image-base',
    title: 'Z-Image Base',
    checkedAt: '2026-09-26',
    parameters: { ...browserDefaults, steps: 50, guidance: 5 },
    preview: { mode: 'vae', interval: 5, startStep: 10, maxEdge: 256 },
    sources: [zSource, { label: 'Tongyi-MAI · Z-Image', url: 'https://huggingface.co/Tongyi-MAI/Z-Image' }],
  },
  'qwen-image-2.1': {
    recommendedFields: ['guidance', 'sampler'],
    id: 'qwen-image-2.1',
    title: 'Qwen Image 2.1',
    checkedAt: '2026-09-26',
    // Upstream example specifies CFG 6 and Euler, not a recommended step count.
    // Twenty steps here remain an explicit Naidan starting point.
    parameters: { ...browserDefaults, sampler: 'euler', modelArguments: 'qwen_image_2_1_prefix_cache=false' },
    preview: { mode: 'vae', interval: 2, startStep: 8, maxEdge: 256 },
    sources: [{ label: 'stable-diffusion.cpp · Qwen Image 2.1', url: `${upstream}/docs/qwen_image_2.1.md` }],
  },
  'qwen-image-2.1-turbo': {
    id: 'qwen-image-2.1-turbo',
    title: 'Qwen Image 2.1 Turbo',
    checkedAt: '2026-10-11',
    // These three values are useful for testing, but the custom sigma schedule
    // is not yet exposed by Naidan. Do not advertise/apply the other sampling
    // defaults as a complete Turbo preset.
    recommendedFieldsOnly: true,
    recommendedFields: ['width', 'height', 'guidance'],
    parameters: { ...browserDefaults, width: 1024, height: 1024, guidance: 1 },
    preview: { mode: 'vae', interval: 2, startStep: 8, maxEdge: 256 },
    sources: [{ label: 'Qwen · Qwen Image 2.1 Turbo', url: 'https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo' }],
  },
  'flux2-klein-4b': {
    recommendedFields: ['steps', 'guidance', 'sampler'],
    id: 'flux2-klein-4b',
    title: 'FLUX.2 [klein] 4B Distilled',
    checkedAt: '2026-09-27',
    // Four steps apply to the distilled release, not Klein Base with the same
    // tensor architecture. Only a reviewed release receipt enables this preset.
    parameters: { ...browserDefaults, steps: 4, guidance: 1, sampler: 'euler' },
    preview: { mode: 'vae', interval: 1, startStep: 2, maxEdge: 256 },
    sources: [{ label: 'stable-diffusion.cpp · FLUX.2', url: `${upstream}/docs/flux2.md` }],
  },
  'anima-turbo-1.1': {
    recommendedFields: ['steps', 'guidance'],
    stepRange: { minimum: 8, maximum: 12 },
    id: 'anima-turbo-1.1',
    title: 'Anima Turbo 1.1',
    checkedAt: '2026-09-27',
    // The publisher recommends 8–12 steps / CFG 1 for Turbo, not Base/Aesthetic.
    parameters: { ...browserDefaults, steps: 10, guidance: 1, sampler: 'euler' },
    preview: { mode: 'vae', interval: 2, startStep: 4, maxEdge: 256 },
    sources: [{ label: 'CircleStone Labs · Anima', url: 'https://huggingface.co/circlestone-labs/Anima' },
      { label: 'stable-diffusion.cpp · Anima', url: `${upstream}/docs/anima.md` }],
  },
  'krea2-turbo': {
    recommendedFields: ['steps', 'guidance'],
    id: 'krea2-turbo',
    title: 'Krea 2 Turbo',
    checkedAt: '2026-09-27',
    // The official API's guidance=0 disables CFG. sd.cpp uses CFG 1 for that
    // behavior; CFG 0 there produces unconditioned output instead.
    parameters: { ...browserDefaults, steps: 8, guidance: 1, sampler: 'euler' },
    preview: { mode: 'vae', interval: 2, startStep: 4, maxEdge: 256 },
    sources: [{ label: 'Krea · Krea 2 Turbo', url: 'https://huggingface.co/krea/Krea-2-Turbo' },
      { label: 'stable-diffusion.cpp · Krea2', url: `${upstream}/docs/krea2.md` }],
  },
  'ernie-image-turbo': {
    recommendedFields: ['steps', 'guidance'],
    id: 'ernie-image-turbo',
    title: 'ERNIE-Image-Turbo',
    checkedAt: '2026-09-27',
    parameters: { ...browserDefaults, steps: 8, guidance: 1 },
    preview: { mode: 'vae', interval: 2, startStep: 4, maxEdge: 256 },
    sources: [{ label: 'stable-diffusion.cpp · ERNIE-Image', url: `${upstream}/docs/ernie_image.md` }],
  },
} as const satisfies Record<ImageGenerationRecommendation['id'], ImageGenerationRecommendation>;

/** Tensor structure identifies a family; only metadata/receipts select variants.
 * Unlabelled training variants have no guessed distilled/Turbo preset. */
export function recommendationForSelection({ model }: { model: ImageModelFacts | undefined }): ImageGenerationRecommendation | undefined {
  if (!model) return undefined;
  switch (model.family) {
  case 'z-image':
    switch (model.variant) {
    case 'turbo': return presets['z-image-turbo'];
    case 'base': return presets['z-image-base'];
    case 'distilled': case 'unknown': return undefined;
    default: { const exhaustive: never = model.variant; throw new Error(String(exhaustive)); }
    }
  // Turbo and Base share the same tensor shape; provenance distinguishes them.
  // The Turbo entry is deliberately partial until custom sigmas are supported.
  case 'qwen-image-2.1':
    switch (model.variant) {
    case 'turbo': return presets['qwen-image-2.1-turbo'];
    case 'base': case 'distilled': case 'unknown': return presets['qwen-image-2.1'];
    default: { const exhaustive: never = model.variant; throw new Error(String(exhaustive)); }
    }
  case 'flux2-klein-4b':
    switch (model.variant) {
    case 'distilled': return presets['flux2-klein-4b'];
    case 'turbo': case 'base': case 'unknown': return undefined;
    default: { const exhaustive: never = model.variant; throw new Error(String(exhaustive)); }
    }
  case 'anima':
    switch (model.variant) {
    case 'turbo': return presets['anima-turbo-1.1'];
    case 'distilled': case 'base': case 'unknown': return undefined;
    default: { const exhaustive: never = model.variant; throw new Error(String(exhaustive)); }
    }
  case 'krea2':
    switch (model.variant) {
    case 'turbo': return presets['krea2-turbo'];
    case 'distilled': case 'base': case 'unknown': return undefined;
    default: { const exhaustive: never = model.variant; throw new Error(String(exhaustive)); }
    }
  case 'ernie-image':
    switch (model.variant) {
    case 'turbo': return presets['ernie-image-turbo'];
    case 'distilled': case 'base': case 'unknown': return undefined;
    default: { const exhaustive: never = model.variant; throw new Error(String(exhaustive)); }
    }
  case 'sd-checkpoint': case 'flux1': case 'unknown': return undefined;
  default: { const exhaustive: never = model.family; throw new Error(String(exhaustive)); }
  }
}

export const TEST_ONLY = {
  presets,
};
