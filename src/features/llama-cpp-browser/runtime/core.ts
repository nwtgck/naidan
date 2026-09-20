import { z } from 'zod';
import rawSchema from 'llama-cpp-browser-core/api/schema.mjs';
import type { LowLevelFunctions } from 'llama-cpp-browser-core/api/functions.js';
import type NativeFactory from 'llama-cpp-browser-core/profiles/cpu-wasm64/core.mjs';
import type { MainModule } from 'llama-cpp-browser-core/profiles/cpu-wasm64/core.mjs';
import type { LlamaCppProfile } from '@/features/llama-cpp-browser/types';

// The common chat surface used here has the same types in both pointer ABIs.
// Size-dependent C fields are accessed through the generated schema below.
export type CoreModule = Omit<MainModule, 'addFunction'> & {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Emscripten callback registration ABI.
  addFunction<TArgs extends (number | bigint)[]>(callback: (...args: TArgs) => number, signature: string): number | bigint,
};
const kindSchema = z.enum(['pointer', 'record', 'u64', 'i64', 'float', 'signed', 'unsigned', 'boolean', 'array', 'void']);
const schema = z.object({
  abiVersion: z.number().int(), schemaSha256: z.string(), constants: z.array(z.string()),
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
export function attachCore({ module, callMode }: { module: CoreModule, callMode: 'direct' | 'asyncify' }) {
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
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Adapt generated C ABI calls without changing their signatures.
    api[fn.name] = async (...args) => {
      assertIdle();
      const kinds = fn.parameters.map(parameter => parameter.kind);
      switch (fn.returnKind) {
      case 'record': kinds.unshift('pointer'); break;
      case 'pointer': case 'u64': case 'i64': case 'float': case 'signed': case 'unsigned': case 'boolean': case 'array': case 'void': break;
      default: { const exhaustive: never = fn.returnKind; throw new Error(`Unknown return kind: ${exhaustive}`); }
      }
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
        case 'direct': return await call(...args);
        case 'asyncify': {
          // Raw Asyncify exports can return before unwinding finishes. ccall waits for
          // the final result and keeps the serialization guard held during suspension.
          // The generated bridge uses bigint for pointers even in the wasm32 profile.
          const result: NativeScalar | void = await module.ccall(fn.export.slice(1),
            fn.returnKind === 'record' || fn.returnKind === 'void' ? undefined
              : ['pointer', 'u64', 'i64'].includes(fn.returnKind) ? 'bigint' : 'number',
            kinds.map(kind => ['pointer', 'record', 'u64', 'i64'].includes(kind) ? 'bigint' : 'number'),
            args, { async: true });
          return result;
        }
        default: { const exhaustive: never = callMode; throw new Error(`Unhandled native call mode: ${exhaustive}`); }
        }
      } finally {
        busy = false;
      }
    };
  }
  function record({ name }: { name: string }) {
    const entry = schema.records.find(entry => entry.name === name);
    if (!entry) throw new Error(`Unknown native record: ${name}`);
    return entry;
  }
  function fieldLayout({ name, field }: { name: string, field: string }) {
    const entry = record({ name }); const spec = entry.fields.find(spec => spec.name === field);
    if (!spec) throw new Error(`Unknown native field: ${name}.${field}`);
    const offset = BigInt(scalar({ name: '_lcb_offsetof_field', args: [entry.id, spec.id] }));
    const size = index({ value: scalar({ name: '_lcb_sizeof_field', args: [entry.id, spec.id] }) });
    return { kind: spec.kind, offset, size };
  }
  function field({ name, pointer, field }: { name: string, pointer: bigint, field: string }) {
    const { kind, offset, size } = fieldLayout({ name, field });
    const span = bytes({ pointer: pointer + offset, length: size });
    return { kind, size, view: new DataView(span.buffer, span.byteOffset, span.byteLength) };
  }
  function alloc({ bytes: length }: { bytes: NativeScalar }): bigint {
    assertIdle(); const size = index({ value: length });
    if (!size) throw new RangeError('Allocation must be nonempty');
    const pointer = BigInt(scalar({ name: '_lcb_malloc', args: [BigInt(size)] }));
    if (!pointer) throw new Error('Native allocation failed');
    return pointer;
  }
  const recordSize = ({ name }: { name: string }): number => index({ value: scalar({ name: '_lcb_sizeof_record', args: [record({ name }).id] }) });
  return {
    module, api: api as unknown as LowLevelFunctions, pointerBytes: pointerBytes as 4 | 8, assertIdle, bytes, alloc, recordSize, fieldLayout,
    enumValues({ prefix }: { prefix: string }): { name: string, value: number }[] {
      assertIdle();
      return schema.constants.flatMap((name, id) => name.startsWith(prefix) ? [{ name, value: Number(scalar({ name: '_lcb_constant', args: [id] })) }] : []);
    },
    free({ pointer }: { pointer: bigint }): void {
      assertIdle(); native({ name: '_lcb_free' })(pointer);
    },
    constant({ name }: { name: string }): number {
      const id = schema.constants.indexOf(name); if (id < 0) throw new Error(`Unknown native constant: ${name}`);
      const value = Number(scalar({ name: '_lcb_constant', args: [id] }));
      if (!Number.isSafeInteger(value)) throw new RangeError('Unsafe native constant');
      return value;
    },
    allocRecord({ name }: { name: string }): bigint {
      const size = recordSize({ name }); const pointer = alloc({ bytes: size }); bytes({ pointer, length: size }).fill(0); return pointer;
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
      const data = new TextEncoder().encode(text); const pointer = alloc({ bytes: data.length + 1 });
      const span = bytes({ pointer, length: data.length + 1 }); span.set(data); span[data.length] = 0; return pointer;
    },
  };
}
export type Core = ReturnType<typeof attachCore>;
export async function createCore({ profile, baseURL, moduleOptions }: {
  profile: LlamaCppProfile, baseURL: URL | string, moduleOptions: { wasmBinary: Uint8Array,
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Emscripten logging callback ABI.
    print: (message: unknown) => void,
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Emscripten logging callback ABI.
    printErr: (message: unknown) => void,
  },
}): Promise<Core> {
  const root = new URL(`${profile}/`, baseURL);
  const imported: unknown = await import(/* @vite-ignore */ new URL('core.mjs', root).href);
  const factory = z.object({ default: z.custom<typeof NativeFactory>(value => typeof value === 'function') }).parse(imported).default;
  const module = await factory({ ...moduleOptions,
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Emscripten module initialization callback ABI.
    locateFile: (path: string) => new URL(path, root).href,
  });
  switch (profile) {
  case 'webgpu-wasm32-asyncify': return attachCore({ module, callMode: 'asyncify' });
  case 'webgpu-wasm64-jspi': case 'cpu-wasm64': case 'cpu-wasm32': return attachCore({ module, callMode: 'direct' });
  default: { const exhaustive: never = profile; throw new Error(`Unhandled profile: ${exhaustive}`); }
  }
}
export const TEST_ONLY = {
};
