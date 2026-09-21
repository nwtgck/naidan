// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCore, type Core } from '@/features/llama-cpp-browser/runtime/core';
import { createTinyLfm2Gguf } from './test-utils/tiny-lfm2-gguf';

type Snapshot = { pointer: bigint, size: bigint, flags: number };
// These llama.h ABI flags are macros, not entries in the supplied enum schema.
const partialOnly = 1;
const onDevice = 2;
let core: Core;
let model = 0n;
let context = 0n;
let memory = 0n;
const allocations = new Set<bigint>();

function allocate({ bytes }: { bytes: number | bigint }): bigint {
  const pointer = core.alloc({ bytes });
  allocations.add(pointer);
  return pointer;
}

function free({ pointer }: { pointer: bigint }): void {
  core.free({ pointer });
  allocations.delete(pointer);
}

async function position(): Promise<number> {
  return core.api.llama_memory_seq_pos_max(memory, 0);
}

async function decode({ tokens }: { tokens: readonly number[] }): Promise<number[]> {
  const pointer = allocate({ bytes: tokens.length * 4 });
  const batch = core.allocRecord({ name: 'llama_batch' });
  try {
    const bytes = core.bytes({ pointer, length: tokens.length * 4 });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    tokens.forEach((token, index) => view.setInt32(index * 4, token, true));
    await core.api.llama_batch_get_one(batch, pointer, tokens.length);
    expect(await core.api.llama_decode(context, batch)).toBe(0);
    const logits = await core.api.llama_get_logits_ith(context, -1);
    expect(logits).not.toBe(0n);
    const vocab = await core.api.llama_model_get_vocab(model);
    const count = await core.api.llama_vocab_n_tokens(vocab);
    const output = core.bytes({ pointer: logits, length: count * 4 });
    const outputView = new DataView(output.buffer, output.byteOffset, output.byteLength);
    return Array.from({ length: count }, (_, index) => outputView.getFloat32(index * 4, true));
  } finally {
    core.free({ pointer: batch });
    free({ pointer });
  }
}

async function snapshot({ flags }: { flags: number }): Promise<Snapshot> {
  const size = await core.api.llama_state_seq_get_size_ext(context, 0, flags);
  expect(size).toBeGreaterThan(0n);
  const pointer = allocate({ bytes: size });
  expect(await core.api.llama_state_seq_get_data_ext(context, pointer, size, 0, flags)).toBe(size);
  return { pointer, size, flags };
}

async function restore({ state }: { state: Snapshot }): Promise<void> {
  const { pointer, size, flags, ...unhandled } = state;
  unhandled satisfies Record<PropertyKey, never>;
  expect(await core.api.llama_state_seq_set_data_ext(context, pointer, size, 0, flags)).toBe(size);
}

function nextToken({ logits }: { logits: number[] }): number {
  return logits.reduce((best, value, index) => value > (logits[best] ?? -Infinity) ? index : best, 0);
}

function expectSameLogits({ actual, expected }: { actual: number[], expected: number[] }): void {
  expect(actual).toHaveLength(expected.length);
  for (const [index, value] of actual.entries()) {
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeCloseTo(expected[index]!, 5);
  }
  expect(nextToken({ logits: actual })).toBe(nextToken({ logits: expected }));
}

beforeAll(async () => {
  const folder = path.resolve('node_modules/llama-cpp-browser-core');
  core = await createCore({
    profile: 'cpu-wasm32',
    baseURL: pathToFileURL(folder + '/profiles/'),
    moduleOptions: {
      wasmBinary: await readFile(path.join(folder, 'profiles/cpu-wasm32/browser/core.wasm')),
      print() {},
      printErr() {},
    },
  });
  await core.api.llama_backend_init();
  core.module.FS.writeFile('/tiny-lfm2.gguf', createTinyLfm2Gguf());
  const filename = core.utf8({ text: '/tiny-lfm2.gguf' });
  const modelParams = core.allocRecord({ name: 'llama_model_params' });
  const contextParams = core.allocRecord({ name: 'llama_context_params' });
  try {
    await core.api.llama_model_default_params(modelParams);
    core.setField({ name: 'llama_model_params', pointer: modelParams, field: 'n_gpu_layers', value: 0 });
    model = await core.api.llama_model_load_from_file(filename, modelParams);
    expect(model).not.toBe(0n);
    await core.api.llama_context_default_params(contextParams);
    for (const [field, value] of Object.entries({ n_ctx: 128, n_batch: 32, n_ubatch: 32, n_threads: 1, n_threads_batch: 1, n_rs_seq: 0 })) {
      core.setField({ name: 'llama_context_params', pointer: contextParams, field, value });
    }
    context = await core.api.llama_init_from_model(model, contextParams);
    expect(context).not.toBe(0n);
    memory = await core.api.llama_get_memory(context);
    expect(memory).not.toBe(0n);
  } finally {
    core.free({ pointer: contextParams });
    core.free({ pointer: modelParams });
    core.free({ pointer: filename });
  }
}, 30000);

afterAll(async () => {
  if (!core) return;
  for (const pointer of allocations) core.free({ pointer });
  allocations.clear();
  if (context !== 0n) await core.api.llama_free(context);
  if (model !== 0n) await core.api.llama_model_free(model);
  await core.api.llama_backend_free();
});

