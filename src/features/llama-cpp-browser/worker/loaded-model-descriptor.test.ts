import { describe, expect, it, vi } from 'vitest';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { loadedModelDescriptorSchema } from '@/features/llama-cpp-browser/loaded-model-descriptor';
import { readLoadedModelDescriptor } from './loaded-model-descriptor';

function fixture() {
  let key = ''; const heap = new Uint8Array(65);
  const core = {
    api: {
      llama_model_ftype: vi.fn(async () => 15),
      llama_model_n_ctx_train: vi.fn(async () => 131072),
      llama_model_n_embd: vi.fn(async () => 4096),
      llama_model_n_layer: vi.fn(async () => 64),
      llama_model_n_head: vi.fn(async () => 32),
      llama_model_n_head_kv: vi.fn(async () => 8),
      llama_model_n_swa: vi.fn(async () => 0),
      llama_model_n_params: vi.fn(async () => 9007199254740993n),
      llama_model_size: vi.fn(async () => 18446744073709551615n),
      llama_model_meta_val_str: vi.fn(async () => {
        const value = key === 'general.architecture' ? 'qwen35' : '15';
        heap.set(new TextEncoder().encode(value)); return value.length;
      }),
    },
    utf8: vi.fn(({ text }: { text: string }) => {
      key = text; return 1n;
    }),
    alloc: vi.fn(() => 2n),
    bytes: vi.fn(({ length }: { length: number }) => heap.subarray(0, length)),
    free: vi.fn(),
  };
  return { core, read: () => readLoadedModelDescriptor({ core: core as unknown as Core, model: 10n }) };
}

describe('loaded model descriptor', () => {
  it('preserves uint64 values across strict JSON serialization without collecting arbitrary metadata', async () => {
    const { core, read } = fixture(); const value = await read();
    expect(value).toEqual({ source: 'loaded-model-native-api', architecture: 'qwen35', fileType: 15, trainingContextTokens: 131072, embeddingDimensions: 4096, layers: 64, attentionHeads: 32, keyValueHeads: 8, slidingWindowTokens: 0, parameterCount: '9007199254740993', tensorBytes: '18446744073709551615' });
    expect(loadedModelDescriptorSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(core.utf8.mock.calls.map(([value]) => value.text)).toEqual(['general.architecture']);
    expect(core.free).toHaveBeenCalledTimes(2);
  });

  it('keeps good fields when getters throw or return invalid or missing data', async () => {
    const { core, read } = fixture();
    core.api.llama_model_ftype.mockResolvedValue(-1);
    core.api.llama_model_n_layer.mockRejectedValue(new Error('unavailable'));
    core.api.llama_model_n_embd.mockResolvedValue(NaN);
    core.api.llama_model_n_head.mockResolvedValue(-1);
    core.api.llama_model_n_params.mockResolvedValue(-1n);
    core.api.llama_model_size.mockResolvedValue(18446744073709551616n);
    core.api.llama_model_meta_val_str.mockResolvedValue(-1);
    expect(await read()).toEqual({ source: 'loaded-model-native-api', trainingContextTokens: 131072, keyValueHeads: 8, slidingWindowTokens: 0 });
    expect(core.free).toHaveBeenCalledTimes(2);
  });

  it.each([65, 1000000, Infinity, 1.5])('rejects truncated metadata length %s without allocating larger buffers', async length => {
    const { core, read } = fixture(); core.api.llama_model_meta_val_str.mockResolvedValue(length);
    const result = await read(); expect(result.architecture).toBeUndefined(); expect(result.fileType).toBe(15);
    expect(core.alloc.mock.calls).toEqual([[{ bytes: 65 }]]);
  });

  it.each(['-1', '01', '18446744073709551616', '1e6', 'private-model'])('rejects unsafe serialized uint64 %s', value => {
    expect(loadedModelDescriptorSchema.safeParse({ source: 'loaded-model-native-api', parameterCount: value }).success).toBe(false);
  });
});

it('attempts both cleanup releases without replacing inference with a diagnostic error', async () => {
  const { core, read } = fixture(); core.free.mockImplementation(() => {
    throw new Error('release failure');
  });
  expect((await read()).architecture).toBe('qwen35');
  expect(core.free).toHaveBeenCalledTimes(2);
});
