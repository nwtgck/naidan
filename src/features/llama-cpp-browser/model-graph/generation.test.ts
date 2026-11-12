// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCore, type Core } from '@/features/llama-cpp-browser/runtime/core';
import { createPositionSensitiveGguf } from '@/features/llama-cpp-browser/worker/test-utils/synthetic-gguf.test-support';
import { resolvedModelFixture } from '@/features/llama-cpp-browser/worker/test-utils/resolved-model.test-support';
import type { WorkerGenerateInput } from '@/features/llama-cpp-browser/worker/types';
import type { Diagnostic } from '@/features/llama-cpp-browser/debug-log';
import { createModelGraphEngine } from './engine';
import { combineModelGraphGgufs, inspectModelGraphGguf } from './gguf';
import { llamaGraphFixture } from './fixtures.test-support';
import { generateWithRegisteredGraph } from './generation';
import type { RegisteredGraphSession } from './session';

const calls = vi.hoisted(() => ({ prepare: vi.fn(), release: vi.fn() }));
vi.mock('./session', () => ({ prepareRegisteredGraph: calls.prepare, releaseRegisteredGraph: calls.release }));

/** Test adapter only: the old published Wasm provides the actual GGML, chat and
 * sampling code, but not the new vocabulary owner ABI. The new owner/ABI is tested
 * separately in bicore's native target. This is not a rebuilt-Wasm acceptance test. */
function samplingAdapter({ core, vocabularySize }: { core: Core, vocabularySize: number }) {
  // The fixture runs the real, synchronous cpu-wasm32 exports. These raw
  // exports are not part of the generic module type (the public API is async).
  const nativeSampler = core.module as unknown as {
    _lcb_llama_sampler_apply(sampler: bigint, candidates: bigint): void;
    _lcb_llama_sampler_accept(sampler: bigint, token: number): void;
  };
  expect(typeof nativeSampler._lcb_llama_sampler_apply).toBe('function');
  expect(typeof nativeSampler._lcb_llama_sampler_accept).toBe('function');
  const stride = core.recordSize({ name: 'llama_token_data' });
  const data = core.alloc({ bytes: stride * vocabularySize });
  const array = core.allocRecord({ name: 'llama_token_data_array' });
  const selectedOffset = Number(core.fieldLayout({ name: 'llama_token_data_array', field: 'selected' }).offset);
  const dataOffset = Number(core.fieldLayout({ name: 'llama_token_data_array', field: 'data' }).offset);
  const idOffset = Number(core.fieldLayout({ name: 'llama_token_data', field: 'id' }).offset);
  return {
    sample({ sampler, logits }: { sampler: bigint, logits: bigint }): number {
      for (let i = 0; i < vocabularySize; i++) {
        const pointer = data + BigInt(stride * i);
        const bytes = core.bytes({ pointer: logits + BigInt(i * 4), length: 4 });
        const logit = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(0, true);
        core.setField({ name: 'llama_token_data', pointer, field: 'id', value: i });
        core.setField({ name: 'llama_token_data', pointer, field: 'logit', value: logit });
        core.setField({ name: 'llama_token_data', pointer, field: 'p', value: 0 });
      }
      core.setField({ name: 'llama_token_data_array', pointer: array, field: 'data', value: data });
      core.setField({ name: 'llama_token_data_array', pointer: array, field: 'size', value: BigInt(vocabularySize) });
      core.setField({ name: 'llama_token_data_array', pointer: array, field: 'selected', value: -1n });
      core.setField({ name: 'llama_token_data_array', pointer: array, field: 'sorted', value: 0 });
      nativeSampler._lcb_llama_sampler_apply(sampler, array);
      const a = core.bytes({ pointer: array, length: core.recordSize({ name: 'llama_token_data_array' }) });
      const view = new DataView(a.buffer, a.byteOffset, a.byteLength);
      const selected = Number(view.getBigInt64(selectedOffset, true));
      const selectedData = BigInt(view.getUint32(dataOffset, true));
      if (selected < 0 || selected >= vocabularySize) {
        throw new Error('Test sampler selected an invalid candidate');
      }
      const bytes = core.bytes({ pointer: selectedData + BigInt(stride * selected + idOffset), length: 4 });
      const token = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true);
      nativeSampler._lcb_llama_sampler_accept(sampler, token);
      return token;
    },
    close() {
      core.free({ pointer: data });
      core.free({ pointer: array });
    },
  };
}

