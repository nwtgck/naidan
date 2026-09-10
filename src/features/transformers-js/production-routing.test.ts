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

  it('uses multimodal config identity rather than the Qwen repository spelling', () => {
    expect(selectTransformersJsProductionAutoClass({ modelId: 'onnx-community/gemma-4-E2B-it-ONNX', modelType: 'gemma4' }))
      .toBe('AutoModelForImageTextToText');
    expect(selectTransformersJsProductionAutoClass({ modelId: 'org/custom-model', modelType: 'qwen3_5' }))
      .toBe('AutoModelForImageTextToText');
    expect(selectTransformersJsProductionAutoClass({ modelId: 'org/custom-moe', modelType: 'qwen3_5_moe' }))
      .toBe('AutoModelForImageTextToText');
    expect(selectTransformersJsProductionAutoClass({ modelId: 'Qwen/Qwen3.5-2B-ONNX', modelType: 'qwen3_5_text' }))
      .toBe('AutoModelForCausalLM');
    expect(selectTransformersJsProductionAutoClass({ modelId: 'Qwen/Qwen3.5-2B-ONNX', modelType: undefined }))
      .toBe('AutoModelForCausalLM');
    expect(selectTransformersJsProductionAutoClass({ modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct', modelType: 'llama' }))
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
