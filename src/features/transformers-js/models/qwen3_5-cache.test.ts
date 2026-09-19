// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { getProductionTransformersArtifact, importProductionTransformersArtifact } from '@/features/transformers-js/runtime/fixtures/production-transformers-artifact';
import { canReuseQwenSequenceCache, retainQwenSequenceCache, QWEN_SEQUENCE_CACHE_MAX_TOKENS } from './qwen3_5-cache';

let runtime: typeof import('@huggingface/transformers');
const fetch = vi.fn(() => {
  throw new Error('External network forbidden in Qwen cache tests');
});
beforeAll(async () => {
  vi.stubGlobal('fetch', fetch);
  const artifact = await getProductionTransformersArtifact();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process')!;
  Object.defineProperty(globalThis, 'process', { configurable: true, value: { ...process, release: { ...process.release, name: 'browser-test' } } });
  try {
    runtime = await importProductionTransformersArtifact({ moduleUrl: `${artifact.moduleUrl}?qwen-cache=native-tensor` }) as typeof runtime;
  } finally {
    Object.defineProperty(globalThis, 'process', descriptor);
  }
}, 30_000);
afterAll(() => {
  expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals();
});

function fixture() {
  const model = { sessions: { decoder_model_merged: { inputNames: ['input_ids', 'position_ids', 'attention_mask'] } } };
  const pastKeyValues = { get_seq_length: vi.fn(() => 3) };
  const sequences = new runtime.Tensor('int64', BigInt64Array.from([10n, 11n, 12n, 13n]), [1, 4]);
  const firstInputs = {
    input_ids: new runtime.Tensor('int64', BigInt64Array.from([10n, 11n]), [1, 2]),
    attention_mask: new runtime.Tensor('int64', BigInt64Array.from([1n, 1n]), [1, 2]),
  };
  const cache = retainQwenSequenceCache({ model, sequences, pastKeyValues, inputs: firstInputs, tensorClass: runtime.Tensor });
  const inputs = {
    input_ids: new runtime.Tensor('int64', BigInt64Array.from([10n, 11n, 12n, 13n, 14n, 15n]), [1, 6]),
    attention_mask: new runtime.Tensor('int64', BigInt64Array.from([1n, 1n, 1n, 1n, 1n, 1n]), [1, 6]),
  };
  return { model, pastKeyValues, sequences, cache, inputs, firstInputs, tensorClass: runtime.Tensor };
}

function nativePrepare({ pastLength }: { pastLength: number }) {
  // Execute the actual inherited Qwen prepare method, without an ORT session
  // or model weights. This tiny synthetic attention tensor is not recorded KV.
  const model = Object.assign(Object.create(runtime.Qwen3_5ForConditionalGeneration.prototype) as InstanceType<typeof runtime.Qwen3_5ForConditionalGeneration>, {
    config: { vision_config: { spatial_merge_size: 2 } }, sessions: { model: { inputNames: ['position_ids'] } },
  });
  const ids = [10n, 11n, 12n, 13n, 14n, 15n];
  const past = new runtime.DynamicCache({ 'past_key_values.0.key': new runtime.Tensor('float32', new Float32Array(pastLength), [1, 1, pastLength, 1]) });
  return model.prepare_inputs_for_generation([ids], {
    input_ids: new runtime.Tensor('int64', ids, [1, 6]), attention_mask: new runtime.Tensor('int64', [1n, 1n, 1n, 1n, 1n, 1n], [1, 6]), past_key_values: past,
  }, {});
}

