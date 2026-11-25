import { associateGpuRequests, createGpuRequestObserver } from './webgpu-request-diagnostics';
import { copyNativeUtf8 } from './native-utf8';
import { loadCoreModule, type CoreModuleOptions } from '@/features/llama-cpp-browser/runtime/artifacts';
import rawCatalog from 'llama-cpp-browser-core/llama-cpp/api/schema.mjs';
import { createAbiCaller, fromEmscriptenPointer, toEmscriptenPointer, type PublicKind } from 'llama-cpp-browser-core/llama-cpp/host/abi';
import { createLowLevelFunctions } from 'llama-cpp-browser-core/llama-cpp/api/functions';
import type { MainModule } from 'llama-cpp-browser-core/llama-cpp/profiles/webgpu-wasm64-jspi/browser/core.mjs';
import type { ChatParams, NativeChat } from './chat-bindings';
import { gpuProfilingProfile, usesWebGpu, type LlamaCppProfile } from '@/features/llama-cpp-browser/types';
import { createCoreWebGpuNavigator } from './webgpu-dispatch';
import { logDiagnostic } from '@/features/llama-cpp-browser/debug-log';
import type { Q8DiagnosticAccess, Q8KernelDiagnosticAdapter } from './q8-kernel-diagnostic';
import type { ModelGraphNativeExports } from '@/features/llama-cpp-browser/model-graph/native-exports';
import type { Q8DiagnosticFunctions } from 'llama-cpp-browser-core/llama-cpp/api/extensions';
import { attachVisionBf16Diagnostics } from './vision-bf16-diagnostics';

// Direct access is limited to metadata, allocation and fixed optional extensions.
// C calls use the shared marshaler; correlated Embind handles use chat-bindings.
export type CoreModule = Pick<MainModule,
  'HEAPU8' | 'FS' | 'ccall' | 'removeFunction' | 'string_vector' | 'llama_tokens'
  | 'llama_token_sequences' | 'common_reasoning_budget_init' | 'common_reasoning_budget_get_state'
  | 'common_reasoning_budget_get_end_match_copy' | 'common_reasoning_budget_state'
  | 'common_grammar_trigger' | 'common_grammar_triggers' | 'common_grammar_trigger_type'> & Partial<ModelGraphNativeExports> & {
  common_chat_params: new () => ChatParams;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Native allocator ABI.
  _malloc(bytes: number): number;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Native allocator ABI.
  _free(pointer: number): void;
  _bicore_abi_version(): number;
  _bicore_schema_hash(): number | bigint;
  _bicore_pointer_bytes(): number;
  _bicore_file_backed_rows_version?(): number;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Native-width pointer helper, enabled only by the Wasm64 capability.
  _bicore_model_file_backed_shard?(model: number | bigint): number;
  _lcb_webgpu_q8_diagnostic_version?: Q8DiagnosticFunctions['version'];
  _lcb_webgpu_q8_diagnostic_run_v1?: Q8DiagnosticFunctions['runV1'];
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Emscripten callback registration ABI.
  addFunction<TArgs extends (number | bigint)[]>(callback: (...args: TArgs) => number, signature: string): number | bigint,
};
type NativeScalar = number | bigint;

function index({ value }: { value: NativeScalar }): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError('Unsafe memory index');
  }
  return result;
}

