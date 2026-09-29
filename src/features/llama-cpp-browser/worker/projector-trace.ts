import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { logNativeCheckpoint, logFailure } from '@/features/llama-cpp-browser/debug-log';

/**
 * Debug-only: requesting every node introduces native synchronization per node.
 * Disable the host trace for speed comparisons; hiding console output does not
 * remove the native callback or its synchronization cost.
 */
export function createProjectorTrace({ core }: { core: Core }) {
  const op = core.fieldLayout({ name: 'ggml_tensor', field: 'op' });
  const type = core.fieldLayout({ name: 'ggml_tensor', field: 'type' });
  const shape = core.fieldLayout({ name: 'ggml_tensor', field: 'ne' });
  // Use layouts exported by this core, not hard-coded offsets: pointer arrays
  // differ between wasm32 and wasm64 even though tensor dimensions are int64.
  const sources = core.fieldLayout({ name: 'ggml_tensor', field: 'src' });
  if (sources.kind !== 'array' || sources.size < core.pointerBytes * 2 || sources.size % core.pointerBytes !== 0) throw new Error('Unsupported native tensor source layout');
  if (op.kind !== 'signed' || op.size !== 4 || type.kind !== 'signed' || type.size !== 4 || shape.kind !== 'array' || shape.size !== 32) throw new Error('Unsupported native tensor metadata layout');
  // Pooling modes are a separate enum whose identifiers share the operation prefix.
  const nonOperations = new Set(['GGML_OP_COUNT', 'GGML_OP_POOL_MAX', 'GGML_OP_POOL_AVG', 'GGML_OP_POOL_COUNT']);
  const names = new Map(core.enumValues({ prefix: 'GGML_OP_' }).filter(({ name }) => !nonOperations.has(name)).map(({ name, value }) => [value, name]));
  const typeNames = new Map(core.enumValues({ prefix: 'GGML_TYPE_' }).filter(({ name }) => name !== 'GGML_TYPE_COUNT').map(({ name, value }) => [value, name]));
  let node = 0; let started = 0; let reportedFailure = false; let released = false;
  const view = ({ pointer, offset, size }: { pointer: bigint, offset: bigint, size: number }): DataView => {
    const span = core.bytes({ pointer: pointer + offset, length: size });
    return new DataView(span.buffer, span.byteOffset, span.byteLength);
  };
  const metadata = ({ address }: { address: bigint }) => {
    const tensorType = view({ pointer: address, ...type }).getInt32(0, true);
    const dimensions = view({ pointer: address, ...shape });
    const tensorShape = [0, 1, 2, 3].map(index => {
      const value = dimensions.getBigInt64(index * 8, true);
      if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Unsafe tensor dimension');
      return Number(value);
    });
    return { type: tensorType, typeName: typeNames.get(tensorType), shape: tensorShape };
  };
  // This callback must remain synchronous. It reads metadata only, never tensor data or names.
  const pointer = core.module.addFunction((tensor: number | bigint, ask: number, _userData: number | bigint): number => {
    try {
      // A wasm32 callback may expose the high address bit as a negative number.
      // Restore its unsigned address; keep wasm64 pointers as bigint throughout.
      const address = core.pointerBytes === 4 ? BigInt(Number(tensor) >>> 0) : BigInt(tensor);
      const nativeOp = view({ pointer: address, ...op }).getInt32(0, true);
      // MUL_MAT can output F32 even when its weights are BF16. Read src[0]/src[1]
      // separately to diagnose fallback instead of inferring inputs from output.
      // These are runtime types after any loader conversion, not on-disk types;
      // the lcore bf16-f32 summary is needed to tell whether conversion occurred.
      const output = metadata({ address });
      // Two inputs cover this matmul diagnosis without recursively walking the
      // graph or exposing names/data. Missing inputs keep the remaining indices.
      const inputPointers = view({ pointer: address, offset: sources.offset, size: core.pointerBytes * 2 });
      const nativeTensorInputs = ([0, 1] as const).flatMap(index => {
        const offset = index * core.pointerBytes;
        const input = core.pointerBytes === 8 ? inputPointers.getBigUint64(offset, true) : BigInt(inputPointers.getUint32(offset, true));
        return input === 0n ? [] : [{ index, ...metadata({ address: input }) }];
      });
      if (ask) {
        node++; started = performance.now();
      }
      logNativeCheckpoint({ diagnostic: { event: ask ? 'native-node-start' : 'native-node-complete', stage: 'media-encode', nativeNode: node,
        nativeOp, nativeOpName: names.get(nativeOp), nativeTensorType: output.type, nativeTensorTypeName: output.typeName, nativeTensorShape: output.shape, nativeTensorInputs,
        ...(ask ? {} : { elapsedMs: performance.now() - started }) } });
    } catch (error) {
      if (!reportedFailure) {
        reportedFailure = true;
        try {
          logFailure({ stage: 'projector-trace', error });
        } catch { /* A diagnostic failure must never unwind into native code. */ }
      }
    }
    // ask=true requests this node's completion callback; ask=false must not abort execution.
    // Keep returning true even after a metadata error: diagnostics are not inference.
    // In the signature below, i is a 32-bit integer and j a 64-bit integer; only
    // the two pointer parameters widen, not ask or the boolean return value.
    return 1;
  }, core.pointerBytes === 8 ? 'ijij' : 'iiii');
  return { pointer, release(): void {
    if (released) return;
    core.module.removeFunction(pointer); released = true;
  } };
}
export const TEST_ONLY = {
};
