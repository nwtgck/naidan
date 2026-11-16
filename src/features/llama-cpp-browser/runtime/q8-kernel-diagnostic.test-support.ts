import { createHash } from 'node:crypto';
import { attachCore, type Core } from './core';
import rawCatalog from 'llama-cpp-browser-core/llama-cpp/api/schema.mjs';
import { selectAbiSchema } from 'llama-cpp-browser-core/llama-cpp/host/abi';

import { diagnosticPrefix, diagnosticSchemaFixture, diagnosticReportFields as reportNames, diagnosticRequestFields as requestNames } from "./q8-kernel-diagnostic-schema.test-support";
export { diagnosticPrefix, diagnosticSchemaFixture, diagnosticConstants } from "./q8-kernel-diagnostic-schema.test-support";

/** The base allocator and ordinary ABI are real supplied CPU Wasm. Only the
 * optional extension is simulated; no WebGPU or diagnostic native code runs. */
export function createDiagnosticNativeFixture({ base }: { base: Core }) {
  const schema = diagnosticSchemaFixture();
  const target = {
    ...structuredClone(selectAbiSchema({ module: base.module, schema: rawCatalog })),
    extensions: { 'webgpu-q8-diagnostic-v1': schema },
  };
  // Explicitly simulate the native metadata boundary along with the extension.
  // This fingerprint belongs to a fixture, never to a claimed compiled target.
  target.schemaSha256 = createHash('sha256').update(JSON.stringify(target)).digest('hex');
  if (!rawCatalog || typeof rawCatalog !== 'object' || !('targets' in rawCatalog) || !rawCatalog.targets || typeof rawCatalog.targets !== 'object') {
    throw new Error('Missing fixture ABI catalog');
  }
  const targets = rawCatalog.targets;
  Object.assign(targets, { [target.schemaSha256]: target });
  const hashPointer = base.alloc({ bytes: 65 });
  base.bytes({ pointer: hashPointer, length: 65 }).set(new TextEncoder().encode(target.schemaSha256 + '\0'));
  let heap = base.module.HEAPU8;
  const allocations = new Set<bigint>();
  const freed: bigint[] = [];
  const probes: string[] = [];
  const calls: string[] = [];
  const metadataCalls: string[] = [];
  const state: {
    status: number, result: unknown, report: Record<string, number>, omitted: Set<string>, overrides: Record<string, unknown>,
    delay: Promise<void> | undefined, grow: boolean, oomAt: number | undefined, freeTrap: boolean, allocationCount: number,
    invokeCount: number, onRequest: (({ request }: { request: Readonly<Record<string, number>> }) => void) | undefined,
    padding: number, onFree: (() => void) | undefined, zeroDigest: boolean,
  } = {
    status: 0,
    result: undefined,
    report: {},
    omitted: new Set(),
    overrides: {},
    delay: undefined,
    grow: false,
    oomAt: undefined,
    freeTrap: false,
    allocationCount: 0,
    invokeCount: 0,
    onRequest: undefined,
    padding: 0,
    onFree: undefined,
    zeroDigest: false,
  };
  const span = ({ pointer, length }: { pointer: bigint, length: number }) => heap.subarray(Number(pointer), Number(pointer) + length);
  const read = ({ pointer, offset }: { pointer: bigint, offset: number }) => new DataView(heap.buffer, Number(pointer) + offset, 4).getUint32(0, true);
  const write = ({ pointer, offset, value }: { pointer: bigint, offset: number, value: number }) => new DataView(heap.buffer, Number(pointer) + offset, 4).setUint32(0, value, true);
  const native: Record<string, unknown> = {
    version: () => 1,
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Simulate the generated diagnostic C ABI.
    async run_v1(_backend: bigint, _dst: bigint, request: bigint, report: bigint, capacity: number) {
      state.invokeCount++;
      const req = Object.fromEntries(requestNames.map((name, index) => [name, read({ pointer: request, offset: index * 4 + state.padding })]));
      state.onRequest?.({ request: req });
      if (state.delay) {
        await state.delay;
      }
      if (state.grow) {
        const next = new Uint8Array(heap.length + 65536);
        next.set(heap);
        heap = next;
      }
      const variant = req.variant!, phase = req.phase!;
      const shaped = state.status === 0 || state.status === 4;
      const independent = variant === 0 || variant >= 2 && variant <= 4;
      const wg = variant === 1 ? 256 : 128;
      const rows = variant === 3 ? 1 : variant === 4 || variant === 5 || variant === 0 ? 2 : 4;
      const values = {
        abi_version: 1,
        struct_size: capacity,
        status: state.status,
        requested_variant: variant,
        phase,
        ...(shaped ? {
          actual_algorithm: independent ? 2 : 1,
          workgroup_size: wg,
          logical_subgroup_size: independent ? 8 : 0,
          real_min_subgroup_size: 8,
          real_max_subgroup_size: 8,
          rows_per_tile: rows,
          outputs_per_workgroup: independent ? rows * wg / 8 : rows,
          cooperative_subgroup_reduction: independent ? 0 : 1,
          grid_x: 3,
          grid_y: 1,
          grid_z: 1,
          codegen_revision: 1,
        } : {}),
        dispatches: state.status === 0 && phase === 2 ? req.repetitions! : 0,
        ...state.report,
      };
      for (const [name, value] of Object.entries(values)) {
        const offset = reportNames.indexOf(name) * 4 + state.padding;
        if (offset < state.padding) {
          throw new Error('Unknown report fixture field');
        }
        write({ pointer: report, offset, value });
      }
      if (state.status === 0 && !state.zeroDigest) {
        span({ pointer: report + BigInt(80 + state.padding), length: 32 }).fill(0xab);
      }
      return state.result === undefined ? state.status : state.result;
    },
  };
  const module = new Proxy(base.module, {
    get(target, property) {
      if (property === '_bicore_schema_hash') {
        return () => base.pointerBytes === 4 ? Number(hashPointer) : hashPointer;
      }
      if (typeof property === 'string' && property.startsWith(diagnosticPrefix)) {
        const suffix = property.slice(diagnosticPrefix.length);
        probes.push(suffix);
        if (state.omitted.has(suffix)) {
          return undefined;
        }
        const value = Object.hasOwn(state.overrides, suffix) ? state.overrides[suffix] : native[suffix];
        if (typeof value !== 'function') {
          return value;
        }
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Preserve the intercepted native export's positional ABI.
        return (...args: (number | bigint)[]) => {
          calls.push(suffix);
          if (suffix !== 'run_v1' && suffix !== 'version') {
            metadataCalls.push(suffix);
          }
          return Reflect.apply(value, undefined, args);
        };
      }
      if (property === 'HEAPU8') {
        return heap;
      }
      if (property === '_malloc') {
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Preserve the allocator's C ABI.
        return (length: number) => {
          state.allocationCount++;
          if (state.oomAt === state.allocationCount) {
            return 0;
          }
          const pointer = base.alloc({ bytes: length });
          allocations.add(pointer);
          return Number(pointer);
        };
      }
      if (property === '_free') {
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Preserve the allocator's C ABI.
        return (nativePointer: number) => {
          const pointer = BigInt(nativePointer);
          state.onFree?.();
          if (state.freeTrap) {
            throw new WebAssembly.RuntimeError('fixture cleanup trap');
          }
          freed.push(pointer);
          allocations.delete(pointer);
          base.free({ pointer });
        };
      }
      return Reflect.get(target, property, target);
    },
  });
  const core = attachCore({ module, callMode: 'jspi' });
  return {
    core,
    module,
    schema,
    state,
    freed,
    allocations,
    probes,
    calls,
    metadataCalls,
    replaceCompiledHash({ hash }: { hash: string }) {
      span({ pointer: hashPointer, length: 64 }).set(new TextEncoder().encode(hash));
    },
    omitDescriptor() {
      Reflect.deleteProperty(target.extensions, 'webgpu-q8-diagnostic-v1');
    },
    [Symbol.dispose]() {
      // These are CPU-only fixture allocations after the simulated call has
      // settled. Production never frees through a poisoned runtime.
      for (const pointer of allocations) {
        base.free({ pointer });
      }
      base.free({ pointer: hashPointer });
      Reflect.deleteProperty(targets, target.schemaSha256);
    },
  };
}
