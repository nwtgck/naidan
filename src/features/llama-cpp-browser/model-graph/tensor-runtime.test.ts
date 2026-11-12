// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createCore, type Core } from '@/features/llama-cpp-browser/runtime/core';
import { tensorEngineFixture, tensorNode, constantNode, tensorDefinition } from './tensor-runtime.test-support';
import { compileModelGraph } from './compile';
import { bindTensorOperator, tensorOperatorNames, type TensorOperatorName } from './operators';
import { graphStorageFormats, graphWeightTypes } from './tensor-layout';
import type { ModelGraphNode } from './definition';

describe('generic graph operators and state on real CPU Wasm', () => {
  let core: Core;

  beforeAll(async () => {
    const baseURL = pathToFileURL(path.resolve('node_modules/llama-cpp-browser-core/llama-cpp-browser-core/profiles') + '/');
    core = await createCore({
      profile: 'cpu-wasm32',
      baseURL,
      moduleOptions: { wasmBinary: await readFile(new URL('cpu-wasm32/browser/core.wasm', baseURL)), print() {}, printErr() {} },
    });
    await core.api.llama_backend_init();
  });

  const unary: { operator: TensorOperatorName; attributes: Record<string, unknown>; expected: (value: number) => number }[] = [
    { operator: 'silu', attributes: {}, expected: x => x / (1 + Math.exp(-x)) },
    { operator: 'sigmoid', attributes: {}, expected: x => 1 / (1 + Math.exp(-x)) },
    { operator: 'relu', attributes: {}, expected: x => Math.max(0, x) },
    { operator: 'tanh', attributes: {}, expected: Math.tanh },
    { operator: 'abs', attributes: {}, expected: Math.abs },
    { operator: 'negate', attributes: {}, expected: x => -x },
    { operator: 'square', attributes: {}, expected: x => x * x },
    { operator: 'sqrt', attributes: {}, expected: Math.sqrt },
    { operator: 'log', attributes: {}, expected: Math.log },
    { operator: 'exp', attributes: {}, expected: Math.exp },
    { operator: 'softplus', attributes: {}, expected: x => Math.log1p(Math.exp(x)) },
    { operator: 'scale', attributes: { scale: 2, bias: -1 }, expected: x => 2 * x - 1 },
    { operator: 'clamp', attributes: { minimum: 0.75, maximum: 2.5 }, expected: x => Math.max(0.75, Math.min(2.5, x)) },
    { operator: 'gelu', attributes: {}, expected: x => 0.5 * x * (1 + Math.tanh(Math.sqrt(2 / Math.PI) * (x + 0.044715 * x ** 3))) },
  ];

  it.each(unary)('executes $operator through its reviewed catalog entry', async ({ operator, attributes, expected }) => {
    const values = [0.25, 0.5, 1, 2];
    await using fixture = await tensorEngineFixture({
      core,
      vocabulary: 4,
      state: undefined,
      nodes: [constantNode({ id: 'source', shape: [4, 1], values }), tensorNode({ id: 'result', operator, inputs: ['source'], attributes })],
    });
    await fixture.engine.step({ tokens: [0], signal: undefined });
    fixture.read().forEach((value, index) => expect(value).toBeCloseTo(expected(values[index]!), operator === 'gelu' ? 3 : 4));
    expect((await fixture.engine.step({ tokens: [1], signal: undefined })).graphReused).toBe(true);
    fixture.read().forEach((value, index) => expect(value).toBeCloseTo(expected(values[index]!), operator === 'gelu' ? 3 : 4));
  });

  it('uses actual asymmetric clamped SwiGLU, not an approximate symmetric gate clamp', async () => {
    const gate = [-8, -1, 2, 8], up = [7, -7, 1, 2], limit = 3;
    await using fixture = await tensorEngineFixture({
      core,
      vocabulary: 4,
      state: undefined,
      nodes: [
        constantNode({ id: 'gate', shape: [4, 1], values: gate }), constantNode({ id: 'up', shape: [4, 1], values: up }),
        tensorNode({ id: 'logits', operator: 'swigluClamped', inputs: ['gate', 'up'], attributes: { limit } }),
      ],
    });
    await fixture.engine.step({ tokens: [0], signal: undefined });
    fixture.read().forEach((actual, i) => {
      const clipped = Math.min(gate[i]!, limit);
      expect(actual).toBeCloseTo(clipped / (1 + Math.exp(-clipped)) * Math.max(-limit, Math.min(limit, up[i]!)), 5);
    });
  });

  it.each(['F16', 'BF16'] as const)('casts %s explicitly and checks actual native storage metadata', async type => {
    await using fixture = await tensorEngineFixture({
      core,
      vocabulary: 4,
      state: undefined,
      nodes: [
        constantNode({ id: 'source', shape: [4, 1], values: [1, -2, 0.5, 4] }),
        tensorNode({ id: 'encoded', operator: 'cast', inputs: ['source'], attributes: { type } }),
        tensorNode({ id: 'logits', operator: 'cast', inputs: ['encoded'], attributes: { type: 'F32' } }),
      ],
    });
    await fixture.engine.step({ tokens: [0], signal: undefined });
    expect(fixture.read()).toEqual([1, -2, 0.5, 4]);
  });

  it('compares every advertised weight storage format against the installed native ABI', async () => {
    for (const type of graphWeightTypes) {
      const actual = core.constant({ name: `GGML_TYPE_${type}` }), expected = graphStorageFormats[type];
      expect(actual).toBe(expected.code);
      expect(await core.api.ggml_blck_size(actual)).toBe(BigInt(expected.block));
      expect(await core.api.ggml_type_size(actual)).toBe(BigInt(expected.bytes));
    }
    expect(new Set(tensorOperatorNames).size).toBe(tensorOperatorNames.length);
  });

  it('materializes transposed data and slices before native elementwise computation', async () => {
    await using fixture = await tensorEngineFixture({
      core,
      vocabulary: 4,
      state: undefined,
      nodes: [
        constantNode({ id: 'source', shape: [2, 3], values: [1, 2, 3, 4, 5, 6] }),
        tensorNode({ id: 'transposed', operator: 'transpose', inputs: ['source'], attributes: {} }),
        tensorNode({ id: 'copied', operator: 'contiguous', inputs: ['transposed'], attributes: {} }),
        tensorNode({ id: 'slice', operator: 'slice', inputs: ['copied'], attributes: { axis: 0, start: 1, length: 2 } }),
        tensorNode({ id: 'contiguous', operator: 'contiguous', inputs: ['slice'], attributes: {} }),
        tensorNode({ id: 'logits', operator: 'reshape', inputs: ['contiguous'], attributes: { shape: [4, 1] } }),
      ],
    });
    await fixture.engine.step({ tokens: [0], signal: undefined });
    expect(fixture.read()).toEqual([3, 5, 4, 6]);
  });

  it('rejects layouts and forged integer-bound casts before native graph creation', () => {
    const strided = { shape: [2, 2], type: 'F32' as const, layout: 'strided' as const, indices: undefined };
    for (const operator of ['scale', 'clamp', 'silu', 'topK', 'cast', 'reshape'] as const) {
      const attributes = { scale: { scale: 1, bias: 0 }, clamp: { minimum: 0, maximum: 1 }, silu: {}, topK: { count: 1 }, cast: { type: 'F16' }, reshape: { shape: [4] } }[operator];
      expect(() => bindTensorOperator({ node: { id: 'x', op: 'tensor', operator, inputs: ['a'], attributes }, inputs: [strided], number: () => 1 })).toThrow();
    }
    const source = constantNode({ id: 'source', shape: [2, 1], values: [0, 1] });
    const bad = tensorDefinition({ vocabulary: 2, state: undefined, nodes: [source, tensorNode({ id: 'bad', operator: 'cast', inputs: ['source'], attributes: { type: 'F32' } })] });
    const node = bad.definition.graph.nodes[1]!;
    expect(() => bindTensorOperator({ node: { id: 'bad', op: 'tensor', operator: 'cast', inputs: ['source'], attributes: { type: 'I32' } }, inputs: [{ ...strided, layout: 'contiguous' }], number: () => 1 })).toThrow();
    expect(node.op).toBe('tensor');
  });

  it('uses native top-K index bounds with NaN and infinities without a float-to-index cast', async () => {
    // Division computes non-finite data in Wasm. These are not JSON literals or
    // test-only injected index buffers. Native top-K produces index values.
    await using fixture = await tensorEngineFixture({
      core,
      vocabulary: 3,
      state: undefined,
      nodes: [
        constantNode({ id: 'values', shape: [6, 1], values: [0, 1, -1, 3, 2, -5] }),
        constantNode({ id: 'zero', shape: [6, 1], values: [0] }),
        tensorNode({ id: 'nonfinite', operator: 'divide', inputs: ['values', 'zero'], attributes: {} }),
        tensorNode({ id: 'selected', operator: 'topK', inputs: ['nonfinite'], attributes: { count: 3 } }),
        constantNode({ id: 'table', shape: [1, 6], values: [10, 20, 30, 40, 50, 60] }),
        tensorNode({ id: 'rows', operator: 'gatherRows', inputs: ['table', 'selected'], attributes: {} }),
        tensorNode({ id: 'logits', operator: 'reshape', inputs: ['rows'], attributes: { shape: [3, 1] } }),
      ],
    });
    for (let i = 0; i < 8; i++) {
      await fixture.engine.step({ tokens: [0], signal: undefined });
      const values = fixture.read();
      expect(new Set(values).size).toBe(3);
      expect(values.every(value => [10, 20, 30, 40, 50, 60].includes(value))).toBe(true);
    }
  });

  it('gathers expert matrices using an intrinsically bounded constant index list', async () => {
    await using fixture = await tensorEngineFixture({
      core,
      vocabulary: 4,
      state: undefined,
      nodes: [
        constantNode({ id: 'weights', shape: [2, 2, 2], values: [1, 0, 0, 1, 2, 0, 0, 3] }),
        constantNode({ id: 'input', shape: [2, 1, 1], values: [5, 7] }),
        tensorNode({ id: 'ids', operator: 'indexList', inputs: [], attributes: { shape: [2, 1], values: [1, 0] } }),
        tensorNode({ id: 'result', operator: 'matmulIndexed', inputs: ['weights', 'input', 'ids'], attributes: {} }),
        tensorNode({ id: 'logits', operator: 'reshape', inputs: ['result'], attributes: { shape: [4, 1] } }),
      ],
    });
    await fixture.engine.step({ tokens: [0], signal: undefined });
    expect(fixture.read()).toEqual([10, 21, 5, 7]);
  });

  it('provides checked token/position inputs without architecture-specific embedding code', async () => {
    await using fixture = await tensorEngineFixture({
      core,
      vocabulary: 2,
      state: undefined,
      nodes: [
        constantNode({ id: 'embedding', shape: [2, 2], values: [1, 2, 3, 4] }),
        { id: 'tokenIds', op: 'input', source: 'tokenIds' },
        { id: 'positions', op: 'input', source: 'positionsF32' },
        tensorNode({ id: 'words', operator: 'gatherRows', inputs: ['embedding', 'tokenIds'], attributes: {} }),
        tensorNode({ id: 'columns', operator: 'reshape', inputs: ['positions'], attributes: { shape: [1, { inputTokens: true }] } }),
        tensorNode({ id: 'logits', operator: 'add', inputs: ['words', 'columns'], attributes: {} }),
      ],
    });
    await fixture.engine.step({ tokens: [0, 1], signal: undefined });
    expect(fixture.read()).toEqual([4, 5]);
    await fixture.engine.step({ tokens: [0], signal: undefined });
    expect(fixture.read()).toEqual([3, 4]);
    await fixture.engine.reset();
    await fixture.engine.step({ tokens: [1], signal: undefined });
    expect(fixture.read()).toEqual([3, 4]);
  });

  const recurrentNodes = (): ModelGraphNode[] => [
    { id: 'oldA', op: 'stateRead', slot: 'a' }, { id: 'oldB', op: 'stateRead', slot: 'b' },
    constantNode({ id: 'one', shape: [2, 1], values: [1] }),
    tensorNode({ id: 'newA', operator: 'add', inputs: ['oldB', 'one'], attributes: {} }),
    tensorNode({ id: 'newB', operator: 'scale', inputs: ['oldA'], attributes: { scale: 1, bias: 2 } }),
    tensorNode({ id: 'logits', operator: 'add', inputs: ['newA', 'newB'], attributes: {} }),
  ];

  it('applies simultaneous state updates, preserves token order across batches and resets state', async () => {
    const state = {
      profile: 'decoder-state/v2' as const,
      slots: [],
      tensors: [{ id: 'a', shape: [2, 1], precision: 'F32' as const, initial: 'zeros' as const }, { id: 'b', shape: [2, 1], precision: 'F32' as const, initial: 'zeros' as const }],
      updates: [{ slot: 'a', value: 'newA' }, { slot: 'b', value: 'newB' }],
    };
    await using fixture = await tensorEngineFixture({ core, vocabulary: 2, state, nodes: recurrentNodes() });
    const first = await fixture.engine.step({ tokens: [0], signal: undefined });
    expect(fixture.read()).toEqual([3, 3]);
    expect(first.graphReused).toBe(false);
    expect(first).toMatchObject({ builds: 1, reuseHits: 0, computeCalls: 1, maximumBatchTokens: 1 });
    expect((await fixture.engine.step({ tokens: [1], signal: undefined })).graphReused).toBe(true);
    expect(fixture.read()).toEqual([6, 6]);
    const recurrentBatch = await fixture.engine.step({ tokens: [0, 1, 0], signal: undefined });
    expect(recurrentBatch).toMatchObject({ builds: 0, reuseHits: 3, computeCalls: 3, maximumBatchTokens: 1 });
    expect(fixture.read()).toEqual([15, 15]);
    expect(fixture.engine.processedTokens).toBe(5);
    await fixture.engine.reset();
    await fixture.engine.step({ tokens: [0, 1, 0, 1, 0], signal: undefined });
    expect(fixture.read()).toEqual([15, 15]);
  });

  it('poisons partially applied state after a native-copy failure and preserves idempotent release', async () => {
    const state = {
      profile: 'decoder-state/v2' as const,
      slots: [],
      tensors: [
        { id: 'a', shape: [2, 1], precision: 'F32' as const, initial: 'zeros' as const }, { id: 'b', shape: [2, 1], precision: 'F32' as const, initial: 'zeros' as const },
      ],
      updates: [{ slot: 'a', value: 'newA' }, { slot: 'b', value: 'newB' }],
    };
    await using fixture = await tensorEngineFixture({ core, vocabulary: 2, state, nodes: recurrentNodes() });
    const original = core.api.ggml_backend_tensor_copy;
    let copies = 0;
    using _copy = vi.spyOn(core.api, 'ggml_backend_tensor_copy').mockImplementation(async (...args) => {
      if (++copies === 2) {
        throw new Error('test copy rejected');
      }
      return original(...args);
    });
    await expect(fixture.engine.step({ tokens: [0, 1], signal: undefined })).rejects.toThrow('copy rejected');
    expect(copies).toBe(2);
    expect(() => fixture.engine.logitsPointer).toThrow();
    await expect(fixture.engine.reset()).rejects.toThrow('not reusable');
    await expect(fixture.engine.step({ tokens: [0], signal: undefined })).rejects.toThrow('not available');
    await fixture.engine.close();
  });

  it('rejects state updates with the wrong type, shape or incomplete writer set', () => {
    const base = tensorDefinition({
      vocabulary: 2,
      nodes: recurrentNodes(),
      state: {
        profile: 'decoder-state/v2',
        slots: [],
        tensors: [{ id: 'a', shape: [2, 1], precision: 'F32', initial: 'zeros' }, { id: 'b', shape: [2, 1], precision: 'F32', initial: 'zeros' }],
        updates: [{ slot: 'a', value: 'newA' }, { slot: 'b', value: 'newB' }],
      },
    });
    base.definition.state.tensors[0]!.precision = 'F16';
    expect(() => compileModelGraph({ ...base, inputTokens: 1, cacheTokens: 64, capacity: 128, maximumScratchBytes: 65536 })).toThrow();
    base.definition.state.updates.pop();
    expect(() => compileModelGraph({ ...base, inputTokens: 1, cacheTokens: 64, capacity: 128, maximumScratchBytes: 65536 })).toThrow('exactly one');
  });

  it('owns constant-only logits across allocation reuse and request reset', async () => {
    await using fixture = await tensorEngineFixture({
      core,
      vocabulary: 4,
      state: undefined,
      nodes: [
        constantNode({ id: 'logits', shape: [4, 1], values: [1, 2, 3, 4] }),
      ],
    });
    await fixture.engine.step({ tokens: [0], signal: undefined });
    expect(fixture.read()).toEqual([1, 2, 3, 4]);
    await fixture.engine.step({ tokens: [1], signal: undefined });
    expect(fixture.read()).toEqual([1, 2, 3, 4]);
    await fixture.engine.reset();
    await fixture.engine.step({ tokens: [2], signal: undefined });
    expect(fixture.read()).toEqual([1, 2, 3, 4]);
  });

  it.each(['norm', 'rmsNorm'] as const)('normalizes F32 rows through %s', async operator => {
    const values = [1, 2, 3, 4], epsilon = 1e-5;
    const mean = operator === 'norm' ? 2.5 : 0;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    await using fixture = await tensorEngineFixture({
      core,
      vocabulary: 4,
      state: undefined,
      nodes: [
        constantNode({ id: 'x', shape: [4, 1], values }),
        tensorNode({ id: 'logits', operator, inputs: ['x'], attributes: { epsilon } }),
      ],
    });
    await fixture.engine.step({ tokens: [0], signal: undefined });
    fixture.read().forEach((value, index) => expect(value).toBeCloseTo((values[index]! - mean) / Math.sqrt(variance + epsilon), 5));
  });

  it('performs ordinary batched matrix multiplication with native leading dimensions', async () => {
    await using fixture = await tensorEngineFixture({
      core,
      vocabulary: 4,
      state: undefined,
      nodes: [
        constantNode({ id: 'a', shape: [2, 2], values: [1, 2, 3, 4] }),
        constantNode({ id: 'b', shape: [2, 2], values: [1, 0, 0, 1] }),
        tensorNode({ id: 'product', operator: 'matmul', inputs: ['a', 'b'], attributes: {} }),
        tensorNode({ id: 'logits', operator: 'reshape', inputs: ['product'], attributes: { shape: [4, 1] } }),
      ],
    });
    await fixture.engine.step({ tokens: [0], signal: undefined });
    expect(fixture.read()).toEqual([1, 3, 2, 4]);
  });

  it('repeats and concatenates tensor rows without aliasing persistent constants', async () => {
    await using fixture = await tensorEngineFixture({
      core,
      vocabulary: 8,
      state: undefined,
      nodes: [
        constantNode({ id: 'a', shape: [2, 1], values: [1, 2] }),
        tensorNode({ id: 'repeated', operator: 'repeat', inputs: ['a'], attributes: { shape: [2, 2] } }),
        constantNode({ id: 'b', shape: [2, 2], values: [3, 4, 5, 6] }),
        tensorNode({ id: 'joined', operator: 'concat', inputs: ['repeated', 'b'], attributes: { axis: 0 } }),
        tensorNode({ id: 'logits', operator: 'reshape', inputs: ['joined'], attributes: { shape: [8, 1] } }),
      ],
    });
    for (const token of [0, 1]) {
      await fixture.engine.step({ tokens: [token], signal: undefined });
      expect(fixture.read()).toEqual([1, 2, 3, 4, 1, 2, 5, 6]);
    }
  });

  it.each([
    { operator: 'sumRows' as const, expected: [3, 7] },
    { operator: 'meanRows' as const, expected: [1.5, 3.5] },
    { operator: 'sum' as const, expected: [10] },
  ])('reduces tensor data with $operator', async ({ operator, expected }) => {
    await using fixture = await tensorEngineFixture({
      core,
      vocabulary: expected.length,
      state: undefined,
      nodes: [
        constantNode({ id: 'source', shape: [2, 2], values: [1, 2, 3, 4] }),
        tensorNode({ id: 'reduced', operator, inputs: ['source'], attributes: {} }),
        tensorNode({ id: 'logits', operator: 'reshape', inputs: ['reduced'], attributes: { shape: [expected.length, 1] } }),
      ],
    });
    await fixture.engine.step({ tokens: [0], signal: undefined });
    expect(fixture.read()).toEqual(expected);
  });

  it.each(['softmax', 'maskedSoftmax'] as const)('normalizes attention probabilities with $operator', async operator => {
    const nodes = [constantNode({ id: 'scores', shape: [4, 1], values: [1, 2, 3, 4] })];
    const masked = operator === 'maskedSoftmax';
    if (masked) {
      nodes.push(constantNode({ id: 'mask', shape: [4, 1], values: [0, 0, -100, -100] }));
    }
    nodes.push(tensorNode({ id: 'logits', operator, inputs: masked ? ['scores', 'mask'] : ['scores'], attributes: masked ? { scale: 0.5, maxBias: 0 } : { scale: 0.5 } }));
    await using fixture = await tensorEngineFixture({ core, vocabulary: 4, state: undefined, nodes });
    await fixture.engine.step({ tokens: [0], signal: undefined });
    const raw = [1, 2, 3, 4].map((value, index) => Math.exp(value * 0.5 + (masked && index > 1 ? -100 : 0)));
    const total = raw.reduce((sum, value) => sum + value, 0);
    fixture.read().forEach((value, index) => expect(value).toBeCloseTo(raw[index]! / total, 5));
  });
});

export const TEST_ONLY = {
};
