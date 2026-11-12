// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, expect, it } from 'vitest';
import { createCore, type Core } from '@/features/llama-cpp-browser/runtime/core';
import { createModelGraphEngine } from './engine';
import { modelGraphFormat, parseModelGraphDefinitions } from './definition';

let core: Core;

beforeAll(async () => {
  const baseURL = pathToFileURL(path.resolve('node_modules/llama-cpp-browser-core/llama-cpp-browser-core/profiles') + '/');
  core = await createCore({ profile: 'cpu-wasm32', baseURL, moduleOptions: { wasmBinary: await readFile(new URL('cpu-wasm32/browser/core.wasm', baseURL)), print() {}, printErr() {} } });
  await core.api.llama_backend_init();
});

it('owns distinct state per iteration while carrying graph edges and reusing a native graph', async () => {
  const definition = parseModelGraphDefinitions({
    input: JSON.stringify({
      format: modelGraphFormat,
      name: 'Repeated recurrent cells',
      applicability: { architecture: 'scoped-fixture', metadata: [] },
      requiredCapabilities: ['tensor-graph/v1', 'tensor-operators/v2', 'persistent-state/v1', 'scoped-declarations/v1'],
      parameters: [],
      weights: [],
      state: { profile: 'decoder-state/v2', slots: [], tensors: [], updates: [] },
      graph: {
        nodes: [
          { id: 'zero', op: 'tensor', operator: 'constant', inputs: [], attributes: { shape: [2, 1], values: [0] } },
          {
            id: 'cells',
            op: 'repeat',
            index: 'cell',
            count: 3,
            capture: {},
            carry: { sum: { initial: 'zero', next: 'sum' } },
            body: {
              weights: [],
              slots: [],
              tensors: [{ id: 'value', shape: [2, 1], precision: 'F32', initial: 'zeros' }],
              updates: [{ slot: 'value', value: 'next' }],
              nodes: [
                { id: 'old', op: 'stateRead', slot: 'value' },
                { id: 'delta', op: 'tensor', operator: 'constant', inputs: [], attributes: { shape: [2, 1], values: [{ sum: [{ iteration: 'cell' }, 1] }] } },
                { id: 'next', op: 'add', left: 'old', right: 'delta' },
                { id: 'sum', op: 'add', left: { carry: 'sum' }, right: 'next' },
              ],
            },
            outputs: { total: { carry: 'sum' } },
          },
        ],
      },
      outputs: { logits: { output: { block: 'cells', port: 'total' } } },
    }),
  })[0]!.definition;
  const engine = await createModelGraphEngine({
    core,
    definition,
    inventory: { architecture: 'scoped-fixture', vocabularySize: 2, metadata: new Map(), tensors: new Map() },
    locations: new Map(),
    contextSize: 128,
    batchSize: 32,
    backend: 'cpu',
    threads: 1,
    maximumScratchBytes: 1024 * 1024,
    signal: undefined,
    onWeightProgress: undefined,
  });
  await using _owner = {
    async [Symbol.asyncDispose]() {
      await engine.close();
    },
  };
  const logits = (): number[] => {
    const data = core.bytes({ pointer: engine.logitsPointer, length: 8 });
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return [view.getFloat32(0, true), view.getFloat32(4, true)];
  };
  expect((await engine.step({ tokens: [0], signal: undefined })).builds).toBe(1);
  expect(logits()).toEqual([6, 6]);
  expect((await engine.step({ tokens: [1], signal: undefined })).reuseHits).toBe(1);
  expect(logits()).toEqual([12, 12]);
  expect(await engine.step({ tokens: [0, 1, 0], signal: undefined })).toMatchObject({ reuseHits: 3, computeCalls: 3 });
  expect(logits()).toEqual([30, 30]);
  await engine.reset();
  await engine.step({ tokens: [0], signal: undefined });
  expect(logits()).toEqual([6, 6]);
});
