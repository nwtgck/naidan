// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCore, type Core } from '@/features/llama-cpp-browser/runtime/core';
import { createModelGraphEngine } from './engine';
import { smallRicursiveFixture } from './ricursive-runtime.test-support';

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
});
