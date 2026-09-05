import { describe, expect, it } from 'vitest';
import {
  normalizeTransformersJsProductionModelId,
  selectTransformersJsProductionAutoClass,
  selectTransformersJsProductionRuntimeArtifactLoader,
} from '@/features/transformers-js/production-routing';

describe('Transformers.js production routing', () => {
  it('normalizes supported Hugging Face model ID forms without changing a plain ID', () => {
    expect(normalizeTransformersJsProductionModelId({ modelId: 'hf.co/org/model' })).toBe('org/model');
    expect(normalizeTransformersJsProductionModelId({ modelId: 'https://huggingface.co/org/model' })).toBe('org/model');
    expect(normalizeTransformersJsProductionModelId({ modelId: 'org/model' })).toBe('org/model');
  });

  it('uses image-text-to-text only for the Gemma 4 production route', () => {
    expect(selectTransformersJsProductionAutoClass({ modelId: 'onnx-community/gemma-4-E2B-it-ONNX' }))
      .toBe('AutoModelForImageTextToText');
    expect(selectTransformersJsProductionAutoClass({ modelId: 'Qwen/Qwen3.5-2B-ONNX' }))
      .toBe('AutoModelForCausalLM');
    expect(selectTransformersJsProductionAutoClass({ modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct' }))
      .toBe('AutoModelForCausalLM');
  });

  it('selects the same Production tokenizer or processor route from model ID and model type', () => {
    expect(selectTransformersJsProductionRuntimeArtifactLoader({
      modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
      modelType: undefined,
    })).toBe('gemma4-processor');
    expect(selectTransformersJsProductionRuntimeArtifactLoader({
      modelId: 'org/custom-qwen',
      modelType: 'qwen3_5_text',
    })).toBe('qwen3_5-processor');
    expect(selectTransformersJsProductionRuntimeArtifactLoader({
      modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct',
      modelType: 'llama',
    })).toBe('tokenizer');
  });

});
