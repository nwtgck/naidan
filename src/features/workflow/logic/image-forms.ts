import type { WorkflowImageParameters } from '@/01-models/workflow';
import { lazyStrings } from '@/strings';
import { samplerOptions, schedulerOptions, profileOptions } from '@/features/stable-diffusion-cpp-browser/form-options';

export function workflowImageParameterLabel({ key }: { key: keyof WorkflowImageParameters }): string | undefined {
  switch (key) {
  case 'negativePrompt': return lazyStrings.stableDiffusionCppBrowser__negative_prompt();
  case 'width': return lazyStrings.stableDiffusionCppBrowser__width();
  case 'height': return lazyStrings.stableDiffusionCppBrowser__height();
  case 'steps': return lazyStrings.stableDiffusionCppBrowser__steps();
  case 'guidance': return lazyStrings.stableDiffusionCppBrowser__guidance();
  case 'seed': return lazyStrings.stableDiffusionCppBrowser__seed();
  case 'sampler': return lazyStrings.stableDiffusionCppBrowser__sampler();
  case 'scheduler': return lazyStrings.stableDiffusionCppBrowser__scheduler();
  case 'distilledGuidance': return lazyStrings.stableDiffusionCppBrowser__distilled_guidance();
  case 'vaeTiling': return lazyStrings.stableDiffusionCppBrowser__vae_tiling();
  case 'vaeTileSize': return lazyStrings.stableDiffusionCppBrowser__vae_tile_size();
  case 'flashAttention': return lazyStrings.stableDiffusionCppBrowser__flash_attention();
  case 'bf16WeightType': return lazyStrings.stableDiffusionCppBrowser__bf16_weight_conversion();
  case 'qwenVaePolicy': return lazyStrings.stableDiffusionCppBrowser__qwen_vae_bounded();
  case 'conditioningCacheSize': return lazyStrings.stableDiffusionCppBrowser__conditioning_cache();
  case 'modelArguments': return lazyStrings.stableDiffusionCppBrowser__model_arguments();
  case 'profile': return lazyStrings.stableDiffusionCppBrowser__profile();
  case 'weightResidency': return lazyStrings.stableDiffusionCppBrowser__weight_residency();
  default: {
    const exhaustive: never = key;
    throw new Error(String(exhaustive));
  }
  }
}

export function workflowImageParameterChoices({ key }: { key: keyof WorkflowImageParameters }): readonly string[] {
  switch (key) {
  case 'profile': return ['auto', ...profileOptions];
  case 'sampler': return samplerOptions;
  case 'scheduler': return schedulerOptions;
  case 'bf16WeightType': return ['f32', 'f16'];
  case 'qwenVaePolicy': return ['bounded', 'native'];
  case 'weightResidency': return ['auto', 'cpu', 'hybrid', 'disk', 'runtime'];
  case 'negativePrompt': case 'width': case 'height': case 'steps': case 'guidance': case 'seed': case 'distilledGuidance': case 'vaeTiling': case 'vaeTileSize': case 'flashAttention': case 'conditioningCacheSize': case 'modelArguments': return [];
  default: {
    const exhaustive: never = key;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
