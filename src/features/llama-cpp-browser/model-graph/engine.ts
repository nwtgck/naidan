import { allocateModelGraph } from './graph-allocation';
import { checkModelGraphAddressWidth, checkModelGraphMemoryBudget } from './memory-budget';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { compileModelGraph, type ModelGraphInventory, type ModelGraphPlan } from './compile';
import { graphStorageFormats } from './tensor-layout';
import type { ModelGraphDefinition } from './definition';
import { readModelGraphBytes, type ModelGraphByteSource } from './gguf';

export type ModelGraphStepTimings = { graphBuildMs: number, allocationMs: number, inputMs: number, computeMs: number, readbackMs: number, graphReused: boolean, builds: number, reuseHits: number, computeCalls: number, maximumBatchTokens: number };
export type ModelGraphEngine = Awaited<ReturnType<typeof createModelGraphEngine>>;

/** This owner never fabricates a llama_context and never invokes a model-defined
 * callback. The graph is assembled through the generated GGML C ABI and executed
 * entirely by the backend scheduler. There is one live graph allocation per owner. */
export async function createModelGraphEngine({ core, definition, inventory, locations, contextSize, batchSize, backend, threads, maximumScratchBytes, signal, onWeightProgress }: {
  core: Core, definition: ModelGraphDefinition, inventory: ModelGraphInventory,
  locations: ReadonlyMap<string, { source: ModelGraphByteSource, offset: number }>,
  contextSize: number, batchSize: number, backend: 'cpu' | 'webgpu', threads: number,
  maximumScratchBytes: number, signal: AbortSignal | undefined,
  onWeightProgress: (({ loadedBytes, totalBytes }: { loadedBytes: number, totalBytes: number }) => void) | undefined,
}) {
  if (!Number.isInteger(contextSize) || contextSize < 1 || contextSize > 131072 || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2048 || !Number.isInteger(threads) || threads < 1 || threads > 256) {
    throw new Error('Invalid registered graph execution limits');
  }
  const capacity = Math.ceil(contextSize / 64) * 64;
  const initialPlan = compileModelGraph({ definition, inventory, inputTokens: 1, cacheTokens: 64, capacity, maximumScratchBytes });
  checkModelGraphAddressWidth({ pointerBytes: core.pointerBytes, largestTensorBytes: initialPlan.largestTensorBytes, stateBytes: initialPlan.stateBytes });
  const expandedDefinition = initialPlan.definition;
  const api = core.api;
  if (typeof api.ggml_backend_sched_reserve_size !== 'function') {
    throw new Error('The installed core cannot measure registered graph allocation sizes');
  }
  for (const { node } of initialPlan.nodes) {
    switch (node.op) {
    case 'tensor': {
      for (const fn of node.operation.nativeFunctions) {
        if (typeof api[fn] !== 'function') {
          throw new Error(`The installed core lacks the required graph operation: ${fn}`);
        }
      }
      break;
    }
    case 'embedding': case 'linear': case 'normalizeRms': case 'add': case 'subtract': case 'multiply':
    case 'sigmoid': case 'silu': case 'contiguous': case 'scale': case 'reshape': case 'permute':
    case 'rotaryEmbedding': case 'attentionCached': case 'stateRead': case 'input': break;
    default: {
      const exhaustive: never = node;
      throw new Error(String(exhaustive));
    }
    }
  }
  const type = ({ name }: { name: string }): number => core.constant({ name: `GGML_TYPE_${name}` });
  const checked = ({ pointer, operation }: { pointer: bigint, operation: string }): bigint => {
    if (!pointer) {
      throw new Error(`Native graph allocation failed: ${operation}`);
    }
    return pointer;
  };
  const newTensor = async ({ context, typeName, shape }: { context: bigint, typeName: string, shape: readonly number[] }): Promise<bigint> => checked({
    pointer: await api.ggml_new_tensor_4d(context, type({ name: typeName }), BigInt(shape[0] ?? 1), BigInt(shape[1] ?? 1), BigInt(shape[2] ?? 1), BigInt(shape[3] ?? 1)),
    operation: 'tensor',
  });
  const newContext = async ({ nodeCount, graphSize }: { nodeCount: number, graphSize: number }): Promise<bigint> => {
    const overhead = await api.ggml_tensor_overhead();
    const graphOverhead = graphSize ? await api.ggml_graph_overhead_custom(BigInt(graphSize), 0) : 0n;
    const params = core.allocRecord({ name: 'ggml_init_params' });
    try {
      core.setField({ name: 'ggml_init_params', pointer: params, field: 'mem_size', value: overhead * BigInt(nodeCount + 32) + graphOverhead + 65536n });
      core.setField({ name: 'ggml_init_params', pointer: params, field: 'mem_buffer', value: 0n });
      core.setField({ name: 'ggml_init_params', pointer: params, field: 'no_alloc', value: 1 });
      return checked({ pointer: await api.ggml_init(params), operation: 'context' });
    } finally {
      core.free({ pointer: params });
    }
  };
  let cpu = 0n, gpu = 0n, scheduler = 0n, weightContext = 0n, weightBuffer = 0n, stateContext = 0n, stateBuffer = 0n;
  let staging = 0n, stagingSize = 0, logitsMemory = 0n;
  let allocatedStateBytes = BigInt(initialPlan.stateBytes);
  let past = 0, closed = false, failed = false, running = false;
  const persistent = new Map<string, bigint>();
  const weights = new Map<string, bigint>(), states = new Map<string, { key: bigint, value: bigint }>();
  type Graph = { constants: { tensor: bigint; shape: readonly number[]; type: 'F32' | 'I32'; values: readonly number[] }[]; updates: { source: bigint; target: bigint }[]; context: bigint, graph: bigint, tokens: bigint, positions: bigint, floatPositions: bigint, indices: bigint, masks: Map<number, bigint>, logits: bigint, plan: ModelGraphPlan };
  let graph: Graph | undefined;
  const clearGraph = async (): Promise<void> => {
    // Reset the scheduler before freeing tensor metadata it still references.
    if (scheduler) {
      await api.ggml_backend_sched_reset(scheduler);
    }
    if (graph) {
      await api.ggml_free(graph.context);
      graph = undefined;
    }
  };
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    if (running) {
      throw new Error('Cannot close a registered graph during a native call');
    }
    closed = true;
    let failure: unknown;
    const operations = [
      clearGraph,
      async () => {
        if (scheduler) {
          await api.ggml_backend_sched_free(scheduler);
        }
      },
      async () => {
        if (stateBuffer) {
          await api.ggml_backend_buffer_free(stateBuffer);
        }
      },
      async () => {
        if (weightBuffer) {
          await api.ggml_backend_buffer_free(weightBuffer);
        }
      },
      async () => {
        if (stateContext) {
          await api.ggml_free(stateContext);
        }
      },
      async () => {
        if (weightContext) {
          await api.ggml_free(weightContext);
        }
      },
      async () => {
        if (gpu) {
          await api.ggml_backend_free(gpu);
        }
      },
      async () => {
        if (cpu) {
          await api.ggml_backend_free(cpu);
        }
      },
      () => {
        if (staging) {
          core.free({ pointer: staging });
        }
      },
      () => {
        if (logitsMemory) {
          core.free({ pointer: logitsMemory });
        }
      },
    ];
    for (const operation of operations) {
      try {
        await operation();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) {
      throw failure;
    }
  };
  const reserveStaging = ({ size }: { size: number }): bigint => {
    if (size > stagingSize) {
      const next = core.alloc({ bytes: size });
      if (staging) {
        core.free({ pointer: staging });
      }
      staging = next;
      stagingSize = size;
    }
    return staging;
  };
  const upload = async ({ tensor, bytes }: { tensor: bigint, bytes: Uint8Array }): Promise<void> => {
    const pointer = reserveStaging({ size: bytes.length });
    core.bytes({ pointer, length: bytes.length }).set(bytes);
    await api.ggml_backend_tensor_set(tensor, pointer, 0n, BigInt(bytes.length));
  };
  const label = async ({ tensor, text }: { tensor: bigint, text: string }): Promise<void> => {
    const name = core.utf8({ text });
    try {
      await api.ggml_set_name(tensor, name);
    } finally {
      core.free({ pointer: name });
    }
  };
  const graphSize = initialPlan.nodes.length * 4 + initialPlan.weights.length + initialPlan.slots.length * 20 + initialPlan.tensors.length * 4 + initialPlan.extraTensorCount + 256;
  try {
    signal?.throwIfAborted();
    cpu = checked({ pointer: await api.ggml_backend_cpu_init(), operation: 'CPU backend' });
    await api.ggml_backend_cpu_set_n_threads(cpu, threads);
    switch (backend) {
    case 'cpu': break;
    case 'webgpu': {
      const name = core.utf8({ text: 'WebGPU' });
      try {
        gpu = checked({ pointer: await api.ggml_backend_init_by_name(name, 0n), operation: 'WebGPU backend' });
      } finally {
        core.free({ pointer: name });
      }
      break;
    }
    default: {
      const exhaustive: never = backend;
      throw new Error(String(exhaustive));
    }
    }
    const backends = gpu ? [gpu, cpu] : [cpu];
    const pointers = core.alloc({ bytes: backends.length * core.pointerBytes });
    try {
      const bytes = core.bytes({ pointer: pointers, length: backends.length * core.pointerBytes });
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      backends.forEach((pointer, index) => {
        if (core.pointerBytes === 8) {
          view.setBigUint64(index * 8, pointer, true);
        } else {
          view.setUint32(index * 4, Number(pointer), true);
        }
      });
      scheduler = checked({ pointer: await api.ggml_backend_sched_new(pointers, 0n, backends.length, BigInt(graphSize), 0, 1), operation: 'scheduler' });
    } finally {
      core.free({ pointer: pointers });
    }
    weightContext = await newContext({ nodeCount: initialPlan.weights.length, graphSize: 0 });
    // Share aliases of exactly the same on-disk tensor without copying it twice.
    const uniqueWeights = new Map<string, bigint>();
    for (const weight of initialPlan.weights) {
      let pointer = uniqueWeights.get(weight.tensor.name);
      if (!pointer) {
        pointer = await newTensor({ context: weightContext, typeName: weight.tensor.type, shape: weight.tensor.shape });
        await label({ tensor: pointer, text: weight.tensor.name });
        uniqueWeights.set(weight.tensor.name, pointer);
      }
      weights.set(weight.id, pointer);
    }
    // The checked GGUF storage table and actual core must agree, including IQ
    // block sizes. Never silently reinterpret a different native type layout.
    for (const weight of initialPlan.weights) {
      const expected = graphStorageFormats[weight.tensor.type];
      if (await api.ggml_blck_size(type({ name: weight.tensor.type })) !== BigInt(expected.block)
          || await api.ggml_type_size(type({ name: weight.tensor.type })) !== BigInt(expected.bytes)) {
        throw new Error(`The runtime tensor encoding changed: ${weight.tensor.type}`);
      }
    }
    if (uniqueWeights.size) {
      weightBuffer = checked({ pointer: await api.ggml_backend_alloc_ctx_tensors(weightContext, gpu || cpu), operation: 'weight buffer' });
      await api.ggml_backend_buffer_set_usage(weightBuffer, core.constant({ name: 'GGML_BACKEND_BUFFER_USAGE_WEIGHTS' }));
    }
    const totalBytes = [...uniqueWeights.keys()].reduce((sum, name) => sum + inventory.tensors.get(name)!.bytes, 0);
    let loadedBytes = 0;
    const chunk = new Uint8Array(1024 * 1024);
    for (const [name, tensor] of uniqueWeights) {
      const location = locations.get(name), size = inventory.tensors.get(name)!.bytes;
      if (!location) {
        throw new Error(`Missing tensor file: ${name}`);
      }
      for (let offset = 0; offset < size; offset += chunk.length) {
        signal?.throwIfAborted();
        const bytes = chunk.subarray(0, Math.min(chunk.length, size - offset));
        readModelGraphBytes({ source: location.source, offset: location.offset + offset, destination: bytes, signal });
        const pointer = reserveStaging({ size: bytes.length });
        core.bytes({ pointer, length: bytes.length }).set(bytes);
        await api.ggml_backend_tensor_set(tensor, pointer, BigInt(offset), BigInt(bytes.length));
        loadedBytes += bytes.length;
        onWeightProgress?.({ loadedBytes, totalBytes });
        if (offset % (16 * 1024 * 1024) === 0) {
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
      }
    }
    if (initialPlan.slots.length || initialPlan.tensors.length) {
      stateContext = await newContext({ nodeCount: initialPlan.slots.length * 2 + initialPlan.tensors.length, graphSize: 0 });
      for (const slot of initialPlan.slots) {
        const key = await newTensor({ context: stateContext, typeName: slot.precision, shape: [slot.headSize, capacity, slot.heads] });
        const value = await newTensor({ context: stateContext, typeName: slot.precision, shape: [slot.headSize, capacity, slot.heads] });
        await api.ggml_set_input(key);
        await api.ggml_set_input(value);
        states.set(slot.id, { key, value });
      }
      for (const tensor of initialPlan.tensors) {
        const value = await newTensor({ context: stateContext, typeName: tensor.precision, shape: tensor.shape });
        // Mark externally owned state as an input; the host alone applies its
        // staged next-step value after graph execution has completed.
        await api.ggml_set_input(value);
        persistent.set(tensor.id, value);
      }
      stateBuffer = checked({ pointer: await api.ggml_backend_alloc_ctx_tensors(stateContext, gpu || cpu), operation: 'state buffer' });
      allocatedStateBytes = await api.ggml_backend_buffer_get_size(stateBuffer);
      // The native buffer may include alignment; never undercount the checked
      // tensor payload if a backend reports less than the logical state size.
      if (allocatedStateBytes < BigInt(initialPlan.stateBytes)) {
        allocatedStateBytes = BigInt(initialPlan.stateBytes);
      }
      checkModelGraphMemoryBudget({ phase: 'state', stateBytes: allocatedStateBytes, computeBytes: 0n, maximumBytes: maximumScratchBytes, contextTokens: capacity, batchTokens: 1 });
      await api.ggml_backend_buffer_clear(stateBuffer, 0);
    }
    logitsMemory = core.alloc({ bytes: inventory.vocabularySize * 4 });
  } catch (error) {
    await close();
    throw error;
  }

  const build = async ({ plan, signal: buildSignal }: { plan: ModelGraphPlan, signal: AbortSignal | undefined }): Promise<{ graph: Graph, buildMs: number, allocationMs: number }> => {
    const begin = performance.now();
    await clearGraph();
    const context = await newContext({ nodeCount: graphSize, graphSize });
    // Publish ownership immediately, including on an allocation or shape error.
    const next: Graph = { constants: [], updates: [], context, graph: 0n, tokens: 0n, positions: 0n, floatPositions: 0n, indices: 0n, masks: new Map(), logits: 0n, plan };
    graph = next;
    next.graph = checked({ pointer: await api.ggml_new_graph_custom(context, BigInt(graphSize), 0), operation: 'graph' });
    if (plan.nodes.some(({ node }) => (node.op === 'embedding' || (node.op === 'input' && node.source === 'tokenIds')))) {
      next.tokens = await newTensor({ context, typeName: 'I32', shape: [plan.inputTokens] });
    }
    if (plan.nodes.some(({ node }) => (node.op === 'rotaryEmbedding' || (node.op === 'input' && node.source === 'positions')))) {
      next.positions = await newTensor({ context, typeName: 'I32', shape: [plan.inputTokens] });
    }
    if (plan.nodes.some(({ node }) => node.op === 'input' && node.source === 'positionsF32')) {
      next.floatPositions = await newTensor({ context, typeName: 'F32', shape: [plan.inputTokens] });
    }
    if (plan.slots.length) {
      next.indices = await newTensor({ context, typeName: 'I64', shape: [plan.inputTokens] });
    }
    for (const input of [next.tokens, next.positions, next.floatPositions, next.indices]) {
      if (input) {
        await api.ggml_set_input(input);
      }
    }
    const writes: { tensor: bigint; backend: bigint }[] = [];
    const values = new Map(weights);
    const lookup = ({ id }: { id: string }): bigint => {
      const tensor = values.get(id);
      if (!tensor) {
        throw new Error(`Unknown compiled tensor: ${id}`);
      }
      return tensor;
    };
    for (const { node, shape } of plan.nodes) {
      buildSignal?.throwIfAborted();
      let tensor: bigint;
      switch (node.op) {
      case 'tensor':
        tensor = await node.operation.lower({
          environment: {
            core,
            context,
            inputs: node.inputs.map(id => lookup({ id })),
            constant: async ({ shape, type: tensorType, values }) => {
              const pointer = await newTensor({ context, typeName: tensorType, shape });
              await api.ggml_set_input(pointer);
              // These inputs are uploaded once per shape, not once per token.
              // OUTPUT forbids gallocr's last-use in-place buffer recycling.
              await api.ggml_set_output(pointer);
              next.constants.push({ tensor: pointer, shape, type: tensorType, values });
              return pointer;
            },
          },
        });
        break;
      case 'input':
        switch (node.source) {
        case 'tokenIds': tensor = next.tokens;
          break;
        case 'positions': tensor = next.positions;
          break;
        case 'positionsF32': tensor = next.floatPositions;
          break;
        default: {
          const exhaustive: never = node.source;
          throw new Error(String(exhaustive));
        }
        }
        break;
      case 'stateRead': {
        const pointer = persistent.get(node.slot);
        if (!pointer) {
          throw new Error('Missing persistent graph tensor');
        }
        tensor = pointer;
        break;
      }
      case 'embedding': tensor = await api.ggml_get_rows(context, lookup({ id: node.weight }), next.tokens);
        break;
      case 'linear': tensor = await api.ggml_mul_mat(context, lookup({ id: node.weight }), lookup({ id: node.input }));
        break;
      case 'normalizeRms': tensor = await api.ggml_rms_norm(context, lookup({ id: node.input }), node.epsilon);
        break;
      case 'add': tensor = await api.ggml_add(context, lookup({ id: node.left }), lookup({ id: node.right }));
        break;
      case 'subtract': tensor = await api.ggml_sub(context, lookup({ id: node.left }), lookup({ id: node.right }));
        break;
      case 'multiply': tensor = await api.ggml_mul(context, lookup({ id: node.left }), lookup({ id: node.right }));
        break;
      case 'sigmoid': tensor = await api.ggml_sigmoid(context, lookup({ id: node.input }));
        break;
      case 'silu': tensor = await api.ggml_silu(context, lookup({ id: node.input }));
        break;
      case 'contiguous': tensor = await api.ggml_cont(context, lookup({ id: node.input }));
        break;
      case 'scale': tensor = await api.ggml_scale(context, lookup({ id: node.input }), node.value);
        break;
      case 'reshape': tensor = await api.ggml_reshape_4d(context, lookup({ id: node.input }), BigInt(node.shape[0] ?? 1), BigInt(node.shape[1] ?? 1), BigInt(node.shape[2] ?? 1), BigInt(node.shape[3] ?? 1));
        break;
      case 'permute': tensor = await api.ggml_permute(context, lookup({ id: node.input }), node.axes[0], node.axes[1], node.axes[2], node.axes[3]);
        break;
      case 'rotaryEmbedding': tensor = await api.ggml_rope_ext(context, lookup({ id: node.input }), next.positions, node.frequencyFactors === undefined ? 0n : lookup({ id: node.frequencyFactors }), node.dimensions, ({ normal: 0, neox: 2 } satisfies Record<typeof node.mode, number>)[node.mode], node.contextOriginal, node.frequencyBase, node.frequencyScale, node.extensionFactor, node.attentionFactor, node.betaFast, node.betaSlow);
        break;
      case 'attentionCached': {
        const slot = plan.slots.find(slot => slot.id === node.slot)!, state = states.get(node.slot)!;
        const keyInput = await api.ggml_cont(context, await api.ggml_permute(context, lookup({ id: node.key }), 0, 2, 1, 3));
        const valueInput = await api.ggml_cont(context, await api.ggml_permute(context, lookup({ id: node.value }), 0, 2, 1, 3));
        const updatedKey = await api.ggml_set_rows(context, state.key, keyInput, next.indices);
        const updatedValue = await api.ggml_set_rows(context, state.value, valueInput, next.indices);
        // State writes must execute where the persistent buffer lives. A CPU
        // copy of a GPU view must never become an unnoticed private KV cache.
        const stateDevice = await api.ggml_backend_get_device(gpu || cpu);
        if (!await api.ggml_backend_dev_supports_op(stateDevice, updatedKey) || !await api.ggml_backend_dev_supports_op(stateDevice, updatedValue)) {
          throw new Error('Selected backend does not support this persistent KV write');
        }
        writes.push({ tensor: updatedKey, backend: gpu || cpu }, { tensor: updatedValue, backend: gpu || cpu });
        const width = ({ F16: 2, F32: 4 } satisfies Record<typeof slot.precision, number>)[slot.precision];
        const key = await api.ggml_view_3d(context, updatedKey, BigInt(slot.headSize), BigInt(plan.cacheTokens), BigInt(slot.heads), BigInt(slot.headSize * width), BigInt(slot.headSize * capacity * width), 0n);
        const value = await api.ggml_view_3d(context, updatedValue, BigInt(slot.headSize), BigInt(plan.cacheTokens), BigInt(slot.heads), BigInt(slot.headSize * width), BigInt(slot.headSize * capacity * width), 0n);
        let mask = next.masks.get(node.window);
        if (!mask) {
          mask = await newTensor({ context, typeName: 'F16', shape: [plan.cacheTokens, Math.ceil(plan.inputTokens / 64) * 64] });
          await api.ggml_set_input(mask);
          next.masks.set(node.window, mask);
        }
        const query = await api.ggml_cont(context, await api.ggml_permute(context, lookup({ id: node.query }), 0, 2, 1, 3));
        tensor = await api.ggml_flash_attn_ext(context, query, key, value, mask, node.scale, 0, 0);
        tensor = await api.ggml_reshape_2d(context, tensor, BigInt(shape[0]!), BigInt(plan.inputTokens));
        break;
      }
      default: {
        const exhaustive: never = node;
        throw new Error(String(exhaustive));
      }
      }
      values.set(node.id, checked({ pointer: tensor, operation: node.op }));
    }
    next.logits = lookup({ id: plan.logits });
    await api.ggml_set_output(next.logits);
    await api.ggml_build_forward_expand(next.graph, next.logits);
    // Stage every recurrent update before any persistent buffer is changed.
    // These distinct output tensors make multiple updates simultaneous, even
    // when one update reads another state's old value or the same source view.
    for (const update of plan.updates) {
      const target = persistent.get(update.slot)!;
      const source = await api.ggml_dup(context, lookup({ id: update.value }));
      await api.ggml_set_output(source);
      await api.ggml_build_forward_expand(next.graph, source);
      next.updates.push({ source, target });
    }
    const devices = [await api.ggml_backend_get_device(cpu)];
    if (gpu) {
      devices.unshift(await api.ggml_backend_get_device(gpu));
    }
    const nodeCount = await api.ggml_graph_n_nodes(next.graph);
    for (let index = 0; index < nodeCount; index++) {
      const node = await api.ggml_graph_node(next.graph, index);
      let supported = false;
      for (const device of devices) {
        if (await api.ggml_backend_dev_supports_op(device, node)) {
          supported = true;
          break;
        }
      }
      if (!supported) {
        throw new Error(`No loaded backend supports graph node ${index}`);
      }
    }
    const allocationStart = performance.now();
    await allocateModelGraph({
      core,
      scheduler,
      graph: next.graph,
      backends: gpu ? [gpu, cpu] : [cpu],
      writes,
      stateBytes: allocatedStateBytes,
      maximumBytes: maximumScratchBytes,
      contextTokens: capacity,
      batchTokens: plan.inputTokens,
      signal: buildSignal,
    });
    for (const constant of next.constants) {
      const elements = constant.shape.reduce((total, size) => total * size, 1);
      for (let offset = 0; offset < elements;) {
        buildSignal?.throwIfAborted();
        const length = Math.min(262144, elements - offset);
        const pointer = reserveStaging({ size: length * 4 });
        const memory = core.bytes({ pointer, length: length * 4 });
        const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
        for (let index = 0; index < length; index++) {
          const value = constant.values[constant.values.length === 1 ? 0 : offset + index]!;
          switch (constant.type) {
          case 'F32': view.setFloat32(index * 4, value, true);
            break;
          case 'I32': view.setInt32(index * 4, value, true);
            break;
          default: {
            const exhaustive: never = constant.type;
            throw new Error(String(exhaustive));
          }
          }
        }
        await api.ggml_backend_tensor_set(constant.tensor, pointer, BigInt(offset * 4), BigInt(length * 4));
        offset += length;
      }
    }
    return { graph: next, buildMs: allocationStart - begin, allocationMs: performance.now() - allocationStart };
  };

  return {
    close,
    get processedTokens(): number {
      return past;
    },
    get logitsPointer(): bigint {
      if (closed || failed || running || !past) {
        throw new Error('Registered graph logits are unavailable');
      }
      return logitsMemory;
    },
    async reset(): Promise<void> {
      if (closed || failed || running) {
        throw new Error('Registered graph is not reusable');
      }
      running = true;
      try {
        if (stateBuffer) {
          await api.ggml_backend_buffer_clear(stateBuffer, 0);
        }
        past = 0;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        running = false;
      }
    },
    async step({ tokens, signal: stepSignal }: { tokens: readonly number[], signal: AbortSignal | undefined }): Promise<ModelGraphStepTimings> {
      if (closed || failed || running) {
        throw new Error('Registered graph is not available');
      }
      if (!tokens.length || tokens.length > batchSize || past + tokens.length > contextSize || tokens.some(token => !Number.isInteger(token) || token < 0 || token >= inventory.vocabularySize)) {
        throw new Error('Invalid tokens or registered graph context limit exceeded');
      }
      stepSignal?.throwIfAborted();
      running = true;
      try {
        const batches = initialPlan.tensors.length ? tokens.map(token => [token]) : [tokens];
        const total: ModelGraphStepTimings = { graphBuildMs: 0, allocationMs: 0, inputMs: 0, computeMs: 0, readbackMs: 0, graphReused: true, builds: 0, reuseHits: 0, computeCalls: 0, maximumBatchTokens: 0 };
        for (const batch of batches) {
          const tokens = batch;
          stepSignal?.throwIfAborted();
          const cacheTokens = Math.ceil((initialPlan.slots.length ? past + tokens.length : tokens.length) / 64) * 64;
          let buildMs = 0, allocationMs = 0;
          const graphReused = graph !== undefined && graph.plan.inputTokens === tokens.length && graph.plan.cacheTokens === cacheTokens;
          if (!graphReused) {
            const plan = compileModelGraph({ definition: expandedDefinition, inventory, inputTokens: tokens.length, cacheTokens, capacity, maximumScratchBytes });
            checkModelGraphAddressWidth({ pointerBytes: core.pointerBytes, largestTensorBytes: plan.largestTensorBytes, stateBytes: plan.stateBytes });
            const result = await build({ plan, signal: stepSignal });
            buildMs = result.buildMs;
            allocationMs = result.allocationMs;
          }
          const current = graph!;
          const inputStart = performance.now();
          if (current.tokens) {
            await upload({ tensor: current.tokens, bytes: new Uint8Array(new Int32Array(tokens).buffer) });
          }
          if (current.positions) {
            const positions = Int32Array.from(tokens, (_, index) => past + index);
            await upload({ tensor: current.positions, bytes: new Uint8Array(positions.buffer) });
          }
          if (current.floatPositions) {
            const positions = Float32Array.from(tokens, (_, index) => past + index);
            await upload({ tensor: current.floatPositions, bytes: new Uint8Array(positions.buffer) });
          }
          if (current.indices) {
            const indices = BigInt64Array.from(tokens, (_, index) => BigInt(past + index));
            await upload({ tensor: current.indices, bytes: new Uint8Array(indices.buffer) });
          }
          for (const [window, tensor] of current.masks) {
            const mask = new Uint16Array(cacheTokens * Math.ceil(tokens.length / 64) * 64);
            mask.fill(0xfc00); // IEEE binary16 negative infinity, including padding.
            for (let query = 0; query < tokens.length; query++) {
              const end = past + query + 1, start = window ? Math.max(0, end - window) : 0;
              mask.fill(0, query * cacheTokens + start, query * cacheTokens + end);
            }
            await upload({ tensor, bytes: new Uint8Array(mask.buffer) });
          }
          stepSignal?.throwIfAborted();
          const computeStart = performance.now();
          const status = await api.ggml_backend_sched_graph_compute(scheduler, current.graph);
          const readbackStart = performance.now();
          if (status !== core.constant({ name: 'GGML_STATUS_SUCCESS' })) {
            throw new Error(`Registered graph computation failed (${status})`);
          }
          stepSignal?.throwIfAborted();
          await api.ggml_backend_tensor_get(current.logits, logitsMemory, BigInt((tokens.length - 1) * inventory.vocabularySize * 4), BigInt(inventory.vocabularySize * 4));
          for (const update of current.updates) {
            stepSignal?.throwIfAborted();
            await api.ggml_backend_tensor_copy(update.source, update.target);
          }
          stepSignal?.throwIfAborted();
          past += tokens.length;
          total.graphBuildMs += buildMs;
          total.allocationMs += allocationMs;
          total.inputMs += computeStart - inputStart;
          total.computeMs += readbackStart - computeStart;
          total.readbackMs += performance.now() - readbackStart;
          total.graphReused &&= graphReused;
          total.builds += graphReused ? 0 : 1;
          total.reuseHits += graphReused ? 1 : 0;
          total.computeCalls++;
          total.maximumBatchTokens = Math.max(total.maximumBatchTokens, tokens.length);
        }
        return total;
      } catch (error) {
        // A failure may have written only some state slots. Never continue from it.
        failed = true;
        throw error;
      } finally {
        running = false;
      }
    },
  };
}

export const TEST_ONLY = {
};
