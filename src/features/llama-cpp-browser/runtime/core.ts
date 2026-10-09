import { associateGpuRequests, createGpuRequestObserver } from './webgpu-request-diagnostics';
import { copyNativeUtf8 } from './native-utf8';
import { loadCoreModule, type CoreModuleOptions } from '@/features/llama-cpp-browser/runtime/artifacts';
import { z } from 'zod';
import rawSchema from 'llama-cpp-browser-core/api/schema.mjs';
import type { LowLevelFunctions } from 'llama-cpp-browser-core/api/functions.js';
import type { MainModule } from 'llama-cpp-browser-core/profiles/cpu-wasm64/browser/core.mjs';
import type { ChatParams, NativeChat } from './chat-bindings';
import { usesWebGpu, type LlamaCppProfile } from '@/features/llama-cpp-browser/types';
import { createCoreWebGpuNavigator } from './webgpu-dispatch';
import { logDiagnostic } from '@/features/llama-cpp-browser/debug-log';

// Direct access is restricted to width-independent runtime exports. Size-dependent
// C fields use the generated schema; correlated Embind handles use chat-bindings.
export type CoreModule = Pick<MainModule,
  'HEAPU8' | 'FS' | 'ccall' | 'removeFunction' | 'string_vector' | 'llama_tokens'
  | 'llama_token_sequences' | 'common_reasoning_budget_init' | 'common_reasoning_budget_get_state'
  | 'common_reasoning_budget_get_end_match_copy' | 'common_reasoning_budget_state'
  | 'common_grammar_trigger' | 'common_grammar_triggers' | 'common_grammar_trigger_type'> & {
  common_chat_params: new () => ChatParams;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Emscripten callback registration ABI.
  addFunction<TArgs extends (number | bigint)[]>(callback: (...args: TArgs) => number, signature: string): number | bigint,
};
const kindSchema = z.enum(['pointer', 'record', 'u64', 'i64', 'float', 'signed', 'unsigned', 'boolean', 'array', 'void']);
const schema = z.object({
  abiVersion: z.number().int(),
  schemaSha256: z.string(),
  constants: z.array(z.string()),
  records: z.array(z.object({ name: z.string(), id: z.number().int(), fields: z.array(z.object({ name: z.string(), id: z.number().int(), kind: kindSchema })) })),
  functions: z.array(z.object({ name: z.string(), export: z.string(), returnKind: kindSchema, parameters: z.array(z.object({ kind: kindSchema })) })),
}).parse(rawSchema);
type NativeScalar = number | bigint;
// Positional calls are confined to the generated native ABI, not application APIs.
// eslint-disable-next-line local-rules-named-args/require-named-args -- Generated C ABI functions have positional scalar arguments.
type NativeCall = (...args: NativeScalar[]) => NativeScalar | void | Promise<NativeScalar | void>;
function index({ value }: { value: NativeScalar }): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new RangeError('Unsafe memory index');
  return result;
}
export function attachCore({ module, callMode }: { module: CoreModule, callMode: 'direct' | 'asyncify' | 'jspi' }) {
  function native({ name }: { name: string }): NativeCall {
    const value: unknown = Reflect.get(module, name);
    if (typeof value !== 'function') throw new Error(`Missing native export: ${name}`);
    return value as NativeCall;
  }
  function scalar({ name, args }: { name: string, args: NativeScalar[] }): NativeScalar {
    const result = native({ name })(...args);
    if (typeof result !== 'number' && typeof result !== 'bigint') throw new TypeError(`Expected synchronous scalar: ${name}`);
    return result;
  }
  const bytes = ({ pointer, length }: { pointer: bigint, length: NativeScalar }): Uint8Array => {
    const start = index({ value: pointer }); const size = index({ value: length });
    const heap = module.HEAPU8;
    if (start > heap.length || size > heap.length - start) throw new RangeError('Memory access out of bounds');
    return heap.subarray(start, start + size);
  };
  if (scalar({ name: '_lcb_abi_version', args: [] }) !== schema.abiVersion) throw new Error('Native ABI mismatch');
  const hash = BigInt(scalar({ name: '_lcb_schema_hash', args: [] }));
  if (new TextDecoder().decode(bytes({ pointer: hash, length: 64 })) !== schema.schemaSha256) throw new Error('Native schema mismatch');
  const pointerBytes = Number(scalar({ name: '_lcb_pointer_bytes', args: [] }));
  if (pointerBytes !== 4 && pointerBytes !== 8) throw new Error('Unsupported pointer ABI');
  let busy = false;
  function assertIdle(): void {
    if (busy) throw new Error('Serialize access while a native call is pending');
  }
  const api: Record<string, NativeCall> = Object.create(null);
  for (const fn of schema.functions) {
    const call = native({ name: fn.export });
    // The generated signature belongs to the bound module, not to one call.
    // Keep validating actual arguments and holding the suspension guard below.
    const kinds = fn.parameters.map(parameter => parameter.kind);
    switch (fn.returnKind) {
    case 'record': kinds.unshift('pointer'); break;
    case 'pointer': case 'u64': case 'i64': case 'float': case 'signed': case 'unsigned': case 'boolean': case 'array': case 'void': break;
    default: { const exhaustive: never = fn.returnKind; throw new Error(`Unknown return kind: ${exhaustive}`); }
    }
    const ccallName = fn.export.slice(1);
    const ccallReturn = fn.returnKind === 'record' || fn.returnKind === 'void' ? undefined
      : ['pointer', 'u64', 'i64'].includes(fn.returnKind) ? 'bigint' : 'number';
    const ccallKinds = kinds.map(kind => ['pointer', 'record', 'u64', 'i64'].includes(kind) ? 'bigint' as const : 'number' as const);
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Adapt generated C ABI calls without changing their signatures.
    api[fn.name] = async (...args) => {
      assertIdle();
      if (args.length !== kinds.length) throw new TypeError(`Incorrect native argument count: ${fn.name}`);
      for (const [i, kind] of kinds.entries()) {
        const value = args[i];
        let minimum: number | bigint; let maximum: number | bigint; let integer = true;
        switch (kind) {
        case 'pointer': case 'record': case 'u64': minimum = 0n; maximum = (1n << 64n) - 1n; break;
        case 'i64': minimum = -(1n << 63n); maximum = (1n << 63n) - 1n; break;
        case 'signed': minimum = -2147483648; maximum = 2147483647; break;
        case 'unsigned': minimum = 0; maximum = 4294967295; break;
        case 'boolean': minimum = 0; maximum = 1; break;
        case 'float': minimum = -Infinity; maximum = Infinity; integer = false; break;
        case 'array': case 'void': throw new TypeError('Invalid native argument kind');
        default: { const exhaustive: never = kind; throw new Error(`Unknown argument kind: ${exhaustive}`); }
        }
        if (typeof minimum === 'bigint') {
          if (typeof value !== 'bigint' || value < minimum || value > maximum) throw new RangeError('Invalid native 64-bit argument');
        } else if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < minimum || value > maximum) throw new RangeError('Invalid native numeric argument');
      }
      busy = true;
      try {
        switch (callMode) {
        case 'direct': case 'jspi': return await call(...args);
        case 'asyncify': {
          // Raw Asyncify exports can return before unwinding finishes. ccall waits for
          // the final result and keeps the serialization guard held during suspension.
          // The generated bridge uses bigint for pointers even in the wasm32 profile.
          const result: NativeScalar | void = await module.ccall(ccallName, ccallReturn, ccallKinds, args, { async: true });
          return result;
        }
        default: { const exhaustive: never = callMode; throw new Error(`Unhandled native call mode: ${exhaustive}`); }
        }
      } finally {
        busy = false;
      }
    };
  }
  // ABI metadata belongs to this module instance. Never retain heap views or
  // request/model pointers here: heap growth and allocator reuse are unrelated
  // to the immutable record layouts. Only known schema entries enter the maps.
  const records = new Map(schema.records.map(entry => [entry.name, entry]));
  const recordSizes = new Map<string, number>();
  const fieldLayouts = new Map<string, Map<string, Readonly<{ kind: z.infer<typeof kindSchema>, offset: bigint, size: number }>>>();
  function record({ name }: { name: string }) {
    const entry = records.get(name);
    if (!entry) throw new Error(`Unknown native record: ${name}`);
    return entry;
  }
  function fieldLayout({ name, field }: { name: string, field: string }) {
    // Cache hits must not bypass the same native lifetime guard as misses.
    assertIdle();
    const cached = fieldLayouts.get(name)?.get(field);
    if (cached) return cached;
    const entry = record({ name }); const spec = entry.fields.find(spec => spec.name === field);
    if (!spec) throw new Error(`Unknown native field: ${name}.${field}`);
    const offset = BigInt(index({ value: scalar({ name: '_lcb_offsetof_field', args: [entry.id, spec.id] }) }));
    const size = index({ value: scalar({ name: '_lcb_sizeof_field', args: [entry.id, spec.id] }) });
    // Publish only a fully read, immutable result. Failed queries remain misses.
    const layout = Object.freeze({ kind: spec.kind, offset, size });
    let fields = fieldLayouts.get(name);
    if (!fields) {
      fields = new Map(); fieldLayouts.set(name, fields);
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
    assertIdle(); const size = index({ value: length });
    if (!size) throw new RangeError('Allocation must be nonempty');
    const pointer = BigInt(scalar({ name: '_lcb_malloc', args: [BigInt(size)] }));
    return pointer === 0n ? undefined : pointer;
  }
  function alloc({ bytes }: { bytes: NativeScalar }): bigint {
    const pointer = tryAlloc({ bytes });
    if (pointer === undefined) throw new Error('Native allocation failed');
    return pointer;
  }
  const recordSize = ({ name }: { name: string }): number => {
    assertIdle();
    const cached = recordSizes.get(name);
    if (cached !== undefined) return cached;
    const size = index({ value: scalar({ name: '_lcb_sizeof_record', args: [record({ name }).id] }) });
    recordSizes.set(name, size);
    return size;
  };
  function free({ pointer }: { pointer: bigint }): void {
    assertIdle(); native({ name: '_lcb_free' })(pointer);
  }
  return {
    module,
    api: api as unknown as LowLevelFunctions,
    pointerBytes: pointerBytes as 4 | 8,
    assertIdle,
    bytes,
    alloc,
    tryAlloc,
    recordSize,
    fieldLayout,
    /** Prepare a read-only native callback reader while idle. This deliberately
     * does NOT expose general reentrant native calls. The allowed read-only getters
     * inspect buffer/capability metadata, do not allocate or suspend, and are
     * called synchronously while the tensor and its buffers are still alive. */
    createTensorPlacementReader() {
      assertIdle();
      const fields = Object.fromEntries(['op', 'type', 'ne', 'src', 'buffer', 'name', 'flags'].map(field => [field, fieldLayout({ name: 'ggml_tensor', field })]));
      const constantNames = ({ prefix }: { prefix: string }) => new Map(schema.constants.flatMap((name, id) => name.startsWith(prefix) && !['GGML_OP_POOL_MAX', 'GGML_OP_POOL_AVG', 'GGML_OP_POOL_COUNT'].includes(name)
        ? [[Number(scalar({ name: '_lcb_constant', args: [id] })), name] as const] : []));
      const ops = constantNames({ prefix: 'GGML_OP_' }), types = constantNames({ prefix: 'GGML_TYPE_' });
      // JSPI wraps ordinary exports in WebAssembly.promising(), even getters
      // that never suspend. Never invoke those exports inside a synchronous
      // native callback. A versioned binding-layer surface keeps this contract
      // explicit; old JSPI artifacts can still provide safe layout-only data.
      const versionExport: unknown = Reflect.get(module, '_lcb_callback_metadata_version');
      const hasCallbackBindings = typeof versionExport === 'function';
      if (hasCallbackBindings && scalar({ name: '_lcb_callback_metadata_version', args: [] }) !== 1) throw new Error('Unsupported callback metadata binding version');
      const capability = (() => {
        if (hasCallbackBindings) return 'synchronous-leaf-bindings-v1' as const;
        switch (callMode) {
        case 'jspi': return 'tensor-layout-only' as const;
        case 'direct': case 'asyncify': return 'legacy-synchronous-getters' as const;
        default: { const exhaustive: never = callMode; throw new Error(String(exhaustive)); }
        }
      })();
      const gettersAvailable = capability !== 'tensor-layout-only';
      const getter = ({ name }: { name: string }) => {
        const fn = schema.functions.find(fn => fn.name === name);
        if (!fn) throw new Error(`Missing diagnostic getter: ${name}`);
        const exportName = hasCallbackBindings ? `_lcb_callback_${name}` : fn.export;
        if (gettersAvailable) native({ name: exportName }); // Fail during setup, not per node.
        return ({ args }: { args: NativeScalar[] }): NativeScalar => {
          if (!gettersAvailable) throw new Error('Synchronous callback getter unavailable');
          return scalar({ name: exportName, args });
        };
      };
      const description = getter({ name: 'ggml_op_desc' });
      const computeFlagId = schema.constants.indexOf('GGML_TENSOR_FLAG_COMPUTE');
      if (computeFlagId < 0) throw new Error('Missing tensor compute flag');
      const computeFlag = Number(scalar({ name: '_lcb_constant', args: [computeFlagId] }));
      const bufferName = getter({ name: 'ggml_backend_buffer_name' });
      const bufferHost = getter({ name: 'ggml_backend_buffer_is_host' });
      const supports = getter({ name: 'ggml_backend_dev_supports_op' });
      const cstring = ({ pointer, limit }: { pointer: bigint, limit: number }): string => {
        if (pointer === 0n) return '';
        const size = Math.min(limit, module.HEAPU8.byteLength - index({ value: pointer }));
        const span = bytes({ pointer, length: size });
        const end = span.indexOf(0);
        return new TextDecoder().decode(span.subarray(0, end < 0 ? span.length : end));
      };
      const devices: bigint[] = [];
      const count = gettersAvailable ? Number(getter({ name: 'ggml_backend_dev_count' })({ args: [] })) : 0;
      if (!Number.isSafeInteger(count) || count < 0 || count > 64) throw new Error('Unexpected device registry size');
      for (let i = 0; i < count; i++) {
        const device = BigInt(getter({ name: 'ggml_backend_dev_get' })({ args: [BigInt(i)] }));
        const name = cstring({ pointer: BigInt(getter({ name: 'ggml_backend_dev_name' })({ args: [device] })), limit: 160 });
        if (name.startsWith('WebGPU')) devices.push(device);
      }
      const view = ({ tensor, field }: { tensor: bigint, field: string }): DataView => {
        const layout = fields[field];
        if (!layout) throw new Error(`Missing tensor field ${field}`);
        const span = bytes({ pointer: tensor + layout.offset, length: layout.size });
        return new DataView(span.buffer, span.byteOffset, span.byteLength);
      };
      const ptr = ({ data, offset }: { data: DataView, offset: number }): bigint => pointerBytes === 8
        ? data.getBigUint64(offset, true) : BigInt(data.getUint32(offset, true));
      if (fields.flags?.size !== 4 || fields.op?.size !== 4 || fields.type?.size !== 4 || fields.ne?.size !== 32 || fields.buffer?.size !== pointerBytes
        || (fields.src?.size ?? 0) < pointerBytes * 2 || fields.name?.kind !== 'array') throw new Error('Unsupported tensor metadata layout');
      const tensorInfo = ({ tensor }: { tensor: bigint }) => {
        const data = view({ tensor, field: 'ne' });
        return {
          type: types.get(view({ tensor, field: 'type' }).getInt32(0, true)) ?? 'unknown',
          shape: [0, 1, 2, 3].map(axis => index({ value: data.getBigInt64(axis * 8, true) })),
        };
      };
      const read = ({ tensor }: { tensor: bigint }) => {
        const op = ops.get(view({ tensor, field: 'op' }).getInt32(0, true)) ?? 'unknown';
        const buffer = ptr({ data: view({ tensor, field: 'buffer' }), offset: 0 });
        const sources = view({ tensor, field: 'src' });
        const inputs = [0, 1].flatMap(axis => {
          const source = ptr({ data: sources, offset: axis * pointerBytes });
          return source === 0n ? [] : [tensorInfo({ tensor: source })];
        });
        return {
          op,
          description: gettersAvailable ? cstring({ pointer: BigInt(description({ args: [tensor] })), limit: 96 }) : op,
          compute: (view({ tensor, field: 'flags' }).getInt32(0, true) & computeFlag) !== 0,
          ...tensorInfo({ tensor }),
          inputs,
          name: cstring({ pointer: tensor + fields.name!.offset, limit: Math.min(fields.name!.size, 96) }),
          buffer: buffer === 0n ? 'unallocated' : !gettersAvailable ? 'unavailable' : cstring({ pointer: BigInt(bufferName({ args: [buffer] })), limit: 160 }),
          storage: buffer === 0n || !gettersAvailable ? 'unknown' as const : bufferHost({ args: [buffer] }) ? 'host' as const : 'device' as const,
          webgpuSupport: !devices.length ? 'unavailable' as const : devices.some(device => supports({ args: [device, tensor] })) ? 'supported' as const : 'unsupported' as const,
          metadataOnly: ['GGML_OP_NONE', 'GGML_OP_VIEW', 'GGML_OP_RESHAPE', 'GGML_OP_PERMUTE', 'GGML_OP_TRANSPOSE'].includes(op),
        };
      };
      return { read, capability };
    },
    enumValues({ prefix }: { prefix: string }): { name: string, value: number }[] {
      assertIdle();
      return schema.constants.flatMap((name, id) => name.startsWith(prefix) ? [{ name, value: Number(scalar({ name: '_lcb_constant', args: [id] })) }] : []);
    },
    free,
    constant({ name }: { name: string }): number {
      const id = schema.constants.indexOf(name); if (id < 0) throw new Error(`Unknown native constant: ${name}`);
      const value = Number(scalar({ name: '_lcb_constant', args: [id] }));
      if (!Number.isSafeInteger(value)) throw new RangeError('Unsafe native constant');
      return value;
    },
    allocRecord({ name }: { name: string }): bigint {
      const size = recordSize({ name }); const pointer = alloc({ bytes: size });
      try {
        bytes({ pointer, length: size }).fill(0);
        return pointer;
      } catch (error) {
        free({ pointer });
        throw error;
      }
    },
    setField({ name, pointer, field: fieldName, value }: { name: string, pointer: bigint, field: string, value: NativeScalar }): void {
      assertIdle(); const { kind, size, view } = field({ name, pointer, field: fieldName });
      let signed = false; let booleanField = false;
      switch (kind) {
      case 'record': case 'array': case 'void': throw new TypeError('Expected scalar field');
      case 'float':
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Expected finite value');
        if (size === 4) view.setFloat32(0, value, true); else view.setFloat64(0, value, true);
        return;
      case 'signed': case 'i64': signed = true; break;
      case 'boolean': booleanField = true; break;
      case 'unsigned': case 'pointer': case 'u64': break;
      default: { const exhaustive: never = kind; throw new Error(`Unknown field kind: ${exhaustive}`); }
      }
      if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new RangeError('Expected exact integer');
      const integer = BigInt(value); const bits = BigInt(size * 8);
      if (integer < (signed ? -(1n << (bits - 1n)) : 0n) || integer > (booleanField ? 1n : signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n)) throw new RangeError('Native field overflow');
      if (size === 8) {
        if (signed) view.setBigInt64(0, integer, true); else view.setBigUint64(0, integer, true);
      } else if (size === 4) {
        if (signed) view.setInt32(0, Number(integer), true); else view.setUint32(0, Number(integer), true);
      } else if (size === 2) {
        if (signed) view.setInt16(0, Number(integer), true); else view.setUint16(0, Number(integer), true);
      } else if (size === 1) {
        if (signed) view.setInt8(0, Number(integer)); else view.setUint8(0, Number(integer));
      } else throw new RangeError('Unsupported native field width');
    },
    utf8({ text }: { text: string }): bigint {
      assertIdle();
      return copyNativeUtf8({ core: { alloc, bytes, free }, data: new TextEncoder().encode(text) });
    },
  };
}
export type Core = ReturnType<typeof attachCore> & { chat: NativeChat };
export async function createCore({ profile, baseURL, moduleOptions }: {
  profile: LlamaCppProfile, baseURL: URL | string | undefined, moduleOptions: CoreModuleOptions,
}): Promise<Core> {
  const gpuRequests = createGpuRequestObserver();
  const options: CoreModuleOptions = usesWebGpu({ profile }) ? {
    ...moduleOptions,
    naidanNavigator: createCoreWebGpuNavigator({
      navigator: globalThis.navigator,
      observeDevice: gpuRequests.wrapDevice,
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
  } : moduleOptions;
  const { module, chat } = await loadCoreModule({ profile, baseURL, moduleOptions: options });
  switch (profile) {
  case 'webgpu-wasm32-asyncify': {
    const core = { ...attachCore({ module, callMode: 'asyncify' }), chat };
    associateGpuRequests({ core, snapshot: gpuRequests.snapshot }); return core;
  }
  case 'webgpu-wasm64-jspi': case 'webgpu-wasm32-jspi': {
    const core = { ...attachCore({ module, callMode: 'jspi' }), chat };
    associateGpuRequests({ core, snapshot: gpuRequests.snapshot }); return core;
  }
  case 'cpu-wasm64': case 'cpu-wasm32': return { ...attachCore({ module, callMode: 'direct' }), chat };
  default: { const exhaustive: never = profile; throw new Error(`Unhandled profile: ${exhaustive}`); }
  }
}
export const TEST_ONLY = {
};
