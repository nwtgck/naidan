// eslint-disable-next-line no-restricted-imports -- Worker-only cache validation uses the supplied native Tensor class; no runtime import enters the UI.
import type { Tensor } from '@huggingface/transformers';

// An optimization ceiling, not a generation/input limit. Larger conversations
// use the full native input without a cache; no prefix is truncated to match.
export const QWEN_SEQUENCE_CACHE_MAX_TOKENS = 131072;

export type QwenSequenceCache = Readonly<{
  model: object;
  sequence: BigInt64Array<ArrayBuffer>;
  pastKeyValues: object;
}>;

function cpuRow({ value, tensorClass }: { value: unknown; tensorClass: typeof Tensor }): BigInt64Array | undefined {
  try {
    if (!(value instanceof tensorClass) || value.location !== 'cpu' || value.type !== 'int64'
      || value.dims.length !== 2 || value.dims[0] !== 1) return undefined;
    const length = value.dims[1];
    if (!Number.isSafeInteger(length) || length! < 1 || length! > QWEN_SEQUENCE_CACHE_MAX_TOKENS) return undefined;
    const data = value.data;
    return data instanceof BigInt64Array && data.buffer instanceof ArrayBuffer && data.length === length ? data : undefined;
  } catch {
    // Never request a GPU readback or try to revive a disposed Tensor.
    return undefined;
  }
}

function cacheLength({ pastKeyValues }: { pastKeyValues: unknown }): number | undefined {
  try {
    if (typeof pastKeyValues !== 'object' || pastKeyValues === null || !('get_seq_length' in pastKeyValues)
      || typeof pastKeyValues.get_seq_length !== 'function') return undefined;
    const length: unknown = pastKeyValues.get_seq_length();
    return typeof length === 'number' && Number.isSafeInteger(length) && length > 0 ? length : undefined;
  } catch {
    return undefined;
  }
}

function plainTextInput({ inputs, tensorClass }: { inputs: Record<string, unknown>; tensorClass: typeof Tensor }): BigInt64Array | undefined {
  if (Object.keys(inputs).some(key => key !== 'input_ids' && key !== 'attention_mask')) return undefined;
  const ids = cpuRow({ value: inputs['input_ids'], tensorClass });
  const mask = cpuRow({ value: inputs['attention_mask'], tensorClass });
  return ids !== undefined && mask !== undefined && mask.length === ids.length && mask.every(value => value === 1n) ? ids : undefined;
}

export function retainQwenSequenceCache({ model, sequences, pastKeyValues, inputs, tensorClass }: {
  model: object; sequences: unknown; pastKeyValues: unknown; inputs: Record<string, unknown>; tensorClass: typeof Tensor;
}): QwenSequenceCache | undefined {
  const row = cpuRow({ value: sequences, tensorClass });
  const input = plainTextInput({ inputs, tensorClass });
  if (row === undefined || input === undefined || input.length >= row.length
    || !input.every((value, index) => row[index] === value)
    || typeof pastKeyValues !== 'object' || pastKeyValues === null
    || cacheLength({ pastKeyValues }) !== row.length - 1) return undefined;
  return Object.freeze({ model, sequence: new BigInt64Array(row), pastKeyValues });
}

export function canReuseQwenSequenceCache({ cache, model, inputs, tensorClass }: {
  cache: QwenSequenceCache | undefined; model: object; inputs: Record<string, unknown>; tensorClass: typeof Tensor;
}): boolean {
  if (cache === undefined || cache.model !== model) return false;
  // Only the pinned Qwen full-input prepare branch is established here.
  // Unknown positional, multimodal or embedding inputs require a fresh cache.
  const ids = plainTextInput({ inputs, tensorClass });
  if (ids === undefined) return false;
  const length = cacheLength({ pastKeyValues: cache.pastKeyValues });
  if (length === undefined || length !== cache.sequence.length - 1 || length >= ids.length || cache.sequence.length > ids.length) return false;
  if (!cache.sequence.every((value, index) => ids[index] === value)) return false;
  try {
    if (!('sessions' in model) || typeof model.sessions !== 'object' || model.sessions === null) return false;
    const sessions = model.sessions;
    const decoder = 'decoder_model_merged' in sessions ? sessions.decoder_model_merged : undefined;
    const session = decoder ?? ('model' in sessions ? sessions.model : undefined);
    return typeof session === 'object' && session !== null && 'inputNames' in session
      && Array.isArray(session.inputNames) && session.inputNames.includes('position_ids');
  } catch {
    return false;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
