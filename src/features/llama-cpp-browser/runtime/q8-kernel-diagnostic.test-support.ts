import { createHash } from 'node:crypto';
import { attachCore, type Core } from './core';

export const diagnosticPrefix = '_lcb_webgpu_q8_diagnostic_';
const constantPrefix = 'GGML_WEBGPU_Q8_DIAGNOSTIC_';
export const diagnosticConstants = {
  AUTO: 0,
  COOPERATIVE_WG256_R4: 1,
  INDEPENDENT_WG128_R4: 2,
  INDEPENDENT_WG128_R1: 3,
  INDEPENDENT_WG128_R2: 4,
  COOPERATIVE_WG128_R2: 5,
  PREPARE: 1,
  EXECUTE: 2,
  OK: 0,
  UNAVAILABLE: 1,
  BAD_REQUEST: 2,
  UNSUPPORTED: 3,
  NOT_PREPARED: 4,
  BUSY: 5,
  ALGORITHM_NONE: 0,
  ALGORITHM_COOPERATIVE: 1,
  ALGORITHM_INDEPENDENT: 2,
  VERSION: 1,
  K_MIN: 32,
  K_MAX: 16384,
  M_MIN: 1,
  M_MAX: 65536,
  WEIGHT_BYTES_MAX: 67108864,
  REPETITIONS_MAX: 128,
} as const;
const reportNames = ['abi_version', 'struct_size', 'status', 'requested_variant', 'phase', 'actual_algorithm', 'workgroup_size', 'logical_subgroup_size', 'real_min_subgroup_size', 'real_max_subgroup_size', 'rows_per_tile', 'outputs_per_workgroup', 'cooperative_subgroup_reduction', 'grid_x', 'grid_y', 'grid_z', 'dispatches', 'codegen_revision', 'shader_identity_id', 'reserved', 'shader_sha256'];
const requestNames = ['abi_version', 'struct_size', 'variant', 'phase', 'repetitions', 'reserved'];

export function diagnosticSchemaFixture() {
  const record = ({ name, id, names }: { name: string, id: number, names: string[] }) => ({
    name,
    cType: 'struct ' + name,
    fields: names.map((name, id) => ({ id, name, cType: name === 'shader_sha256' ? 'uint8_t[32]' : 'uint32_t', kind: name === 'shader_sha256' ? 'array' : 'unsigned' })),
    id,
  });
  const schema = {
    abiVersion: 1,
    extensionId: 'webgpu-q8-diagnostic-v1',
    baseAbiVersion: 1,
    pointerRepresentation: 'bigint-u64',
    versionExport: diagnosticPrefix + 'version',
    schemaHashExport: diagnosticPrefix + 'schema_hash',
    recordQueryNamespace: diagnosticPrefix,
    functions: [
      {
        name: 'lcb_webgpu_q8_diagnostic_run_v1',
        export: diagnosticPrefix + 'run_v1',
        returnType: 'int32_t',
        returnKind: 'signed',
        suspension: 'jspi',
        parameters: ['backend', 'dst', 'request', 'report', 'report_capacity'].map((name, i) => ({ name, cType: i === 4 ? 'uint32_t' : 'uint64_t', kind: i === 4 ? 'unsigned' : 'u64' })),
      },
      {
        name: 'lcb_webgpu_q8_diagnostic_version',
        export: diagnosticPrefix + 'version',
        returnType: 'uint32_t',
        returnKind: 'unsigned',
        suspension: 'none',
        parameters: [{ name: 'backend', cType: 'uint64_t', kind: 'u64' }],
      },
    ],
    records: [record({ name: 'ggml_webgpu_q8_diagnostic_report_v1', id: 0, names: reportNames }), record({ name: 'ggml_webgpu_q8_diagnostic_request_v1', id: 1, names: requestNames })],
    constants: Object.keys(diagnosticConstants).map(name => constantPrefix + name + '_V1').sort(),
  };
  return { ...schema, schemaSha256: createHash('sha256').update(JSON.stringify(schema, undefined, 2) + '\n').digest('hex') };
}

export function schemaBytes({ schema }: { schema: ReturnType<typeof diagnosticSchemaFixture> }): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(schema, undefined, 2) + '\n');
}

/** The base allocator and ordinary ABI are real supplied CPU Wasm. Only the
 * optional extension is simulated; no WebGPU or diagnostic native code runs. */
export function createDiagnosticNativeFixture({ base }: { base: Core }) {
  const schema = diagnosticSchemaFixture();
  const hashPointer = base.alloc({ bytes: 64 });
  base.bytes({ pointer: hashPointer, length: 64 }).set(new TextEncoder().encode(schema.schemaSha256));
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
    padding: number, idShift: number, onFree: (() => void) | undefined, zeroDigest: boolean,
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
    idShift: 0,
    onFree: undefined,
    zeroDigest: false,
  };
  const span = ({ pointer, length }: { pointer: bigint, length: number }) => heap.subarray(Number(pointer), Number(pointer) + length);
  const read = ({ pointer, offset }: { pointer: bigint, offset: number }) => new DataView(heap.buffer, Number(pointer) + offset, 4).getUint32(0, true);
  const write = ({ pointer, offset, value }: { pointer: bigint, offset: number, value: number }) => new DataView(heap.buffer, Number(pointer) + offset, 4).setUint32(0, value, true);
  const native: Record<string, unknown> = {
    version: () => 1,
    schema_hash: () => hashPointer,
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Simulate the generated C export's positional ABI.
    sizeof_record: (id: number) => (id - state.idShift === 0 ? 112 : 24) + state.padding,
    alignof_record: () => 4,
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Simulate the generated C export's positional ABI.
    offsetof_field: (_id: number, field: number) => (field - state.idShift) * 4 + state.padding,
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Simulate the generated C export's positional ABI.
    sizeof_field: (id: number, field: number) => id - state.idShift === 0 && field - state.idShift === 20 ? 32 : 4,
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Simulate the generated C export's positional ABI.
    constant: (id: number) => diagnosticConstants[schema.constants[id]!.slice(constantPrefix.length, -3) as keyof typeof diagnosticConstants],
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
      if (property === '_lcb_malloc') {
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Preserve the allocator's C ABI.
        return (length: bigint) => {
          state.allocationCount++;
          if (state.oomAt === state.allocationCount) {
            return 0n;
          }
          const pointer = base.alloc({ bytes: length });
          allocations.add(pointer);
          return pointer;
        };
      }
      if (property === '_lcb_free') {
        // eslint-disable-next-line local-rules-named-args/require-named-args -- Preserve the allocator's C ABI.
        return (pointer: bigint) => {
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
    [Symbol.dispose]() {
      // These are CPU-only fixture allocations after the simulated call has
      // settled. Production never frees through a poisoned runtime.
      for (const pointer of allocations) {
        base.free({ pointer });
      }
      base.free({ pointer: hashPointer });
    },
  };
}
