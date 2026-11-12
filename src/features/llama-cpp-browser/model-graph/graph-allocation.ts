import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { checkModelGraphMemoryBudget } from './memory-budget';

/** GGML's reserve/measure split may replace src pointers with backend copies
 * and optimize public tensor metadata. Restore the unsplit graph before the
 * next split; otherwise a measurement can lend temporary metadata to execution.
 * Only generated public ggml_tensor layout is used, never private scheduler
 * fields, external code or model-supplied memory addresses. */
export async function preserveModelGraphMetadata({ core, graph }: { core: Core; graph: bigint }): Promise<() => void> {
  const nodes = await core.api.ggml_graph_nodes(graph);
  const count = await core.api.ggml_graph_n_nodes(graph);
  const nodeBytes = core.bytes({ pointer: nodes, length: count * core.pointerBytes }).slice();
  const pointers = new DataView(nodeBytes.buffer, nodeBytes.byteOffset, nodeBytes.byteLength);
  const readPointer = ({ data, offset }: { data: DataView; offset: number }): bigint => core.pointerBytes === 8
    ? data.getBigUint64(offset, true) : BigInt(data.getUint32(offset, true));
  const pending = Array.from({ length: count }, (_, index) => readPointer({ data: pointers, offset: index * core.pointerBytes }));
  const saved = new Map<bigint, Uint8Array>();
  const recordSize = core.recordSize({ name: 'ggml_tensor' });
  const sources = core.fieldLayout({ name: 'ggml_tensor', field: 'src' });
  const viewSource = core.fieldLayout({ name: 'ggml_tensor', field: 'view_src' });
  while (pending.length) {
    const pointer = pending.pop()!;
    if (!pointer || saved.has(pointer)) {
      continue;
    }
    const bytes = core.bytes({ pointer, length: recordSize }).slice();
    saved.set(pointer, bytes);
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < sources.size / core.pointerBytes; index++) {
      pending.push(readPointer({ data, offset: Number(sources.offset) + index * core.pointerBytes }));
    }
    pending.push(readPointer({ data, offset: Number(viewSource.offset) }));
  }
  return () => {
    core.assertIdle();
    core.bytes({ pointer: nodes, length: nodeBytes.length }).set(nodeBytes);
    for (const [pointer, bytes] of saved) {
      core.bytes({ pointer, length: bytes.length }).set(bytes);
    }
  };
}

export async function allocateModelGraph({ core, scheduler, graph, backends, writes, stateBytes, maximumBytes, contextTokens, batchTokens, signal }: {
  core: Core; scheduler: bigint; graph: bigint; backends: readonly bigint[]; writes: readonly { tensor: bigint; backend: bigint }[];
  stateBytes: bigint; maximumBytes: number; contextTokens: number; batchTokens: number; signal: AbortSignal | undefined;
}): Promise<void> {
  const api = core.api;
  const restore = await preserveModelGraphMetadata({ core, graph });
  const sizes = core.alloc({ bytes: backends.length * core.pointerBytes });
  try {
    signal?.throwIfAborted();
    // Existing GGML machinery accounts for views, aliases, lifetimes, shared
    // inputs, backend copies and buffer alignment without allocating payloads.
    await api.ggml_backend_sched_reserve_size(scheduler, graph, sizes);
    const bytes = core.bytes({ pointer: sizes, length: backends.length * core.pointerBytes });
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const required = backends.map((_backend, index) => core.pointerBytes === 8
      ? data.getBigUint64(index * 8, true) : BigInt(data.getUint32(index * 4, true)));
    let computeBytes = 0n;
    for (const [index, backend] of backends.entries()) {
      // An older, larger allocation is still resident when no growth is needed.
      const retained = await api.ggml_backend_sched_get_buffer_size(scheduler, backend);
      computeBytes += retained > required[index]! ? retained : required[index]!;
    }
    // reserve_size resets explicit assignments. A persistent write must still
    // resolve to its existing state buffer; never measure an unnoticed copy.
    for (const write of writes) {
      if (await api.ggml_backend_sched_get_tensor_backend(scheduler, write.tensor) !== write.backend) {
        throw new Error('Graph memory measurement changed the persistent state backend');
      }
    }
    checkModelGraphMemoryBudget({ phase: 'graph', stateBytes, computeBytes, maximumBytes, contextTokens, batchTokens });
    restore();
    await api.ggml_backend_sched_reset(scheduler);
    for (const write of writes) {
      await api.ggml_backend_sched_set_tensor_backend(scheduler, write.tensor, write.backend);
    }
    signal?.throwIfAborted();
    // Materialize only the approved sizes. Planning alone leaves no buffer for
    // alloc_graph to initialize. Each split starts from original metadata.
    if (!await api.ggml_backend_sched_reserve(scheduler, graph)) {
      throw new Error('Registered graph backend reservation failed');
    }
    restore();
    for (const write of writes) {
      await api.ggml_backend_sched_set_tensor_backend(scheduler, write.tensor, write.backend);
    }
    signal?.throwIfAborted();
    if (!await api.ggml_backend_sched_alloc_graph(scheduler, graph)) {
      throw new Error('Registered graph backend allocation failed');
    }
    let allocatedBytes = 0n;
    for (const backend of backends) {
      allocatedBytes += await api.ggml_backend_sched_get_buffer_size(scheduler, backend);
    }
    checkModelGraphMemoryBudget({ phase: 'graph', stateBytes, computeBytes: allocatedBytes, maximumBytes, contextTokens, batchTokens });
    for (const write of writes) {
      if (await api.ggml_backend_sched_get_tensor_backend(scheduler, write.tensor) !== write.backend) {
        throw new Error('Graph allocation changed the persistent state backend');
      }
    }
  } catch (error) {
    // No computation has started. Remove borrowed copy pointers before cleanup.
    restore();
    throw error;
  } finally {
    core.free({ pointer: sizes });
  }
}

export const TEST_ONLY = {
};
