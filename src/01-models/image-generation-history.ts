import type { BinaryObjectId, HostModelDirectoryId, ImageGenerationId } from './ids';

/** Shared by the image workspace and its public persistence service. */
export type ImageGenerationModelFile = {
  name: string,
  size: number,
  lastModified: number,
} & (
  | { type: 'opfs', path: string }
  | { type: 'host', directoryId: HostModelDirectoryId, path: string }
  | { type: 'file' }
);

export type ImageGenerationParameters = {
  prompt: string,
  negativePrompt: string,
  width: number,
  height: number,
  steps: number,
  guidance: number,
  seed: string,
  sampler: 'auto' | 'euler' | 'euler_a' | 'heun' | 'dpm2' | 'dpm++2m' | 'lcm',
  scheduler: 'auto' | 'discrete' | 'karras' | 'exponential' | 'simple' | 'sgm_uniform',
  distilledGuidance: number,
  vaeTiling: boolean,
  vaeTileSize: number,
  flashAttention: boolean,
  bf16WeightType: 'f32' | 'f16',
  qwenVaePolicy: 'bounded' | 'native',
  conditioningCacheSize: number,
  modelArguments: string,
};

export type ImageGenerationImage = {
  binaryObjectId: BinaryObjectId,
  name: string,
};

export type ImageGenerationRecord = {
  id: ImageGenerationId,
  createdAt: number,
  request: {
    parameters: ImageGenerationParameters,
    models: {
      slot: 'model' | 'diffusion' | 'vae' | 'clipL' | 'clipG' | 't5' | 'lm',
      path: string,
      file: ImageGenerationModelFile,
      companions: { path: string, file: ImageGenerationModelFile }[],
    }[],
    loras: { path: string, file: ImageGenerationModelFile, strength: number }[],
    imageInputs: {
      initImage: ImageGenerationImage | undefined,
      strength: number,
      referenceImages: ImageGenerationImage[],
    },
    preview: {
      enabled: boolean,
      interval: number,
      startStep: number,
      mode: 'projection' | 'vae',
      maxEdge: number,
    },
    runtime: {
      sourceCommit: string,
      profile: 'webgpu-wasm32-asyncify' | 'webgpu-wasm32-jspi' | 'webgpu-wasm64-jspi',
      weightResidency: 'auto' | 'cpu' | 'hybrid' | 'disk' | 'runtime',
      gpuBudgetMiB: number | undefined,
    },
  },
  result: {
    binaryObjectId: BinaryObjectId,
    width: number,
    height: number,
    modelVersion: string,
    uniformOutput: boolean,
    elapsedMs: number,
  },
  previews: {
    binaryObjectId: BinaryObjectId,
    step: number,
    steps: number,
    mode: 'projection' | 'vae',
    width: number,
    height: number,
  }[],
};

export type ImageGenerationSummary = {
  id: ImageGenerationId,
  createdAt: number,
  prompt: string,
  modelName: string,
  binaryObjectId: BinaryObjectId,
  width: number,
  height: number,
  previewCount: number,
};

export type ImageGenerationHistoryQuery = {
  text: string,
  offset: number,
  limit: number,
};

export type ImageGenerationHistoryPage = {
  items: ImageGenerationSummary[],
  total: number,
  warnings: { path: string, message: string }[],
  warningCount: number,
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