describe('registered graph generation with real CPU execution and native sampling', () => {
  let core: Core, model: bigint, vocab: bigint;
  let current: RegisteredGraphSession | undefined;
  const bytes = createPositionSensitiveGguf({ chatTemplate: 'chatml' });

  beforeAll(async () => {
    const baseURL = pathToFileURL(path.resolve('node_modules/llama-cpp-browser-core/llama-cpp-browser-core/profiles') + '/');
    core = await createCore({ profile: 'cpu-wasm32', baseURL, moduleOptions: { wasmBinary: await readFile(new URL('cpu-wasm32/browser/core.wasm', baseURL)), print() {}, printErr() {} } });
    await core.api.llama_backend_init();
    core.module.FS.writeFile('/generation-fixture.gguf', bytes);
    const file = core.utf8({ text: '/generation-fixture.gguf' }), params = core.allocRecord({ name: 'llama_model_params' });
    using _args = {
      [Symbol.dispose]() {
        core.free({ pointer: file });
        core.free({ pointer: params });
      },
    };
    await core.api.llama_model_default_params(params);
    core.setField({ name: 'llama_model_params', pointer: params, field: 'n_gpu_layers', value: 0 });
    model = await core.api.llama_model_load_from_file(file, params);
    vocab = await core.api.llama_model_get_vocab(model);
    vi.spyOn(core.chat, 'prepareFromVocabulary').mockImplementation(({ assertIdle, request }) => core.chat.prepare({ assertIdle, model, request }));
    calls.prepare.mockImplementation(() => current);
    calls.release.mockImplementation(async () => {
      const previous = current;
      current = undefined;
      await previous?.engine.close();
    });
  });

  afterEach(async () => {
    await calls.release();
    calls.release.mockClear();
    calls.prepare.mockClear();
  });

  afterAll(async () => {
    core.chat.releaseModel({ assertIdle: core.assertIdle, model });
    await core.api.llama_model_free(model);
    vi.restoreAllMocks();
  });

  async function prepare(): Promise<WorkerGenerateInput> {
    const source = {
      size: bytes.length,
      read({ offset, destination }: { offset: number, destination: Uint8Array }): number {
        const n = Math.min(destination.length, bytes.length - offset);
        destination.set(bytes.subarray(offset, offset + n));
        return n;
      },
    };
    const { inventory, locations } = combineModelGraphGgufs({ files: [inspectModelGraphGguf({ source, signal: undefined })] });
    const engine = await createModelGraphEngine({ core, definition: llamaGraphFixture(), inventory, locations, contextSize: 256, batchSize: 128, backend: 'cpu', threads: 1, maximumScratchBytes: 64 * 1024 * 1024, signal: undefined, onWeightProgress: undefined });
    current = {
      core,
      engine,
      vocabularySize: 259,
      contextSize: 256,
      batchSize: 128,
      vocabulary: { owner: model, vocab, close() {} },
      boundary: {
        architectureKnown: () => true,
        createVocabulary: async () => {
          throw new Error('Not used by this test');
        },
        createSamplerWorkspace: ({ vocabularySize }) => samplingAdapter({ core, vocabularySize }),
      },
      execution: { kind: 'registeredModelGraph', registrationId: 'test-registration', label: 'Test', architecture: 'llama', format: 'naidan.model-graph/experimental-1', definitionSha256: 'a'.repeat(64), nativeExtensionSha256: 'b'.repeat(64) },
    };
    return { modelId: 'user/model.gguf', resolvedModel: resolvedModelFixture({ modelId: 'user/model.gguf' }), options: { profile: 'cpu-wasm32', contextTokens: 256 }, messages: [{ role: 'user', content: 'AB' }], temperature: 0, topP: 1, maxTokens: 4, presencePenalty: 0, frequencyPenalty: 0, stop: [], debug: 'on' };
  }

  it('streams real tokens, reports the actual execution and reuses the graph after a reset', async () => {
    const request = await prepare();
    const summaries: Diagnostic[] = [], deltas: string[] = [];
    const native = vi.fn(async () => {
      throw new Error('Unexpected native fallback');
    });
    const first = await generateWithRegisteredGraph({
      request,
      signal: undefined,
      onEvent: async ({ event }) => {
        if (event.type === 'text') {
          deltas.push(event.text);
        }
      },
      onProgress() {},
      onSummary: ({ diagnostic }) => summaries.push(diagnostic),
      native,
    });
    expect(first.content.length).toBeGreaterThan(0);
    expect(deltas.join('')).toBe(first.content);
    expect(first.finishReason).toBe('length');
    expect(summaries[0]?.modelExecution?.kind).toBe('registeredModelGraph');
    expect(summaries[0]?.performance?.registeredGraphTiming?.reuseHits).toBeGreaterThan(0);
    expect(summaries[0]?.performance?.decodedTokens).toBe(3);
    const second = await generateWithRegisteredGraph({ request, signal: undefined, onEvent: async () => {}, onProgress() {}, onSummary: undefined, native });
    expect(second.content).toBe(first.content);
    expect(native).not.toHaveBeenCalled();
  }, 30000);

  it('honors stop strings without returning or decoding their suffix', async () => {
    const request = await prepare();
    const result = await generateWithRegisteredGraph({
      request: { ...request, stop: ['A', 'B'] },
      signal: undefined,
      onEvent: async () => {},
      onProgress() {},
      onSummary: undefined,
      native: async () => {
        throw new Error('fallback');
      },
    });
    expect(result.finishReason).toBe('stop_sequence');
    expect(result.content).toBe('');
  });

  it('cancels from a delivery callback and releases the partially updated owner', async () => {
    const request = await prepare(), controller = new AbortController();
    const summaries: Diagnostic[] = [];
    await expect(generateWithRegisteredGraph({
      request,
      signal: controller.signal,
      onEvent: async () => {
        controller.abort();
      },
      onProgress() {},
      onSummary: ({ diagnostic }) => summaries.push(diagnostic),
      native: async () => {
        throw new Error('fallback');
      },
    })).rejects.toThrow();
    expect(calls.release).toHaveBeenCalledOnce();
    expect(current).toBeUndefined();
    expect(summaries[0]?.performance?.outcome).toBe('aborted');
  });

  it('preserves callback errors and does not deliver again during cleanup', async () => {
    const request = await prepare(), onEvent = vi.fn(async () => {
      throw new Error('consumer rejected');
    });
    await expect(generateWithRegisteredGraph({
      request,
      signal: undefined,
      onEvent,
      onProgress() {},
      onSummary: undefined,
      native: async () => {
        throw new Error('fallback');
      },
    })).rejects.toThrow('consumer rejected');
    expect(onEvent).toHaveBeenCalledOnce();
    expect(current).toBeUndefined();
  });

  it('releases the owner when a successful generation summary cannot be delivered', async () => {
    const request = await prepare();
    await expect(generateWithRegisteredGraph({
      request,
      signal: undefined,
      onEvent: async () => {},
      onProgress() {},
      onSummary: () => {
        throw new Error('summary rejected');
      },
      native: async () => {
        throw new Error('fallback');
      },
    })).rejects.toThrow('summary rejected');
    expect(calls.release).toHaveBeenCalledOnce();
    expect(current).toBeUndefined();
  });

  it('preserves the primary delivery error when summary reporting also fails', async () => {
    const request = await prepare();
    await expect(generateWithRegisteredGraph({
      request,
      signal: undefined,
      onEvent: async () => {
        throw new Error('primary delivery failure');
      },
      onProgress() {},
      onSummary: () => {
        throw new Error('secondary summary failure');
      },
      native: async () => {
        throw new Error('fallback');
      },
    })).rejects.toThrow('primary delivery failure');
    expect(calls.release).toHaveBeenCalledOnce();
    expect(current).toBeUndefined();
  });
});
