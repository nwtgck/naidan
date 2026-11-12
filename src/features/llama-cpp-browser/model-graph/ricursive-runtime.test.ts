// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCore, type Core } from '@/features/llama-cpp-browser/runtime/core';
import { createModelGraphEngine } from './engine';
import { smallRicursiveFixture, smallReviewedRicursiveFixture } from './ricursive-runtime.test-support';

describe('scaled user Ricursive declaration on real CPU Wasm', () => {
  let core: Core;

  beforeAll(async () => {
    const baseURL = pathToFileURL(path.resolve('node_modules/llama-cpp-browser-core/llama-cpp-browser-core/profiles') + '/');
    core = await createCore({ profile: 'cpu-wasm32', baseURL, moduleOptions: { wasmBinary: await readFile(new URL('cpu-wasm32/browser/core.wasm', baseURL)), print() {}, printErr() {} } });
    await core.api.llama_backend_init();
  });

  it.each(['F32', 'F16'] as const)('matches independent scalar equations with %s cache across prefill, sliding/full attention, reuse, growth and reset', async precision => {
    const { definition, inventory, locations, reference } = smallRicursiveFixture({ precision });
    const engine = await createModelGraphEngine({ core, definition, inventory, locations, contextSize: 128, batchSize: 64, backend: 'cpu', threads: 1, maximumScratchBytes: 1024 * 1024, signal: undefined, onWeightProgress: undefined });
    await using _owner = {
      async [Symbol.asyncDispose]() {
        await engine.close();
      },
    };
    const batches = [[1, 2, 3], [4], [5], Array.from({ length: 60 }, (_, i) => i % 24), [6]];
    const read = () => {
      const bytes = core.bytes({ pointer: engine.logitsPointer, length: inventory.vocabularySize * 4 });
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return Array.from({ length: inventory.vocabularySize }, (_, index) => view.getFloat32(index * 4, true));
    };
    for (const tokens of batches) {
      let expected: number[] = [];
      for (const token of tokens) {
        expected = reference.step({ token });
      }
      await engine.step({ tokens, signal: undefined });
      const actual = read();
      expect(actual.every(Number.isFinite)).toBe(true);
      expect(Math.max(...actual.map((x, i) => Math.abs(x - expected[i]!)))).toBeLessThan(0.002);
    }
    await engine.reset();
    reference.reset();
    const expected = reference.step({ token: 1 });
    await engine.step({ tokens: [1], signal: undefined });
    expect(Math.max(...read().map((x, i) => Math.abs(x - expected[i]!)))).toBeLessThan(0.002);
  });

  const forms = [
    { name: 'scalar', clamp: 0.2, embeddingScale: 4, swaBase: undefined },
    { name: 'uniform vector', clamp: [0.2, 0.2, 0.2, 0.2, 0.2], embeddingScale: 4, swaBase: undefined },
    { name: 'mixed disabled/enabled layers and alternate RoPE base', clamp: [0, 0.3, 0, 0.2, 0.7], embeddingScale: 4, swaBase: 200 },
    { name: 'zero clamp and zero embedding scale', clamp: 0, embeddingScale: 0, swaBase: undefined },
    { name: 'missing optional metadata', clamp: undefined, embeddingScale: undefined, swaBase: undefined },
  ];

  it.each(forms.flatMap(form => (['F32', 'F16'] as const).map(precision => ({ ...form, precision }))))('matches scalar reference for $name with $precision cache', async ({ precision, clamp, embeddingScale, swaBase }) => {
    const { definition, inventory, locations, reference } = smallReviewedRicursiveFixture({ precision, clamp, embeddingScale, swaBase });
    const engine = await createModelGraphEngine({ core, definition, inventory, locations, contextSize: 128, batchSize: 64, backend: 'cpu', threads: 1, maximumScratchBytes: 1024 * 1024, signal: undefined, onWeightProgress: undefined });
    await using _owner = {
      async [Symbol.asyncDispose]() {
        await engine.close();
      },
    };
    const read = () => {
      const bytes = core.bytes({ pointer: engine.logitsPointer, length: inventory.vocabularySize * 4 });
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return Array.from({ length: inventory.vocabularySize }, (_, i) => view.getFloat32(i * 4, true));
    };
    for (const tokens of [[1, 2, 3], [4], [5], Array.from({ length: 60 }, (_, i) => i % 24), [6]]) {
      let expected: number[] = [];
      for (const token of tokens) {
        expected = reference.step({ token });
      }
      await engine.step({ tokens, signal: undefined });
      expect(Math.max(...read().map((value, i) => Math.abs(value - expected[i]!)))).toBeLessThan(0.002);
    }
    await engine.reset();
    reference.reset();
    const expected = reference.step({ token: 1 });
    await engine.step({ tokens: [1], signal: undefined });
    expect(Math.max(...read().map((value, i) => Math.abs(value - expected[i]!)))).toBeLessThan(0.002);
  });
});
