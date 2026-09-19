import { describe, expect, it } from 'vitest';
import { resolveGenerationBudget } from './generation-budget';

function tensorLike({ sequenceLength }: { sequenceLength: number }) {
  return { dims: [1, sequenceLength] };
}

describe('resolveGenerationBudget', () => {
  it('uses all remaining decoder-only model context when no completion limit is specified', () => {
    expect(resolveGenerationBudget({
      modelConfig: { max_position_embeddings: 128_000, is_encoder_decoder: false },
      inputs: { input_ids: tensorLike({ sequenceLength: 2_048 }) },
      pastKeyValues: null,
      maxCompletionTokens: undefined,
    })).toEqual({
      maxNewTokens: 125_952,
      source: 'model-context',
      contextLimit: 128_000,
      promptTokenCount: 2_048,
      pastTokenCount: 0,
      usedContextTokenCount: 2_048,
    });
  });

  it('subtracts an existing generation cache from the remaining model context', () => {
    expect(resolveGenerationBudget({
      modelConfig: { max_position_embeddings: 32_768, is_encoder_decoder: false },
      inputs: { input_ids: tensorLike({ sequenceLength: 512 }) },
      pastKeyValues: { get_seq_length: () => 10_000 },
      maxCompletionTokens: undefined,
    }).maxNewTokens).toBe(22_256);
  });



  it('does not double-count a cached prefix when full decoder-only input_ids include that prefix', () => {
    expect(resolveGenerationBudget({
      modelConfig: { max_position_embeddings: 32_768, is_encoder_decoder: false },
      inputs: {
        input_ids: tensorLike({ sequenceLength: 10_512 }),
        attention_mask: tensorLike({ sequenceLength: 10_512 }),
      },
      pastKeyValues: { get_seq_length: () => 10_000 },
      maxCompletionTokens: undefined,
    })).toMatchObject({
      maxNewTokens: 22_256,
      promptTokenCount: 10_512,
      pastTokenCount: 10_000,
      usedContextTokenCount: 10_512,
    });
  });

  it('counts cached context plus suffix-only decoder input_ids', () => {
    expect(resolveGenerationBudget({
      modelConfig: { max_position_embeddings: 32_768, is_encoder_decoder: false },
      inputs: {
        input_ids: tensorLike({ sequenceLength: 512 }),
        attention_mask: tensorLike({ sequenceLength: 512 }),
      },
      pastKeyValues: { get_seq_length: () => 10_000 },
      maxCompletionTokens: undefined,
    })).toMatchObject({
      maxNewTokens: 22_256,
      promptTokenCount: 512,
      pastTokenCount: 10_000,
      usedContextTokenCount: 10_512,
    });
  });

  it('uses an expanded attention mask as the occupied context for cached decoder-only inputs', () => {
    expect(resolveGenerationBudget({
      modelConfig: { max_position_embeddings: 32_768, is_encoder_decoder: false },
      inputs: {
        input_ids: tensorLike({ sequenceLength: 512 }),
        attention_mask: tensorLike({ sequenceLength: 10_512 }),
      },
      pastKeyValues: { get_seq_length: () => 10_000 },
      maxCompletionTokens: undefined,
    })).toMatchObject({
      maxNewTokens: 22_256,
      usedContextTokenCount: 10_512,
    });
  });

  it('clamps an explicit completion limit to the remaining model context', () => {
    expect(resolveGenerationBudget({
      modelConfig: { max_position_embeddings: 4_096, is_encoder_decoder: false },
      inputs: { input_ids: tensorLike({ sequenceLength: 3_000 }) },
      pastKeyValues: null,
      maxCompletionTokens: 8_192,
    })).toMatchObject({
      maxNewTokens: 1_096,
      source: 'explicit',
    });
  });

  it('preserves an explicit completion limit when model context is unavailable', () => {
    expect(resolveGenerationBudget({
      modelConfig: { model_type: 'unknown' },
      inputs: { input_ids: tensorLike({ sequenceLength: 100 }) },
      pastKeyValues: null,
      maxCompletionTokens: 2_048,
    })).toMatchObject({
      maxNewTokens: 2_048,
      source: 'explicit',
      contextLimit: undefined,
    });
  });

  it('defers to Transformers.js when neither an explicit limit nor model context is available', () => {
    expect(resolveGenerationBudget({
      modelConfig: { model_type: 'unknown' },
      inputs: { input_ids: tensorLike({ sequenceLength: 100 }) },
      pastKeyValues: null,
      maxCompletionTokens: undefined,
    })).toEqual({
      maxNewTokens: undefined,
      source: 'transformers-default',
      contextLimit: undefined,
      promptTokenCount: 100,
      pastTokenCount: 0,
      usedContextTokenCount: 100,
    });
  });

  it('uses nested text model context declarations for multimodal decoder-only configs', () => {
    expect(resolveGenerationBudget({
      modelConfig: {
        model_type: 'gemma4',
        is_encoder_decoder: false,
        text_config: { max_position_embeddings: 8_192 },
      },
      inputs: { input_ids: tensorLike({ sequenceLength: 192 }) },
      pastKeyValues: null,
      maxCompletionTokens: undefined,
    }).maxNewTokens).toBe(8_000);
  });

  it('uses decoder context and decoder input length for encoder-decoder models', () => {
    expect(resolveGenerationBudget({
      modelConfig: {
        is_encoder_decoder: true,
        decoder: { max_position_embeddings: 1_024 },
      },
      inputs: {
        input_ids: tensorLike({ sequenceLength: 600 }),
        decoder_input_ids: tensorLike({ sequenceLength: 24 }),
      },
      pastKeyValues: null,
      maxCompletionTokens: undefined,
    }).maxNewTokens).toBe(1_000);
  });

  it('does not invent an encoder-decoder budget when decoder input length is unavailable', () => {
    expect(resolveGenerationBudget({
      modelConfig: {
        is_encoder_decoder: true,
        decoder: { max_position_embeddings: 1_024 },
      },
      inputs: { input_ids: tensorLike({ sequenceLength: 600 }) },
      pastKeyValues: null,
      maxCompletionTokens: undefined,
    }).maxNewTokens).toBeUndefined();
  });

  it('fails before generation when the decoder-only context is already full', () => {
    expect(() => resolveGenerationBudget({
      modelConfig: { max_position_embeddings: 4_096, is_encoder_decoder: false },
      inputs: { input_ids: tensorLike({ sequenceLength: 4_096 }) },
      pastKeyValues: null,
      maxCompletionTokens: undefined,
    })).toThrow('model context is full (4096/4096 tokens)');
  });
});
