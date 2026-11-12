// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createCore, type Core } from '@/features/llama-cpp-browser/runtime/core';
import { createModelGraphEngine } from './engine';
import { constantNode, tensorDefinition } from './tensor-runtime.test-support';
import { checkModelGraphAddressWidth } from './memory-budget';
import type { ModelGraphNode } from './definition';
import { smallRicursiveFixture } from './ricursive-runtime.test-support';

/** Small real CPU tensors exercise the native allocator. Large model tests in
 * memory-budget.test.ts only expand descriptors and never allocate 65B weights. */
describe('measured graph allocations on real CPU Wasm', () => {
  let core: Core;

  beforeAll(async () => {
    const baseURL = pathToFileURL(path.resolve('node_modules/llama-cpp-browser-core/llama-cpp-browser-core/profiles') + '/');
    core = await createCore({ profile: 'cpu-wasm32', baseURL, moduleOptions: { wasmBinary: await readFile(new URL('cpu-wasm32/browser/core.wasm', baseURL)), print() {}, printErr() {} } });
    await core.api.llama_backend_init();
  });

  async function fixture({ nodes, vocabulary, maximumBytes }: { nodes: ModelGraphNode[]; vocabulary: number; maximumBytes: number }) {
    const { definition, inventory } = tensorDefinition({ nodes, vocabulary, state: undefined });
    const engine = await createModelGraphEngine({ core, definition, inventory, locations: new Map(), contextSize: 128, batchSize: 4, backend: 'cpu', threads: 1, maximumScratchBytes: maximumBytes, signal: undefined, onWeightProgress: undefined });
    return {
      engine,
      read(): number[] {
        const bytes = core.bytes({ pointer: engine.logitsPointer, length: vocabulary * 4 });
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return Array.from({ length: vocabulary }, (_, index) => view.getFloat32(index * 4, true));
      },
      async [Symbol.asyncDispose]() {
        await engine.close();
      },
    };
  }
  const smallNodes = (): ModelGraphNode[] => [constantNode({ id: 'source', shape: [4, 1], values: [1, 2, 3, 4] }), { id: 'result', op: 'scale', input: 'source', value: 2 }];

  it('fits hundreds of sequential activations and views into a small measured budget, then reuses the allocated graph', async () => {
    const nodes: ModelGraphNode[] = [constantNode({ id: 'source', shape: [16, 1], values: Array(16).fill(2) as number[] })];
    let input = 'source';
    for (let index = 0; index < 400; index++) {
      const id = `layer${index}`;
      nodes.push({ id, op: 'scale', input, value: 1 }, { id: `${id}view`, op: 'reshape', input: id, shape: [16, 1] });
      input = `${id}view`;
    }
    using measured = vi.spyOn(core.api, 'ggml_backend_sched_reserve_size');
    using allocate = vi.spyOn(core.api, 'ggml_backend_sched_alloc_graph');
    await using test = await fixture({ nodes, vocabulary: 16, maximumBytes: 4096 });
    await test.engine.step({ tokens: [0], signal: undefined });
    expect(test.read()).toEqual(Array(16).fill(2));
    expect(measured).toHaveBeenCalledOnce();
    expect(allocate).toHaveBeenCalledOnce();
    expect((await test.engine.step({ tokens: [1], signal: undefined })).graphReused).toBe(true);
    expect(test.read()).toEqual(Array(16).fill(2));
    expect(measured).toHaveBeenCalledOnce();
    await test.engine.reset();
    await test.engine.step({ tokens: [0], signal: undefined });
    expect(test.read()).toEqual(Array(16).fill(2));
    expect(measured).toHaveBeenCalledOnce();
  });

  it('rejects truly retained constants before reserving compute buffers or executing', async () => {
    const nodes: ModelGraphNode[] = [];
    let input = '';
    for (let index = 0; index < 32; index++) {
      const id = `weight${index}`;
      nodes.push(constantNode({ id, shape: [1024, 1], values: Array(1024).fill(1) as number[] }));
      if (input) {
        nodes.push({ id: `sum${index}`, op: 'add', left: input, right: id });
        input = `sum${index}`;
      } else {
        input = id;
      }
    }
    using reserve = vi.spyOn(core.api, 'ggml_backend_sched_reserve');
    using allocate = vi.spyOn(core.api, 'ggml_backend_sched_alloc_graph');
    using execute = vi.spyOn(core.api, 'ggml_backend_sched_graph_compute');
    await using test = await fixture({ nodes, vocabulary: 1024, maximumBytes: 8192 });
    await expect(test.engine.step({ tokens: [0], signal: undefined })).rejects.toThrow(/Graph allocation budget exceeded: persistent state 0 bytes \+ compute buffers \d+ bytes.*limit 8192 bytes/);
    expect(reserve).not.toHaveBeenCalled();
    expect(allocate).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await expect(test.engine.step({ tokens: [0], signal: undefined })).rejects.toThrow();
  });

  it('includes retained larger scheduler buffers even when the next measurement is smaller', async () => {
    using retained = vi.spyOn(core.api, 'ggml_backend_sched_get_buffer_size').mockResolvedValue(8193n);
    using reserve = vi.spyOn(core.api, 'ggml_backend_sched_reserve');
    await using test = await fixture({ nodes: smallNodes(), vocabulary: 4, maximumBytes: 8192 });
    await expect(test.engine.step({ tokens: [0], signal: undefined })).rejects.toThrow('compute buffers 8193 bytes');
    expect(retained).toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('verifies materialized sizes again before any computation', async () => {
    const original = core.api.ggml_backend_sched_get_buffer_size;
    using retained = vi.spyOn(core.api, 'ggml_backend_sched_get_buffer_size').mockImplementationOnce(original).mockResolvedValueOnce(8193n);
    using execute = vi.spyOn(core.api, 'ggml_backend_sched_graph_compute');
    await using test = await fixture({ nodes: smallNodes(), vocabulary: 4, maximumBytes: 8192 });
    await expect(test.engine.step({ tokens: [0], signal: undefined })).rejects.toThrow('compute buffers 8193 bytes');
    expect(retained).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['reserve', 'allocate'] as const)('closes and retires the graph if native %s fails', async point => {
    const name = point === 'reserve' ? 'ggml_backend_sched_reserve' : 'ggml_backend_sched_alloc_graph';
    using failed = vi.spyOn(core.api, name).mockResolvedValue(0);
    using execute = vi.spyOn(core.api, 'ggml_backend_sched_graph_compute');
    await using test = await fixture({ nodes: smallNodes(), vocabulary: 4, maximumBytes: 8192 });
    await expect(test.engine.step({ tokens: [0], signal: undefined })).rejects.toThrow('Registered graph backend');
    expect(failed).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    await expect(test.engine.reset()).rejects.toThrow();
  });

  it('restores temporary split sources and optimized metadata before each native split', async () => {
    const measure = core.api.ggml_backend_sched_reserve_size;
    const reserve = core.api.ggml_backend_sched_reserve;
    const allocate = core.api.ggml_backend_sched_alloc_graph;
    let pointer = 0n;
    let original: Uint8Array | undefined;
    const check = () => {
      expect(original).toBeDefined();
      expect(core.bytes({ pointer, length: original!.length }).slice()).toEqual(original);
    };
    const poison = () => {
      const field = core.fieldLayout({ name: 'ggml_tensor', field: 'src' });
      core.bytes({ pointer: pointer + field.offset, length: core.pointerBytes }).fill(0x7f);
    };
    using measuring = vi.spyOn(core.api, 'ggml_backend_sched_reserve_size').mockImplementation(async (scheduler, graph, sizes) => {
      pointer = await core.api.ggml_graph_node(graph, 0);
      original = core.bytes({ pointer, length: core.recordSize({ name: 'ggml_tensor' }) }).slice();
      await measure(scheduler, graph, sizes);
      // Simulate a cross-backend split's borrowed source. No native call is
      // allowed to dereference this marker; the adapter must restore first.
      poison();
    });
    using reserving = vi.spyOn(core.api, 'ggml_backend_sched_reserve').mockImplementation(async (scheduler, graph) => {
      check();
      const result = await reserve(scheduler, graph);
      poison();
      return result;
    });
    using allocating = vi.spyOn(core.api, 'ggml_backend_sched_alloc_graph').mockImplementation(async (scheduler, graph) => {
      check();
      return allocate(scheduler, graph);
    });
    await using test = await fixture({ nodes: smallNodes(), vocabulary: 4, maximumBytes: 8192 });
    await test.engine.step({ tokens: [0], signal: undefined });
    expect(test.read()).toEqual([2, 4, 6, 8]);
    expect(measuring).toHaveBeenCalledOnce();
    expect(reserving).toHaveBeenCalledOnce();
    expect(allocating).toHaveBeenCalledOnce();
  });

  it.each(['measure', 'allocate'] as const)('rejects a persistent write that changes backend during %s', async phase => {
    const original = core.api.ggml_backend_sched_get_tensor_backend;
    let calls = 0;
    using placement = vi.spyOn(core.api, 'ggml_backend_sched_get_tensor_backend').mockImplementation(async (scheduler, tensor) => {
      calls++;
      if (phase === 'measure' || calls > 10) {
        return 0n;
      }
      return original(scheduler, tensor);
    });
    using execute = vi.spyOn(core.api, 'ggml_backend_sched_graph_compute');
    const { definition, inventory, locations } = smallRicursiveFixture({ precision: 'F16' });
    const engine = await createModelGraphEngine({ core, definition, inventory, locations, contextSize: 128, batchSize: 4, backend: 'cpu', threads: 1, maximumScratchBytes: 1024 * 1024, signal: undefined, onWeightProgress: undefined });
    await using _engine = {
      async [Symbol.asyncDispose]() {
        await engine.close();
      },
    };
    await expect(engine.step({ tokens: [1], signal: undefined })).rejects.toThrow('changed the persistent state backend');
    expect(placement).toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('checks cancellation between measurement and allocation', async () => {
    const controller = new AbortController(), measure = core.api.ggml_backend_sched_reserve_size;
    using measured = vi.spyOn(core.api, 'ggml_backend_sched_reserve_size').mockImplementation(async (scheduler, graph, sizes) => {
      await measure(scheduler, graph, sizes);
      controller.abort();
    });
    using reserve = vi.spyOn(core.api, 'ggml_backend_sched_reserve');
    await using test = await fixture({ nodes: smallNodes(), vocabulary: 4, maximumBytes: 8192 });
    await expect(test.engine.step({ tokens: [0], signal: controller.signal })).rejects.toThrow();
    expect(measured).toHaveBeenCalledOnce();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('rejects address-width overflow before creating any tensor descriptors', () => {
    expect(() => checkModelGraphAddressWidth({ pointerBytes: 4, largestTensorBytes: 2 ** 32, stateBytes: 0 })).toThrow('32-bit');
    expect(() => checkModelGraphAddressWidth({ pointerBytes: 4, largestTensorBytes: 1024, stateBytes: 2 ** 32 })).toThrow('32-bit');
    expect(() => checkModelGraphAddressWidth({ pointerBytes: 8, largestTensorBytes: 2 ** 32, stateBytes: 10 * 1024 ** 3 })).not.toThrow();
    expect(() => checkModelGraphAddressWidth({ pointerBytes: 4, largestTensorBytes: 1024, stateBytes: 1024 })).not.toThrow();
  });
});