export function attachCore({ module, callMode }: { module: CoreModule, callMode: 'direct' | 'asyncify' | 'jspi' }) {
  let busy = false;
  function assertIdle(): void {
    if (busy) {
      throw new Error('Serialize access while a native call is pending');
    }
  }
  const calls = createAbiCaller({
    module,
    schema: rawCatalog,
    suspension: callMode,
    gate: {
      enter() {
        assertIdle();
        busy = true;
      },
      leave() {
        busy = false;
      },
    },
  });
  const { schema } = calls;
  const { pointerBytes } = schema;
  const bytes = ({ pointer, length }: { pointer: bigint, length: NativeScalar }): Uint8Array => {
    const start = index({ value: pointer });
    const size = index({ value: length });
    const heap = module.HEAPU8;
    if (start > heap.length || size > heap.length - start) {
      throw new RangeError('Memory access out of bounds');
    }
    return heap.subarray(start, start + size);
  };
  // The typed invoker owns one completion Promise through native decoding and
  // gate release. The generated facade returns that Promise without wrapping it.
  const api = createLowLevelFunctions({ invoker: calls.invoker });
  // ABI metadata belongs to this module instance. Never retain heap views or
  // request/model pointers here: heap growth and allocator reuse are unrelated
  // to the immutable record layouts. Only known schema entries enter the maps.
  const records = new Map(schema.records.map(entry => [entry.name, entry]));
  const recordSizes = new Map<string, number>();
  const fieldLayouts = new Map<string, Map<string, Readonly<{ kind: PublicKind, offset: bigint, size: number }>>>();
  function record({ name }: { name: string }) {
    const entry = records.get(name);
    if (!entry) {
      throw new Error(`Unknown native record: ${name}`);
    }
    return entry;
  }
  function fieldLayout({ name, field }: { name: string, field: string }) {
    // Cache hits must not bypass the same native lifetime guard as misses.
    assertIdle();
    const cached = fieldLayouts.get(name)?.get(field);
    if (cached) {
      return cached;
    }
    const entry = record({ name });
    const spec = entry.fields.find(spec => spec.name === field);
    if (!spec) {
      throw new Error(`Unknown native field: ${name}.${field}`);
    }
    const offset = BigInt(spec.offset);
    const size = spec.size;
    // Publish only a fully read, immutable result. Failed queries remain misses.
    const layout = Object.freeze({ kind: spec.kind, offset, size });
    let fields = fieldLayouts.get(name);
    if (!fields) {
      fields = new Map();
      fieldLayouts.set(name, fields);
    }
    fields.set(field, layout);
    return layout;
  }
  function field({ name, pointer, field }: { name: string, pointer: bigint, field: string }) {
    const { kind, offset, size } = fieldLayout({ name, field });
    const span = bytes({ pointer: pointer + offset, length: size });
    return { kind, size, view: new DataView(span.buffer, span.byteOffset, span.byteLength) };
  }
  function tryAlloc({ bytes: length }: { bytes: NativeScalar }): bigint | undefined {
    assertIdle();
    const size = index({ value: length });
    if (!size) {
      throw new RangeError('Allocation must be nonempty');
    }
    const pointer = fromEmscriptenPointer({ value: module._malloc(toEmscriptenPointer({ value: BigInt(size), pointerBytes })), pointerBytes });
    return pointer === 0n ? undefined : pointer;
  }
  function alloc({ bytes }: { bytes: NativeScalar }): bigint {
    const pointer = tryAlloc({ bytes });
    if (pointer === undefined) {
      throw new Error('Native allocation failed');
    }
    return pointer;
  }
  const recordSize = ({ name }: { name: string }): number => {
    assertIdle();
    const cached = recordSizes.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const size = record({ name }).size;
    recordSizes.set(name, size);
    return size;
  };
  function free({ pointer }: { pointer: bigint }): void {
    assertIdle();
    module._free(toEmscriptenPointer({ value: pointer, pointerBytes }));
  }
  function constant({ name }: { name: string }): number {
    const encoded = schema.constantValues[name];
    if (encoded === undefined || !schema.constants.includes(name)) {
      throw new Error(`Unknown native constant: ${name}`);
    }
    const value = Number(BigInt(encoded));
    if (!Number.isSafeInteger(value)) {
      throw new RangeError('Unsafe native constant');
    }
    return value;
  }
  function q8KernelDiagnosticAvailability(): 'available' | 'unavailable' {
    assertIdle();
    const exports = [module._lcb_webgpu_q8_diagnostic_version, module._lcb_webgpu_q8_diagnostic_run_v1];
    const descriptor = schema.extensions?.['webgpu-q8-diagnostic-v1'];
    if (descriptor === undefined && exports.every(value => value === undefined)) {
      return 'unavailable';
    }
    if (descriptor === undefined || exports.some(value => typeof value !== 'function')) {
      throw new Error('Incomplete Q8 diagnostic native exports');
    }
    return 'available';
  }
  async function createQ8KernelDiagnostic(): Promise<Q8KernelDiagnosticAdapter | undefined> {
    const availability = q8KernelDiagnosticAvailability();
    switch (availability) {
    case 'unavailable': return undefined;
    case 'available': break;
    default: {
      const exhaustive: never = availability;
      throw new Error(`Unhandled Q8 diagnostic availability: ${exhaustive}`);
    }
    }
    const schemaSnapshot: unknown = structuredClone(schema.extensions?.['webgpu-q8-diagnostic-v1']);
    const version = module._lcb_webgpu_q8_diagnostic_version;
    const invoke = module._lcb_webgpu_q8_diagnostic_run_v1;
    if (typeof version !== 'function' || typeof invoke !== 'function') {
      throw new Error('Incomplete Q8 diagnostic native exports');
    }
    const diagnostic = await import('./q8-kernel-diagnostic');
    assertIdle();
    // This access object never leaves the adapter. Its owner can use only these
    // fixed leaves, and holds the ordinary busy gate through report cleanup.
    const access: Q8DiagnosticAccess = {
      assertIdle,
      async withAccess({ operation }) {
        assertIdle();
        busy = true;
        let active = true;
        let poisoned = false;
        function assertOwner() {
          if (!active || poisoned) {
            throw new Error('Q8 diagnostic runtime must be discarded');
          }
        }
        try {
          return await operation({
            owner: {
              isHealthy: () => active && !poisoned,
              poison() {
                poisoned = true;
              },
              version: ({ backend }) => {
                assertOwner();
                try {
                  const value = version(backend);
                  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
                    throw new TypeError('Expected synchronous Q8 diagnostic version');
                  }
                  return value;
                } catch (error) {
                  poisoned = true;
                  throw error;
                }
              },
              allocate: ({ length }) => {
                assertOwner();
                try {
                  const pointer = fromEmscriptenPointer({ value: module._malloc(toEmscriptenPointer({ value: BigInt(length), pointerBytes })), pointerBytes });
                  return pointer === 0n ? undefined : pointer;
                } catch (error) {
                  poisoned = true;
                  throw error;
                }
              },
              bytes: ({ pointer, length }) => {
                assertOwner();
                return bytes({ pointer, length });
              },
              free: ({ pointer }) => {
                assertOwner();
                try {
                  const result = module._free(toEmscriptenPointer({ value: pointer, pointerBytes }));
                  if (result !== undefined) {
                    throw new TypeError('Expected synchronous Q8 diagnostic release');
                  }
                } catch (error) {
                  poisoned = true;
                  throw error;
                }
              },
              async invoke({ backend, dst, request, report, capacity }) {
                assertOwner();
                try {
                  return await invoke(backend, dst, request, report, capacity);
                } catch (error) {
                  poisoned = true;
                  throw error;
                }
              },
            },
          });
        } finally {
          active = false;
          // A rejected suspension or corrupt report may still own borrowed
          // native objects. Keep the existing gate closed until Worker disposal.
          if (!poisoned) {
            busy = false;
          }
        }
      },
    };
    return diagnostic.createQ8KernelDiagnosticAdapter({ schema: schemaSnapshot, access });
  }
  return {
    module,
    api,
    pointerBytes,
    abiFingerprint: schema.schemaSha256,
    assertIdle,
    bytes,
    alloc,
    tryAlloc,
    recordSize,
    fieldLayout,
    visionBf16Diagnostics: attachVisionBf16Diagnostics({ schema, module, invoker: calls.invoker, assertIdle, alloc, bytes, free }),
    hasFunction({ name }: { name: string }): boolean {
      return schema.functions.some(fn => fn.name === name);
    },
    q8KernelDiagnosticAvailability,
    createQ8KernelDiagnostic,
    /** Prepare a read-only native callback reader while idle. This deliberately
     * does NOT expose general reentrant native calls. The allowed read-only getters
     * inspect buffer/capability metadata, do not allocate or suspend, and are
     * called synchronously while the tensor and its buffers are still alive. */
    createTensorPlacementReader() {
      assertIdle();
      const fields = Object.fromEntries(['op', 'type', 'ne', 'src', 'buffer', 'name', 'flags'].map(field => [field, fieldLayout({ name: 'ggml_tensor', field })]));
      const constantNames = ({ prefix }: { prefix: string }) => new Map(schema.constants.flatMap(name => name.startsWith(prefix) && !['GGML_OP_POOL_MAX', 'GGML_OP_POOL_AVG', 'GGML_OP_POOL_COUNT'].includes(name)
        ? [[constant({ name }), name] as const] : []));
      const ops = constantNames({ prefix: 'GGML_OP_' }), types = constantNames({ prefix: 'GGML_TYPE_' });
      // ABI 3 excludes these allocation-free getters from JSPI_EXPORTS. Their
      // original C exports remain synchronous while a compute call is pending.
      const capability = 'synchronous_direct_exports_v3' as const;
      const getter = ({ name }: { name: string }) => {
        const fn = schema.functions.find(fn => fn.name === name);
        const leaves = schema.callbackMetadata.getters.filter(entry => entry.name === name);
        if (!fn || leaves.length !== 1 || leaves[0]?.export !== fn.export) {
          throw new Error(`Missing diagnostic getter: ${name}`);
        }
        return ({ args }: { args: NativeScalar[] }): NativeScalar => {
          const result = calls.callSync({ name, args });
          if (typeof result !== 'number' && typeof result !== 'bigint') {
            throw new TypeError(`Expected synchronous scalar: ${name}`);
          }
          return result;
        };
      };
      const description = getter({ name: 'ggml_op_desc' });
      const computeFlag = constant({ name: 'GGML_TENSOR_FLAG_COMPUTE' });
      const bufferName = getter({ name: 'ggml_backend_buffer_name' });
      const bufferHost = getter({ name: 'ggml_backend_buffer_is_host' });
      const supports = getter({ name: 'ggml_backend_dev_supports_op' });
      const cstring = ({ pointer, limit }: { pointer: bigint, limit: number }): string => {
        if (pointer === 0n) {
          return '';
        }
        const size = Math.min(limit, module.HEAPU8.byteLength - index({ value: pointer }));
        const span = bytes({ pointer, length: size });
        const end = span.indexOf(0);
        return new TextDecoder().decode(span.subarray(0, end < 0 ? span.length : end));
      };
      const devices: bigint[] = [];
      const count = Number(getter({ name: 'ggml_backend_dev_count' })({ args: [] }));
      if (!Number.isSafeInteger(count) || count < 0 || count > 64) {
        throw new Error('Unexpected device registry size');
      }
      for (let i = 0; i < count; i++) {
        const device = BigInt(getter({ name: 'ggml_backend_dev_get' })({ args: [BigInt(i)] }));
        const name = cstring({ pointer: BigInt(getter({ name: 'ggml_backend_dev_name' })({ args: [device] })), limit: 160 });
        if (name.startsWith('WebGPU')) {
          devices.push(device);
        }
      }
      const view = ({ tensor, field }: { tensor: bigint, field: string }): DataView => {
        const layout = fields[field];
        if (!layout) {
          throw new Error(`Missing tensor field ${field}`);
        }
        const span = bytes({ pointer: tensor + layout.offset, length: layout.size });
        return new DataView(span.buffer, span.byteOffset, span.byteLength);
      };
      const ptr = ({ data, offset }: { data: DataView, offset: number }): bigint => pointerBytes === 8
        ? data.getBigUint64(offset, true) : BigInt(data.getUint32(offset, true));
      if (fields.flags?.size !== 4 || fields.op?.size !== 4 || fields.type?.size !== 4 || fields.ne?.size !== 32 || fields.buffer?.size !== pointerBytes
        || (fields.src?.size ?? 0) < pointerBytes * 2 || fields.name?.kind !== 'array') {
        throw new Error('Unsupported tensor metadata layout');
      }
      const tensorInfo = ({ tensor }: { tensor: bigint }) => {
        const data = view({ tensor, field: 'ne' });
        return {
          type: types.get(view({ tensor, field: 'type' }).getInt32(0, true)) ?? 'unknown',
          shape: [0, 1, 2, 3].map(axis => index({ value: data.getBigInt64(axis * 8, true) })),
        };
      };
      const tensorName = ({ tensor }: { tensor: bigint }): string => cstring({ pointer: tensor + fields.name!.offset, limit: Math.min(fields.name!.size, 96) });
      const bufferInfo = ({ tensor }: { tensor: bigint }) => {
        const buffer = ptr({ data: view({ tensor, field: 'buffer' }), offset: 0 });
        return {
          buffer: buffer === 0n ? 'unallocated' : cstring({ pointer: BigInt(bufferName({ args: [buffer] })), limit: 160 }),
          storage: buffer === 0n ? 'unknown' as const : bufferHost({ args: [buffer] }) ? 'host' as const : 'device' as const,
        };
      };
      const read = ({ tensor }: { tensor: bigint }) => {
        const op = ops.get(view({ tensor, field: 'op' }).getInt32(0, true)) ?? 'unknown';
        const sources = view({ tensor, field: 'src' });
        const source0 = ptr({ data: sources, offset: 0 });
        const source1 = ptr({ data: sources, offset: pointerBytes });
        const firstInput = source0 === 0n ? undefined : tensorInfo({ tensor: source0 });
        const inputs = firstInput === undefined ? [] : [firstInput];
        if (source1 !== 0n) {
          inputs.push(tensorInfo({ tensor: source1 }));
        }
        const sourceWeight = op === 'GGML_OP_MUL_MAT_ID' && firstInput?.type === 'GGML_TYPE_Q2_0'
          ? { name: tensorName({ tensor: source0 }), ...bufferInfo({ tensor: source0 }) } : undefined;
        return {
          op,
          description: cstring({ pointer: BigInt(description({ args: [tensor] })), limit: 96 }),
          compute: (view({ tensor, field: 'flags' }).getInt32(0, true) & computeFlag) !== 0,
          ...tensorInfo({ tensor }),
          inputs,
          name: tensorName({ tensor }),
          ...bufferInfo({ tensor }),
          ...(sourceWeight === undefined ? {} : { sourceWeight }),
          webgpuSupport: !devices.length ? 'unavailable' as const : devices.some(device => supports({ args: [device, tensor] })) ? 'supported' as const : 'unsupported' as const,
          metadataOnly: ['GGML_OP_NONE', 'GGML_OP_VIEW', 'GGML_OP_RESHAPE', 'GGML_OP_PERMUTE', 'GGML_OP_TRANSPOSE'].includes(op),
        };
      };
      return { read, capability };
    },
    enumValues({ prefix }: { prefix: string }): { name: string, value: number }[] {
      assertIdle();
      return schema.constants.flatMap(name => name.startsWith(prefix) ? [{ name, value: constant({ name }) }] : []);
    },
    free,
    constant,
    allocRecord({ name }: { name: string }): bigint {
      const size = recordSize({ name });
      const pointer = alloc({ bytes: size });
      try {
        bytes({ pointer, length: size }).fill(0);
        return pointer;
      } catch (error) {
        free({ pointer });
        throw error;
      }
    },
    setField({ name, pointer, field: fieldName, value }: { name: string, pointer: bigint, field: string, value: NativeScalar }): void {
      assertIdle();
      const { kind, size, view } = field({ name, pointer, field: fieldName });
      let signed = false;
      let booleanField = false;
      switch (kind) {
      case 'record': case 'array': case 'void': throw new TypeError('Expected scalar field');
      case 'float':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new TypeError('Expected finite value');
        }
        if (size === 4) {
          view.setFloat32(0, value, true);
        } else if (size === 8) {
          view.setFloat64(0, value, true);
        } else {
          throw new RangeError('Unsupported native float width');
        }
        return;
      case 'signed': case 'i64': signed = true;
        break;
      case 'boolean': booleanField = true;
        break;
      case 'unsigned': case 'pointer': case 'u64': break;
      default: {
        const exhaustive: never = kind;
        throw new Error(`Unknown field kind: ${exhaustive}`);
      }
      }
      if (typeof value === 'number' && !Number.isSafeInteger(value)) {
        throw new RangeError('Expected exact integer');
      }
      const integer = BigInt(value);
      const bits = BigInt(size * 8);
      if (integer < (signed ? -(1n << (bits - 1n)) : 0n) || integer > (booleanField ? 1n : signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n)) {
        throw new RangeError('Native field overflow');
      }
      if (size === 8) {
        if (signed) {
          view.setBigInt64(0, integer, true);
        } else {
          view.setBigUint64(0, integer, true);
        }
      } else if (size === 4) {
        if (signed) {
          view.setInt32(0, Number(integer), true);
        } else {
          view.setUint32(0, Number(integer), true);
        }
      } else if (size === 2) {
        if (signed) {
          view.setInt16(0, Number(integer), true);
        } else {
          view.setUint16(0, Number(integer), true);
        }
      } else if (size === 1) {
        if (signed) {
          view.setInt8(0, Number(integer));
        } else {
          view.setUint8(0, Number(integer));
        }
      } else {
        throw new RangeError('Unsupported native field width');
      }
    },
    utf8({ text }: { text: string }): bigint {
      assertIdle();
      return copyNativeUtf8({ core: { alloc, bytes, free }, data: new TextEncoder().encode(text) });
    },
  };
}