describe('native hybrid checkpoints with a synthetic LFM2 GGUF', () => {
  it('restores a recurrent boundary while retaining attention and matches cold suffix decoding', async () => {
    expect(await core.api.llama_model_is_hybrid(model)).toBe(1);
    expect(await core.api.llama_n_rs_seq(context)).toBe(0);
    const prefix = [68, 68, 68];
    const suffix = [69, 68];
    await core.api.llama_memory_clear(memory, 1);
    const cold = await decode({ tokens: [...prefix, ...suffix] });
    const coldPosition = await position();
    for (const oldTail of [[69, 69, 69, 69], [68, 69, 68, 68, 69]]) {
      await core.api.llama_memory_clear(memory, 1);
      await decode({ tokens: prefix });
      const boundary = await snapshot({ flags: partialOnly });
      try {
        const fullSize = await core.api.llama_state_seq_get_size_ext(context, 0, 0);
        expect(boundary.size).toBeLessThan(fullSize);
        await decode({ tokens: oldTail });
        expect(await position()).toBe(prefix.length + oldTail.length - 1);
        // With n_rs_seq=0, recurrent memory cannot rewind its state without a checkpoint.
        expect(await core.api.llama_memory_seq_rm(memory, 0, prefix.length, -1)).toBe(0);
        expect(await position()).toBe(prefix.length + oldTail.length - 1);
        expect(await core.api.llama_state_seq_get_size_ext(context, 0, partialOnly)).toBe(boundary.size);
        expect(await core.api.llama_state_seq_get_size_ext(context, 0, 0)).toBeGreaterThan(fullSize);

        await restore({ state: boundary });
        // Partial restoration intentionally leaves attention at the old frontier.
        expect(await core.api.llama_memory_seq_rm(memory, 0, prefix.length, -1)).toBe(1);
        expect(await position()).toBe(prefix.length - 1);
        const warm = await decode({ tokens: suffix });
        expect(await position()).toBe(coldPosition);
        expectSameLogits({ actual: warm, expected: cold });
      } finally {
        free({ pointer: boundary.pointer });
      }
    }
  }, 30000);

  it('detects wrong recurrent state even when the retained attention and positions are correct', async () => {
    const prefix = [68, 68, 68];
    const suffix = [69];
    await core.api.llama_memory_clear(memory, 1);
    await decode({ tokens: prefix });
    const correctFull = await snapshot({ flags: 0 });
    try {
      const correct = await decode({ tokens: suffix });
      const correctPosition = await position();
      await core.api.llama_memory_clear(memory, 1);
      await decode({ tokens: [69, 69, 69] });
      const wrongPartial = await snapshot({ flags: partialOnly });
      try {
        await restore({ state: correctFull });
        await restore({ state: wrongPartial });
        expect(await position()).toBe(prefix.length - 1);
        // PARTIAL_ONLY does not replace attention. This perturbation changes only
        // the convolution state, proving that matching KV positions alone is insufficient.
        const wrong = await decode({ tokens: suffix });
        expect(await position()).toBe(correctPosition);
        expect(Math.max(...wrong.map((value, index) => Math.abs(value - correct[index]!)))).toBeGreaterThan(0.1);
        expect(nextToken({ logits: wrong })).not.toBe(nextToken({ logits: correct }));

        await restore({ state: correctFull });
        const restored = await decode({ tokens: suffix });
        expectSameLogits({ actual: restored, expected: correct });
      } finally {
        free({ pointer: wrongPartial.pointer });
      }
    } finally {
      free({ pointer: correctFull.pointer });
    }
  }, 30000);

  it('keeps one replaceable recurrent checkpoint on native buffers with a small host handle', async () => {
    const flags = partialOnly | onDevice;
    for (const prefix of [[68, 68, 68], [69, 68, 69, 68]]) {
      const suffix = [69, 68];
      await core.api.llama_memory_clear(memory, 1);
      const cold = await decode({ tokens: [...prefix, ...suffix] });
      await core.api.llama_memory_clear(memory, 1);
      await decode({ tokens: prefix });
      const hostBytes = await core.api.llama_state_seq_get_size_ext(context, 0, partialOnly);
      const state = await snapshot({ flags });
      try {
        // The host buffer is a handle; tensor bytes live in native backend storage.
        // This does not imply the smaller serialized size is the checkpoint's total memory cost.
        expect(state.size).toBeLessThan(hostBytes);
        await decode({ tokens: [69, 69, 68, 68] });
        expect(await core.api.llama_memory_seq_rm(memory, 0, prefix.length, -1)).toBe(0);
        await restore({ state });
        expect(await core.api.llama_memory_seq_rm(memory, 0, prefix.length, -1)).toBe(1);
        expect(await position()).toBe(prefix.length - 1);
        const warm = await decode({ tokens: suffix });
        expect(await position()).toBe(prefix.length + suffix.length - 1);
        expectSameLogits({ actual: warm, expected: cold });
      } finally {
        free({ pointer: state.pointer });
      }
      // The next get_data_ext invalidates the previous on-device state for this
      // sequence. Only the newly returned handle may be used after replacement.
    }
  }, 30000);
});