describe('Qwen text cache prefix and pinned native prepare preconditions', () => {
  it('lets the native full-input branch process the final uncached output token at K = L - 1', () => {
    const actual = nativePrepare({ pastLength: 3 });
    expect(actual.input_ids.tolist()).toEqual([[13n, 14n, 15n]]);
    expect(actual.position_ids.dims).toEqual([3, 1, 3]);
    expect(actual.position_ids.tolist()).toEqual([[[3n, 4n, 5n]], [[3n, 4n, 5n]], [[3n, 4n, 5n]]]);
  });

  it('demonstrates why a same-prefix cache with K >= N must not enter native autoregressive preparation', () => {
    const actual = nativePrepare({ pastLength: 6 });
    expect(actual.input_ids.tolist()).toEqual([[10n, 11n, 12n, 13n, 14n, 15n]]);
    expect(actual.position_ids.dims).toEqual([3, 1, 1]);
  });

  it('retains one owned CPU sequence copy and allows the unprocessed last token in the full next input', () => {
    const value = fixture();
    expect(value.cache).toBeDefined();
    expect(value.cache!.sequence).not.toBe(value.sequences.data);
    expect(canReuseQwenSequenceCache(value)).toBe(true);
    value.sequences.data[0] = 99n;
    expect(value.cache!.sequence[0]).toBe(10n);
  });

  it('rejects the equal-prefix K >= N autoregressive-branch counterexample', () => {
    const value = fixture();
    value.pastKeyValues.get_seq_length.mockReturnValue(6);
    expect(canReuseQwenSequenceCache(value)).toBe(false);
  });

  it('rejects a cache that has processed a different number of sequence tokens', () => {
    const value = fixture();
    value.pastKeyValues.get_seq_length.mockReturnValue(2);
    expect(canReuseQwenSequenceCache(value)).toBe(false);
  });

  it('rejects changed thinking, history or template token prefixes', () => {
    const value = fixture();
    value.inputs.input_ids.data[2] = 99n;
    expect(canReuseQwenSequenceCache(value)).toBe(false);
  });

  it('rejects a replaced loaded model even when its input IDs are identical', () => {
    const value = fixture();
    expect(canReuseQwenSequenceCache({ ...value, model: { ...value.model } })).toBe(false);
  });

  it('rejects padding masks rather than assuming equal IDs prove equal cache inputs', () => {
    const value = fixture();
    value.inputs.attention_mask.data[0] = 0n;
    expect(canReuseQwenSequenceCache(value)).toBe(false);
  });

  it('does not retain a cache created from a padded input even if the next input would be unpadded', () => {
    const value = fixture();
    value.firstInputs.attention_mask.data[0] = 0n;
    expect(retainQwenSequenceCache({ ...value, inputs: value.firstInputs })).toBeUndefined();
  });

  it('does not retain a cache created with non-text inputs even if its output IDs match', () => {
    const value = fixture();
    expect(retainQwenSequenceCache({ ...value, inputs: { ...value.firstInputs, inputs_embeds: {} } })).toBeUndefined();
  });

  it('does not retain output sequences that do not contain their own actual input prefix', () => {
    const value = fixture();
    value.firstInputs.input_ids.data[0] = 99n;
    expect(retainQwenSequenceCache({ ...value, inputs: value.firstInputs })).toBeUndefined();
  });

  it('rejects precomputed positions instead of bypassing the audited native prepare branch', () => {
    const value = fixture();
    expect(canReuseQwenSequenceCache({ ...value, inputs: { ...value.inputs, position_ids: value.inputs.input_ids } })).toBe(false);
  });

  it('rejects image and embedding inputs even with the same text prefix', () => {
    const value = fixture();
    expect(canReuseQwenSequenceCache({ ...value, inputs: { ...value.inputs, pixel_values: {} } })).toBe(false);
    expect(canReuseQwenSequenceCache({ ...value, inputs: { ...value.inputs, inputs_embeds: {} } })).toBe(false);
  });

  it('rejects a decoder session without position_ids', () => {
    const value = fixture();
    value.model.sessions.decoder_model_merged.inputNames = ['input_ids'];
    expect(canReuseQwenSequenceCache(value)).toBe(false);
  });

  it('rejects unknown and null caches without treating native falsy values as reused', () => {
    const value = fixture();
    expect(retainQwenSequenceCache({ ...value, inputs: value.firstInputs, pastKeyValues: undefined })).toBeUndefined();
    expect(retainQwenSequenceCache({ ...value, inputs: value.firstInputs, pastKeyValues: null })).toBeUndefined();
  });

  it('contains cache length read failure and falls back to the full input', () => {
    const value = fixture();
    value.pastKeyValues.get_seq_length.mockImplementation(() => {
      throw new Error('disposed cache');
    });
    expect(canReuseQwenSequenceCache(value)).toBe(false);
  });

  it('rejects multiple rows instead of comparing only a convenient first row', () => {
    const value = fixture();
    const sequences = new runtime.Tensor('int64', BigInt64Array.from([10n, 11n, 12n, 13n]), [2, 2]);
    expect(retainQwenSequenceCache({ ...value, inputs: value.firstInputs, sequences })).toBeUndefined();
  });

  it('rejects a non-int64 Tensor without coercing token identities', () => {
    const value = fixture();
    const sequences = new runtime.Tensor('int32', Int32Array.from([10, 11, 12, 13]), [1, 4]);
    expect(retainQwenSequenceCache({ ...value, inputs: value.firstInputs, sequences })).toBeUndefined();
  });

  it('rejects non-CPU tensors before touching their data getter', () => {
    const value = fixture();
    Object.defineProperty(value.sequences, 'location', { value: 'gpu-buffer' });
    const data = vi.fn(() => {
      throw new Error('GPU read forbidden');
    });
    Object.defineProperty(value.sequences, 'data', { get: data });
    expect(retainQwenSequenceCache({ ...value, inputs: value.firstInputs })).toBeUndefined();
    expect(data).not.toHaveBeenCalled();
  });

  it('uses a fresh cache above the retained sequence ceiling without truncating a prefix', () => {
    const value = fixture();
    Object.defineProperty(value.sequences, 'dims', { value: [1, QWEN_SEQUENCE_CACHE_MAX_TOKENS + 1] });
    const data = vi.fn(() => {
      throw new Error('Oversized allocation forbidden');
    });
    Object.defineProperty(value.sequences, 'data', { get: data });
    expect(retainQwenSequenceCache({ ...value, inputs: value.firstInputs })).toBeUndefined();
    expect(data).not.toHaveBeenCalled();
  });
});
