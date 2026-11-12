// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCore, type Core } from '@/features/llama-cpp-browser/runtime/core';
import { createPositionSensitiveGguf } from '@/features/llama-cpp-browser/worker/test-utils/synthetic-gguf.test-support';
import { createModelGraphEngine } from './engine';
import { combineModelGraphGgufs, inspectModelGraphGguf, copyModelGraphVocabularyMetadata } from './gguf';
import { graphFixture, llamaGraphFixture } from './fixtures.test-support';

function sourceFromBytes({ bytes }: { bytes: Uint8Array }) {
  return {
    size: bytes.length,
    read({ offset, destination }: { offset: number, destination: Uint8Array }): number {
      const size = Math.min(destination.length, bytes.length - offset, 3001);
      destination.set(bytes.subarray(offset, offset + size));
      return size;
    },
  };
}

describe('registered graph real CPU Wasm execution', () => {
  let core: Core;

  beforeAll(async () => {
    const baseURL = pathToFileURL(path.resolve('node_modules/llama-cpp-browser-core/llama-cpp-browser-core/profiles') + '/');
    core = await createCore({ profile: 'cpu-wasm32', baseURL, moduleOptions: { wasmBinary: await readFile(new URL('cpu-wasm32/browser/core.wasm', baseURL)), print() {}, printErr() {} } });
    await core.api.llama_backend_init();
  });

  it('matches native Llama logits through prefill, single-token reuse and cache growth', async () => {
    const bytes = createPositionSensitiveGguf({ chatTemplate: 'chatml' });
    const gguf = inspectModelGraphGguf({ source: sourceFromBytes({ bytes }), signal: undefined });
    const { inventory, locations } = combineModelGraphGgufs({ files: [gguf] });
    const engine = await createModelGraphEngine({ core, definition: llamaGraphFixture(), inventory, locations, contextSize: 128, batchSize: 64, backend: 'cpu', threads: 1, maximumScratchBytes: 64 * 1024 * 1024, signal: undefined, onWeightProgress: undefined });
    await using _engine = {
      async [Symbol.asyncDispose]() {
        await engine.close();
      },
    };
    core.module.FS.writeFile('/registered-graph-fixture.gguf', bytes);
    const file = core.utf8({ text: '/registered-graph-fixture.gguf' });
    const params = core.allocRecord({ name: 'llama_model_params' });
    using _params = {
      [Symbol.dispose]() {
        core.free({ pointer: file });
        core.free({ pointer: params });
        core.module.FS.unlink('/registered-graph-fixture.gguf');
      },
    };
    await core.api.llama_model_default_params(params);
    core.setField({ name: 'llama_model_params', pointer: params, field: 'n_gpu_layers', value: 0 });
    const model = await core.api.llama_model_load_from_file(file, params);
    expect(model).not.toBe(0n);
    await using _model = {
      async [Symbol.asyncDispose]() {
        await core.api.llama_model_free(model);
      },
    };
    const ctxParams = core.allocRecord({ name: 'llama_context_params' });
    using _ctxParams = {
      [Symbol.dispose]() {
        core.free({ pointer: ctxParams });
      },
    };
    await core.api.llama_context_default_params(ctxParams);
    for (const [field, value] of Object.entries({ n_ctx: 128, n_batch: 64, n_ubatch: 64, n_threads: 1, n_threads_batch: 1, type_k: core.constant({ name: 'GGML_TYPE_F32' }), type_v: core.constant({ name: 'GGML_TYPE_F32' }) })) {
      core.setField({ name: 'llama_context_params', pointer: ctxParams, field, value });
    }
    const context = await core.api.llama_init_from_model(model, ctxParams);
    expect(context).not.toBe(0n);
    await using _context = {
      async [Symbol.asyncDispose]() {
        await core.api.llama_free(context);
      },
    };
    const tokenPointer = core.alloc({ bytes: 64 * 4 }), batch = core.allocRecord({ name: 'llama_batch' });
    using _batch = {
      [Symbol.dispose]() {
        core.free({ pointer: tokenPointer });
        core.free({ pointer: batch });
      },
    };
    const batches = [[1, 68, 69, 68], [69], [68], Array.from({ length: 58 }, (_, index) => 68 + index % 2), [68], [69]];
    const reuse: boolean[] = [];
    for (const tokens of batches) {
      core.bytes({ pointer: tokenPointer, length: tokens.length * 4 }).set(new Uint8Array(new Int32Array(tokens).buffer));
      await core.api.llama_batch_get_one(batch, tokenPointer, tokens.length);
      expect(await core.api.llama_decode(context, batch)).toBe(0);
      const nativePointer = await core.api.llama_get_logits_ith(context, -1);
      const expected = new Float32Array(core.bytes({ pointer: nativePointer, length: inventory.vocabularySize * 4 }).slice().buffer);
      const timings = await engine.step({ tokens, signal: undefined });
      reuse.push(timings.graphReused);
      const actual = new Float32Array(core.bytes({ pointer: engine.logitsPointer, length: inventory.vocabularySize * 4 }).slice().buffer);
      const maximumError = Math.max(...actual.map((value, index) => Math.abs(value - expected[index]!)));
      expect(maximumError).toBeLessThan(0.001);
      expect(timings.computeMs).toBeGreaterThanOrEqual(0);
    }
    expect(reuse).toEqual([false, false, true, false, false, true]);
    expect(engine.processedTokens).toBe(66);
    await engine.reset();
    expect(engine.processedTokens).toBe(0);
    expect(() => engine.logitsPointer).toThrow('unavailable');
    await engine.step({ tokens: [68, 69, 68], signal: undefined });
    const first = core.bytes({ pointer: engine.logitsPointer, length: inventory.vocabularySize * 4 }).slice();
    await engine.reset();
    await engine.step({ tokens: [68, 69, 68], signal: undefined });
    expect(core.bytes({ pointer: engine.logitsPointer, length: first.length })).toEqual(first);
    const aborted = new AbortController();
    aborted.abort();
    await expect(engine.step({ tokens: [69], signal: aborted.signal })).rejects.toThrow();
    expect(engine.processedTokens).toBe(3);
  }, 30000);

  it('executes a stateless graph without unused native input buffers and reuses it past position 64', async () => {
    const { definition, inventory } = graphFixture();
    const values = new Float32Array(Array.from({ length: 20 }, (_, i) => (i + 1) / 20));
    const source = sourceFromBytes({ bytes: new Uint8Array(values.buffer) });
    const locations = new Map(['token_embd.weight', 'output.weight'].map(name => [name, { source, offset: 0 }]));
    const engine = await createModelGraphEngine({ core, definition, inventory, locations, contextSize: 128, batchSize: 8, backend: 'cpu', threads: 1, maximumScratchBytes: 65536, signal: undefined, onWeightProgress: undefined });
    await using _engine = {
      async [Symbol.asyncDispose]() {
        await engine.close();
      },
    };
    for (let step = 0; step < 66; step++) {
      const token = step % 5;
      const timings = await engine.step({ tokens: [token], signal: undefined });
      expect(timings.graphReused).toBe(step !== 0);
      const actual = new Float32Array(core.bytes({ pointer: engine.logitsPointer, length: 20 }).slice().buffer);
      for (let word = 0; word < 5; word++) {
        const expected = [0, 1, 2, 3].reduce((sum, k) => sum + values[token * 4 + k]! * values[word * 4 + k]!, 0);
        expect(actual[word]).toBeCloseTo(expected, 5);
      }
    }
    await expect(engine.step({ tokens: [5], signal: undefined })).rejects.toThrow('Invalid tokens');
    expect(engine.processedTokens).toBe(66);
  });

  it('supports explicit F16 persistent state and finite window attention', async () => {
    const bytes = createPositionSensitiveGguf({ chatTemplate: 'chatml' });
    const { inventory, locations } = combineModelGraphGgufs({ files: [inspectModelGraphGguf({ source: sourceFromBytes({ bytes }), signal: undefined })] });
    const definition = llamaGraphFixture();
    definition.state.slots[0]!.precision = 'F16';
    for (const node of definition.graph.nodes) {
      if (node.op === 'attentionCached') {
        node.window = 2;
      }
    }
    const engine = await createModelGraphEngine({ core, definition, inventory, locations, contextSize: 128, batchSize: 8, backend: 'cpu', threads: 1, maximumScratchBytes: 65536, signal: undefined, onWeightProgress: undefined });
    await using _engine = {
      async [Symbol.asyncDispose]() {
        await engine.close();
      },
    };
    await engine.step({ tokens: [68, 69, 68], signal: undefined });
    const actual = new Float32Array(core.bytes({ pointer: engine.logitsPointer, length: 259 * 4 }).slice().buffer);
    expect(actual.every(Number.isFinite)).toBe(true);
    await engine.step({ tokens: [69], signal: undefined });
    expect(engine.processedTokens).toBe(4);
  });

  it('creates metadata-only vocabulary bytes without tensor payloads', () => {
    const bytes = createPositionSensitiveGguf({ chatTemplate: 'chatml' });
    const gguf = inspectModelGraphGguf({ source: sourceFromBytes({ bytes }), signal: undefined });
    const metadata = copyModelGraphVocabularyMetadata({ gguf, signal: undefined });
    expect(new DataView(metadata.buffer).getBigUint64(8, true)).toBe(0n);
    expect(metadata.length).toBeLessThan(bytes.length / 2);
    expect(inspectModelGraphGguf({ source: sourceFromBytes({ bytes: metadata }), signal: undefined }).inventory.vocabularySize).toBe(259);
  });

  it('rejects truncation, unsupported encodings and unsafe counts before native allocation', () => {
    const bytes = createPositionSensitiveGguf({ chatTemplate: 'chatml' });
    expect(() => inspectModelGraphGguf({ source: sourceFromBytes({ bytes: bytes.subarray(0, bytes.length - 1) }), signal: undefined })).toThrow('beyond');
    const invalid = bytes.slice();
    new DataView(invalid.buffer).setBigUint64(8, (1n << 64n) - 1n, true);
    expect(() => inspectModelGraphGguf({ source: sourceFromBytes({ bytes: invalid }), signal: undefined })).toThrow('Unsafe');
    const header = bytes.slice(0, 23);
    expect(() => inspectModelGraphGguf({ source: sourceFromBytes({ bytes: header }), signal: undefined })).toThrow();
  });
});
