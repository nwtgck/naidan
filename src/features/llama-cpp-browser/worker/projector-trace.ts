import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { logNativeCheckpoint, logFailure } from '@/features/llama-cpp-browser/debug-log';

/** Debug-only: requesting every node introduces native synchronization per node. */
export function createProjectorTrace({ core }: { core: Core }) {
  const op = core.fieldLayout({ name: 'ggml_tensor', field: 'op' });
  const type = core.fieldLayout({ name: 'ggml_tensor', field: 'type' });
  const shape = core.fieldLayout({ name: 'ggml_tensor', field: 'ne' });
  if (op.kind !== 'signed' || op.size !== 4 || type.kind !== 'signed' || type.size !== 4 || shape.kind !== 'array' || shape.size !== 32) throw new Error('Unsupported native tensor metadata layout');
  // Pooling modes are a separate enum whose identifiers share the operation prefix.
  const nonOperations = new Set(['GGML_OP_COUNT', 'GGML_OP_POOL_MAX', 'GGML_OP_POOL_AVG', 'GGML_OP_POOL_COUNT']);
  const names = new Map(core.enumValues({ prefix: 'GGML_OP_' }).filter(({ name }) => !nonOperations.has(name)).map(({ name, value }) => [value, name]));
  let node = 0; let started = 0; let reportedFailure = false; let released = false;
  const view = ({ pointer, offset, size }: { pointer: bigint, offset: bigint, size: number }): DataView => {
    const span = core.bytes({ pointer: pointer + offset, length: size });
    return new DataView(span.buffer, span.byteOffset, span.byteLength);
  };
  // This callback must remain synchronous. It reads metadata only, never tensor data or names.
  const pointer = core.module.addFunction((tensor: number | bigint, ask: number, _userData: number | bigint): number => {
    try {
      const address = core.pointerBytes === 4 ? BigInt(Number(tensor) >>> 0) : BigInt(tensor);
      const nativeOp = view({ pointer: address, ...op }).getInt32(0, true);
      const nativeTensorType = view({ pointer: address, ...type }).getInt32(0, true);
      const dimensions = view({ pointer: address, ...shape });
      const nativeTensorShape = [0, 1, 2, 3].map(index => {
        const value = dimensions.getBigInt64(index * 8, true);
        if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Unsafe tensor dimension');
        return Number(value);
      });
      if (ask) {
        node++; started = performance.now();
      }
      logNativeCheckpoint({ diagnostic: { event: ask ? 'native-node-start' : 'native-node-complete', stage: 'media-encode', nativeNode: node,
        nativeOp, nativeOpName: names.get(nativeOp), nativeTensorType, nativeTensorShape,
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
    return 1;
  }, core.pointerBytes === 8 ? 'ijij' : 'iiii');
  return { pointer, release(): void {
    if (released) return;
    core.module.removeFunction(pointer); released = true;
  } };
}
export const TEST_ONLY = {
};
