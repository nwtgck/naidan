export type GenerationBudget = {
  readonly maxNewTokens: number | undefined,
  readonly source: 'explicit' | 'model-context' | 'transformers-default',
  readonly contextLimit: number | undefined,
  readonly promptTokenCount: number | undefined,
  readonly pastTokenCount: number,
  readonly usedContextTokenCount: number | undefined,
};

export function resolveGenerationBudget({
  modelConfig,
  inputs,
  pastKeyValues,
  maxCompletionTokens,
}: {
  modelConfig: unknown,
  inputs: Record<string, unknown>,
  pastKeyValues: unknown,
  maxCompletionTokens: number | undefined,
}): GenerationBudget {
  const config = asRecord({ value: modelConfig });
  const isEncoderDecoder = config?.['is_encoder_decoder'] === true;
  const contextLimit = resolveContextLimit({ config, isEncoderDecoder });
  const promptTokenCount = isEncoderDecoder
    ? readSequenceLength({ value: inputs['decoder_input_ids'] })
    : readSequenceLength({ value: inputs['input_ids'] });
  const pastTokenCount = readPastTokenCount({ pastKeyValues });
  const usedContextTokenCount = isEncoderDecoder
    ? resolveEncoderDecoderUsedContextTokenCount({ promptTokenCount, pastTokenCount })
    : resolveDecoderOnlyUsedContextTokenCount({
      promptTokenCount,
      attentionMaskTokenCount: readSequenceLength({ value: inputs['attention_mask'] }),
      pastTokenCount,
    });

  if (contextLimit !== undefined && usedContextTokenCount !== undefined) {
    const remainingContextTokens = contextLimit - usedContextTokenCount;
    if (remainingContextTokens <= 0) {
      throw new Error(
        `Generation cannot start because the model context is full (${usedContextTokenCount}/${contextLimit} tokens).`,
      );
    }
    return {
      maxNewTokens: maxCompletionTokens === undefined
        ? remainingContextTokens
        : Math.min(maxCompletionTokens, remainingContextTokens),
      source: maxCompletionTokens === undefined ? 'model-context' : 'explicit',
      contextLimit,
      promptTokenCount,
      pastTokenCount,
      usedContextTokenCount,
    };
  }

  if (maxCompletionTokens !== undefined) {
    return {
      maxNewTokens: maxCompletionTokens,
      source: 'explicit',
      contextLimit,
      promptTokenCount,
      pastTokenCount,
      usedContextTokenCount,
    };
  }

  return {
    maxNewTokens: undefined,
    source: 'transformers-default',
    contextLimit,
    promptTokenCount,
    pastTokenCount,
    usedContextTokenCount,
  };
}

function resolveDecoderOnlyUsedContextTokenCount({
  promptTokenCount,
  attentionMaskTokenCount,
  pastTokenCount,
}: {
  promptTokenCount: number | undefined,
  attentionMaskTokenCount: number | undefined,
  pastTokenCount: number,
}): number | undefined {
  if (promptTokenCount === undefined) return undefined;
  if (pastTokenCount === 0) return promptTokenCount;

  // Mirror Transformers.js decoder_prepare_inputs_for_generation. A full prompt
  // supplied with an external cache is sliced at past_length, so its total
  // occupied context is input_ids.length rather than past + input_ids.length.
  // Suffix-only inputs are left intact and extend the existing cache.
  if (attentionMaskTokenCount !== undefined && attentionMaskTokenCount > promptTokenCount) {
    return Math.max(attentionMaskTokenCount, pastTokenCount + promptTokenCount);
  }
  if (pastTokenCount < promptTokenCount) return promptTokenCount;
  return pastTokenCount + promptTokenCount;
}

function resolveEncoderDecoderUsedContextTokenCount({
  promptTokenCount,
  pastTokenCount,
}: {
  promptTokenCount: number | undefined,
  pastTokenCount: number,
}): number | undefined {
  if (promptTokenCount === undefined) return undefined;
  if (pastTokenCount === 0) return promptTokenCount;

  // Encoder-decoder generation forwards only the final decoder token when a
  // cache is present. Accommodate both full decoder histories and suffix-only
  // continuation inputs without double-counting the cached prefix.
  return Math.max(promptTokenCount, pastTokenCount + 1);
}

function resolveContextLimit({
  config,
  isEncoderDecoder,
}: {
  config: Record<string, unknown> | undefined,
  isEncoderDecoder: boolean,
}): number | undefined {
  if (!config) return undefined;

  const candidateConfigs = isEncoderDecoder
    ? [config['decoder'], config['generator'], config, config['text_config']]
    : [config, config['text_config'], config['language_config'], config['decoder']];

  for (const candidate of candidateConfigs) {
    const record = asRecord({ value: candidate });
    const contextLimit = readPositiveInteger({ value: record?.['max_position_embeddings'] });
    if (contextLimit !== undefined) return contextLimit;
  }
  return undefined;
}

function readSequenceLength({ value }: { value: unknown }): number | undefined {
  const record = asRecord({ value });
  const dims = record?.['dims'];
  if (!Array.isArray(dims) || dims.length === 0) return undefined;
  return readPositiveInteger({ value: dims.at(-1) });
}

function readPastTokenCount({ pastKeyValues }: { pastKeyValues: unknown }): number {
  const record = asRecord({ value: pastKeyValues });
  const getSequenceLength = record?.['get_seq_length'];
  if (typeof getSequenceLength !== 'function') return 0;
  try {
    const value = Reflect.apply(getSequenceLength, pastKeyValues, []) as unknown;
    return readNonNegativeInteger({ value }) ?? 0;
  } catch {
    return 0;
  }
}

function asRecord({ value }: { value: unknown }): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  return value as Record<string, unknown>;
}

function readPositiveInteger({ value }: { value: unknown }): number | undefined {
  const integer = readNonNegativeInteger({ value });
  return integer !== undefined && integer > 0 ? integer : undefined;
}

function readNonNegativeInteger({ value }: { value: unknown }): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
