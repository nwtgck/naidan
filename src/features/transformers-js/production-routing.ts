import { isGemma4Model } from '@/features/transformers-js/models/gemma4';
import { isQwen3_5Model } from '@/features/transformers-js/models/qwen3_5';
import type {
  TransformersJsProductionInvestigationAutoClass,
  TransformersJsProductionInvestigationProcessor,
} from '@/features/transformers-js/types';

export function normalizeTransformersJsProductionModelId({ modelId }: { modelId: string }): string {
  if (modelId.startsWith('hf.co/')) return modelId.substring(6);
  if (modelId.startsWith('https://huggingface.co/')) return modelId.substring(23);
  return modelId;
}

export function selectTransformersJsProductionAutoClass({ modelId }: {
  modelId: string,
}): TransformersJsProductionInvestigationAutoClass {
  return isGemma4Model({ modelType: undefined, activeModelId: modelId })
    ? 'AutoModelForImageTextToText'
    : 'AutoModelForCausalLM';
}

export function selectTransformersJsProductionRuntimeArtifactLoader({
  modelId,
  modelType,
}: {
  modelId: string,
  modelType: string | undefined,
}): TransformersJsProductionInvestigationProcessor {
  if (isGemma4Model({ modelType, activeModelId: modelId })) return 'gemma4-processor';
  if (isQwen3_5Model({ modelType, activeModelId: modelId })) return 'qwen3_5-processor';
  return 'tokenizer';
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