export type Core = ReturnType<typeof attachCore> & { chat: NativeChat };

function wasmModuleBinary({ binary }: { binary: CoreModuleOptions['wasmBinary'] }): ArrayBuffer {
  if (!binary || binary.byteLength === 0) {
    throw new Error('Browser core requires supplied wasmBinary');
  }
  if (binary instanceof ArrayBuffer) {
    return binary;
  }
  // Emscripten creates a view over an ArrayBuffer without copying its payload.
  // Partial views need an exact buffer; shared views need an ordinary buffer.
  if (binary.buffer instanceof ArrayBuffer && binary.byteOffset === 0 && binary.byteLength === binary.buffer.byteLength) {
    return binary.buffer;
  }
  return new Uint8Array(binary).buffer;
}

export async function createCore({ profile, baseURL, moduleOptions }: {
  profile: LlamaCppProfile, baseURL: URL | string | undefined, moduleOptions: CoreModuleOptions,
}): Promise<Core> {
  const wasmBinary = wasmModuleBinary({ binary: moduleOptions.wasmBinary });
  const gpuRequests = createGpuRequestObserver();
  // No diagnostic import, buffer hooks or timestamp resources in ordinary chat.
  const profiler = profile === gpuProfilingProfile ? (await import('./gpu-profiler')).createGpuProfileObserver() : undefined;
  const options: CoreModuleOptions = usesWebGpu({ profile }) ? {
    ...moduleOptions,
    wasmBinary,
    hostNavigator: createCoreWebGpuNavigator({
      navigator: globalThis.navigator,
      observeDevice: profiler ? ({ device, adapter, gpu }) => gpuRequests.wrapDevice({ device: profiler.wrapDevice({ device }), adapter, gpu }) : gpuRequests.wrapDevice,
      report({ axis, count, limit, chunks }) {
        logDiagnostic({
          diagnostic: {
            event: 'native-info',
            nativeOperation: 'dispatch-split',
            nativeBackend: 'WebGPU',
            dispatchAxis: axis,
            dispatchCount: count,
            dispatchLimit: limit,
            chunkCount: chunks,
          },
        });
      },
    }),
  } : { ...moduleOptions, wasmBinary };
  const { module, chat } = await loadCoreModule({ profile, baseURL, moduleOptions: options });
  switch (profile) {
  case 'webgpu-wasm32-asyncify': {
    const core = { ...attachCore({ module, callMode: 'asyncify' }), chat };
    associateGpuRequests({ core, snapshot: gpuRequests.snapshot });
    return core;
  }
  case 'webgpu-wasm64-jspi-gpu-profile':
  case 'webgpu-wasm64-jspi': case 'webgpu-wasm32-jspi': {
    const core = { ...attachCore({ module, callMode: 'jspi' }), chat };
    associateGpuRequests({ core, snapshot: gpuRequests.snapshot });
    return core;
  }
  case 'cpu-wasm32': return { ...attachCore({ module, callMode: 'direct' }), chat };
  default: {
    const exhaustive: never = profile;
    throw new Error(`Unhandled profile: ${exhaustive}`);
  }
  }
}

export const TEST_ONLY = {
};
