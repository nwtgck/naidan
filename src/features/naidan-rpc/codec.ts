import { check, FRAME_BYTES, ownBytes, validKey, NaidanRpcPublicError } from '@/features/naidan-rpc/primitives';

export type ReferenceMode = 'bytes' | 'items' | 'callback';
/** A protocol capability is not a user object with a magic property. */
export class Reference {
  readonly id: number;
  readonly mode: ReferenceMode;
  constructor({ id, mode }: { id: number; mode: ReferenceMode }) {
    this.id = id; this.mode = mode;
  }
}
export type WireValue = undefined | boolean | number | string | Uint8Array | Reference | WireValue[] | { [key: string]: WireValue };
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function enforceCodecLimit({ constraint, limit, observed }: { constraint: string; limit: number; observed: number }): void {
  if (observed > limit) throw new NaidanRpcPublicError({ code: 'RESOURCE_EXHAUSTED', details: { scope: 'rpc-codec', constraint, limit, observed } });
}
function utf8({ text }: { text: string }): Uint8Array<ArrayBuffer> {
  // TextEncoder would silently replace unmatched UTF-16 surrogates.
  for (let at = 0; at < text.length; at++) {
    const value = text.charCodeAt(at);
    if (value >= 0xd800 && value <= 0xdbff) {
      const next = text.charCodeAt(++at);
      check({ condition: next >= 0xdc00 && next <= 0xdfff, code: 'INVALID_ARGUMENT' });
    } else check({ condition: value < 0xdc00 || value > 0xdfff, code: 'INVALID_ARGUMENT' });
  }
  return encoder.encode(text);
}
/** A closed RFC 8949 subset: definite lengths, string keys, finite numbers and two application-local tags. */
export function encode({ value, limit }: { value: unknown; limit: number }): Uint8Array<ArrayBuffer> {
  check({ condition: Number.isInteger(limit) && limit >= 1 && limit <= FRAME_BYTES, code: 'INVALID_ARGUMENT' });
  const buffer = new Uint8Array(limit), view = new DataView(buffer.buffer);
  let at = 0, nodes = 0;
  const ancestors = new Set<object>();
  const reserve = ({ count }: { count: number }) => enforceCodecLimit({ constraint: 'encoded-bytes', limit, observed: at + count });
  const byte = ({ value }: { value: number }) => {
    reserve({ count: 1 }); buffer[at++] = value;
  };
  const raw = ({ bytes }: { bytes: Uint8Array }) => {
    reserve({ count: bytes.length }); buffer.set(bytes, at); at += bytes.length;
  };
  const head = ({ major, value }: { major: number; value: number }) => {
    check({ condition: Number.isSafeInteger(value) && value >= 0, code: 'INVALID_ARGUMENT' });
    if (value < 24) byte({ value: major * 32 + value });
    else if (value < 256) {
      byte({ value: major * 32 + 24 }); byte({ value });
    } else if (value <= 65535) {
      byte({ value: major * 32 + 25 }); reserve({ count: 2 }); view.setUint16(at, value, false); at += 2;
    } else if (value <= 0xffffffff) {
      byte({ value: major * 32 + 26 }); reserve({ count: 4 }); view.setUint32(at, value, false); at += 4;
    } else {
      byte({ value: major * 32 + 27 }); reserve({ count: 8 }); view.setBigUint64(at, BigInt(value), false); at += 8;
    }
  };
  const visit = ({ value, depth }: { value: unknown; depth: number }): void => {
    enforceCodecLimit({ constraint: 'value-nodes', limit: 8192, observed: ++nodes });
    enforceCodecLimit({ constraint: 'value-depth', limit: 32, observed: depth });
    if (value === undefined) {
      byte({ value: 0xf7 }); return;
    }
    switch (typeof value) {
    case 'boolean': byte({ value: value ? 0xf5 : 0xf4 }); return;
    case 'number':
      check({ condition: Number.isFinite(value), code: 'INVALID_ARGUMENT' });
      if (Number.isSafeInteger(value) && !Object.is(value, -0)) head({ major: value >= 0 ? 0 : 1, value: value >= 0 ? value : -1 - value });
      else {
        byte({ value: 0xfb }); reserve({ count: 8 }); view.setFloat64(at, value, false); at += 8;
      }
      return;
    case 'string': { enforceCodecLimit({ constraint: 'string-code-units', limit, observed: value.length }); const bytes = utf8({ text: value }); head({ major: 3, value: bytes.length }); raw({ bytes }); return; }
    case 'object': break;
    default: throw new Error('Unsupported RPC value');
    }
    check({ condition: value !== null, code: 'INVALID_ARGUMENT' });
    if (value === null) throw new Error('Null is not a missing-value marker');
    if (value instanceof Uint8Array) {
      enforceCodecLimit({ constraint: 'byte-array-bytes', limit, observed: value.byteLength });
      const bytes = ownBytes({ bytes: value }); head({ major: 2, value: bytes.length }); raw({ bytes }); return;
    }
    if (value instanceof Reference) {
      check({ condition: Number.isInteger(value.id) && value.id > 0 && value.id <= 65535, code: 'INVALID_ARGUMENT' });
      switch (value.mode) {
      case 'callback': head({ major: 6, value: 0x4e52504302 }); head({ major: 0, value: value.id }); return;
      case 'bytes': case 'items':
        head({ major: 6, value: 0x4e52504301 }); head({ major: 4, value: 2 }); head({ major: 0, value: value.id });
        head({ major: 0, value: streamMode({ mode: value.mode }) }); return;
      default: { const never: never = value.mode; throw new Error(String(never)); }
      }
    }
    check({ condition: !ancestors.has(value), code: 'INVALID_ARGUMENT' }); ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        check({ condition: Object.keys(value).length === value.length && value.length <= 4096 && Object.getOwnPropertySymbols(value).length === 0, code: 'INVALID_ARGUMENT' });
        head({ major: 4, value: value.length });
        for (let index = 0; index < value.length; index++) {
          const property = Object.getOwnPropertyDescriptor(value, String(index));
          check({ condition: property !== undefined && 'value' in property, code: 'INVALID_ARGUMENT' });
          visit({ value: property?.value, depth: depth + 1 });
        }
        return;
      }
      check({ condition: Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, code: 'INVALID_ARGUMENT' });
      const properties = Object.getOwnPropertyDescriptors(value), keys = Object.keys(properties);
      check({ condition: Object.getOwnPropertySymbols(value).length === 0 && keys.length <= 4096, code: 'INVALID_ARGUMENT' });
      head({ major: 5, value: keys.length });
      for (const key of keys) {
        const property = properties[key];
        check({ condition: validKey({ key }) && property?.enumerable && 'value' in property, code: 'INVALID_ARGUMENT' });
        visit({ value: key, depth: depth + 1 }); visit({ value: property?.value, depth: depth + 1 });
      }
    } finally {
      ancestors.delete(value);
    }
  };
  visit({ value, depth: 0 }); return buffer.slice(0, at);
}
export function decode({ bytes }: { bytes: Uint8Array }): WireValue {
  check({ condition: bytes.length <= FRAME_BYTES, code: 'RESOURCE_EXHAUSTED' });
  const input = ownBytes({ bytes }), view = new DataView(input.buffer);
  let at = 0, nodes = 0;
  const take = ({ count }: { count: number }) => {
    check({ condition: count >= 0 && at + count <= input.length, code: 'PROTOCOL_ERROR' });
    const begin = at; at += count; return begin;
  };
  const argument = ({ info }: { info: number }): number => {
    if (info < 24) return info;
    if (info === 24) return input[take({ count: 1 })]!;
    if (info === 25) return view.getUint16(take({ count: 2 }), false);
    if (info === 26) return view.getUint32(take({ count: 4 }), false);
    if (info === 27) {
      const value = view.getBigUint64(take({ count: 8 }), false);
      check({ condition: value <= BigInt(Number.MAX_SAFE_INTEGER), code: 'PROTOCOL_ERROR' }); return Number(value);
    }
    throw new Error('Indefinite or reserved CBOR encoding');
  };
  const visit = ({ depth }: { depth: number }): WireValue => {
    check({ condition: ++nodes <= 8192 && depth <= 32, code: 'RESOURCE_EXHAUSTED' });
    const initial = input[take({ count: 1 })]!, major = initial >>> 5, info = initial & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 23) return undefined;
      if (info === 27) {
        const value = view.getFloat64(take({ count: 8 }), false); check({ condition: Number.isFinite(value), code: 'PROTOCOL_ERROR' }); return value;
      }
      throw new Error('Unsupported simple CBOR value');
    }
    const size = argument({ info });
    switch (major) {
    case 0: return size;
    case 1: { const value = -1 - size; check({ condition: Number.isSafeInteger(value), code: 'PROTOCOL_ERROR' }); return value; }
    case 2: return input.slice(take({ count: size }), at);
    case 3: { const begin = take({ count: size }); return decoder.decode(input.subarray(begin, at)); }
    case 4: {
      check({ condition: size <= 4096 && size <= input.length - at, code: 'PROTOCOL_ERROR' });
      return Array.from({ length: size }, () => visit({ depth: depth + 1 }));
    }
    case 5: {
      check({ condition: size <= 4096 && size * 2 <= input.length - at, code: 'PROTOCOL_ERROR' });
      const object: { [key: string]: WireValue } = {};
      for (let i = 0; i < size; i++) {
        const key = visit({ depth: depth + 1 });
        check({ condition: typeof key === 'string', code: 'PROTOCOL_ERROR' });
        if (typeof key !== 'string') throw new Error('Non-string object key');
        check({ condition: validKey({ key }) && !Object.hasOwn(object, key), code: 'PROTOCOL_ERROR' });
        object[key] = visit({ depth: depth + 1 });
      }
      return object;
    }
    case 6: {
      check({ condition: size === 0x4e52504301 || size === 0x4e52504302, code: 'PROTOCOL_ERROR' });
      const payload = visit({ depth: depth + 1 });
      const id = size === 0x4e52504302 ? payload : Array.isArray(payload) ? payload[0] : undefined;
      check({ condition: typeof id === 'number' && Number.isInteger(id) && id > 0 && id <= 65535, code: 'PROTOCOL_ERROR' });
      if (typeof id !== 'number') throw new Error('Invalid reference');
      if (size === 0x4e52504302) return new Reference({ id, mode: 'callback' });
      check({ condition: Array.isArray(payload) && payload.length === 2 && (payload[1] === 0 || payload[1] === 1), code: 'PROTOCOL_ERROR' });
      return new Reference({ id, mode: Array.isArray(payload) && payload[1] === 0 ? 'bytes' : 'items' });
    }
    default: throw new Error('Invalid CBOR major');
    }
  };
  const value = visit({ depth: 0 }); check({ condition: at === input.length, code: 'PROTOCOL_ERROR' }); return value;
}

function streamMode({ mode }: { mode: 'bytes' | 'items' }): number {
  switch (mode) {
  case 'bytes': return 0;
  case 'items': return 1;
  default: { const unreachable: never = mode; throw new Error(String(unreachable)); }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
