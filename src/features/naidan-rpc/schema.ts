import type { RpcByteOwner } from './byte-budget';
import { z } from 'zod';
import { check, VALUE_BYTES, validKey } from '@/features/naidan-rpc/primitives';
import { encode, decode, Reference } from '@/features/naidan-rpc/codec';
import type { WireValue, ReferenceMode } from '@/features/naidan-rpc/codec';

export type Finite = undefined | boolean | string | number | Uint8Array | readonly Finite[] | { readonly [key: string]: Finite };
declare const callbackType: unique symbol;
export type CallbackToken<I extends z.ZodType, R extends z.ZodType> = { readonly [callbackType]: { input: I; result: R } };
export type Local<T, Side extends 'send' | 'receive'> =
  T extends CallbackToken<infer I, infer R> ? Side extends 'send'
    // eslint-disable-next-line local-rules-named-args/require-named-args -- This function type preserves one schema-defined callback value, including scalar arguments, across the remote function boundary.
    ? (input: Local<z.output<I>, 'receive'>) => Local<z.output<R>, 'send'> | Promise<Local<z.output<R>, 'send'>>
    // eslint-disable-next-line local-rules-named-args/require-named-args -- The received callable preserves the same schema-defined argument while making its result asynchronous.
    : (input: Local<z.output<I>, 'send'>) => Promise<Local<z.output<R>, 'receive'>> :
  T extends ReadableStream<infer V> ? ReadableStream<V> : T extends Uint8Array ? Uint8Array :
  T extends readonly (infer V)[] ? Local<V, Side>[] : T extends object ? { [K in keyof Required<T>]: Local<T[K], Side> } : T;
export type SendValue<S extends z.ZodType> = Local<z.output<S>, 'send'>;
export type ReceiveValue<S extends z.ZodType> = Local<z.output<S>, 'receive'>;
export type Capability = { kind: 'stream'; mode: 'bytes' | 'items'; item: z.ZodType } |
  { kind: 'callback'; input: z.ZodType; result: z.ZodType };
const capabilities = new WeakMap<z.ZodType, Capability>();

function stream<S extends z.ZodType<Finite>>({ item }: { item: S }) {
  const schema = z.custom<ReadableStream<z.output<S>>>(value => value instanceof ReadableStream);
  capabilities.set(schema, { kind: 'stream', mode: 'items', item }); return schema;
}

function byteStream() {
  const schema = z.custom<ReadableStream<Uint8Array>>(value => value instanceof ReadableStream);
  capabilities.set(schema, { kind: 'stream', mode: 'bytes', item: z.instanceof(Uint8Array) }); return schema;
}

function callback<I extends z.ZodType<Finite>, R extends z.ZodType<Finite>>({ input, result }: { input: I; result: R }) {
  const schema = z.custom<CallbackToken<I, R>>(value => typeof value === 'function');
  capabilities.set(schema, { kind: 'callback', input, result }); return schema;
}

export const rpc = Object.freeze({ stream, byteStream, callback });
export type Plan = { schema: z.ZodType; node: { kind: 'object'; fields: ReadonlyMap<string, Plan> } |
  { kind: 'array'; item: Plan } | { kind: 'optional'; inner: Plan } |
  { kind: 'capability'; capability: Capability } | { kind: 'finite' } };

/** Only public Zod accessors are used. Opaque capabilities after unsupported wrappers fail closed. */
export function compile({ schema, capabilitiesAllowed, callbacksAllowed }: {
  schema: z.ZodType; capabilitiesAllowed: boolean; callbacksAllowed: boolean;
}): Plan {
  const seen = new Set<z.ZodType>(); let nodes = 0;
  const visit = ({ schema, depth }: { schema: z.ZodType; depth: number }): Plan => {
    check({ condition: ++nodes <= 1024 && depth <= 24 && !seen.has(schema), code: 'INVALID_ARGUMENT' });
    const capability = capabilities.get(schema);
    if (capability) {
      check({ condition: capabilitiesAllowed, code: 'INVALID_ARGUMENT' });
      switch (capability.kind) {
      case 'callback':
        check({ condition: callbacksAllowed, code: 'INVALID_ARGUMENT' });
        compile({ schema: capability.input, capabilitiesAllowed: false, callbacksAllowed: false });
        compile({ schema: capability.result, capabilitiesAllowed: false, callbacksAllowed: false });
        break;
      case 'stream': compile({ schema: capability.item, capabilitiesAllowed: false, callbacksAllowed: false }); break;
      default: { const unreachable: never = capability; throw new Error(String(unreachable)); }
      }
      return { schema, node: { kind: 'capability', capability } };
    }
    seen.add(schema);
    try {
      if (schema instanceof z.ZodOptional) return { schema, node: { kind: 'optional', inner: visit({ schema: schema.unwrap() as z.ZodType, depth: depth + 1 }) } };
      if (schema instanceof z.ZodObject) {
        const fields = new Map<string, Plan>();
        for (const [key, child] of Object.entries(schema.shape)) {
          check({ condition: validKey({ key }), code: 'INVALID_ARGUMENT' });
          fields.set(key, visit({ schema: child as z.ZodType, depth: depth + 1 }));
        }
        return { schema, node: { kind: 'object', fields } };
      }
      if (schema instanceof z.ZodArray) return { schema, node: { kind: 'array', item: visit({ schema: schema.element as z.ZodType, depth: depth + 1 }) } };
      if (schema instanceof z.ZodUnion) {
        for (const option of schema.options) compile({ schema: option as z.ZodType, capabilitiesAllowed: false, callbacksAllowed: false });
        return { schema, node: { kind: 'finite' } };
      }
      // Zod's instanceof(Uint8Array) is intentionally custom. Its result is still checked by the finite codec.
      check({
        condition: schema instanceof z.ZodString || schema instanceof z.ZodNumber || schema instanceof z.ZodBoolean ||
        schema instanceof z.ZodUndefined || schema instanceof z.ZodVoid || schema instanceof z.ZodLiteral ||
        schema instanceof z.ZodEnum || schema instanceof z.ZodCustom,
        code: 'INVALID_ARGUMENT',
      });
      return { schema, node: { kind: 'finite' } };
    } finally {
      seen.delete(schema);
    }
  };
  return visit({ schema, depth: 0 });
}

export type Source = { capability: Capability; value: unknown };
export type Packed = { value: WireValue; sources: ReadonlyMap<number, Source> };
export type Projection = { value: unknown; accepted: ReadonlySet<number> };

export function references({ value }: { value: WireValue }): Map<number, Reference> {
  const refs = new Map<number, Reference>();
  const visit = ({ value }: { value: WireValue }): void => {
    if (value instanceof Reference) {
      check({ condition: !refs.has(value.id) && refs.size < 16, code: 'PROTOCOL_ERROR' }); refs.set(value.id, value); return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit({ value: item });
    } else if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
      for (const item of Object.values(value)) visit({ value: item });
    }
  };
  visit({ value }); return refs;
}

function properties({ value }: { value: unknown }): Record<string, unknown> {
  check({ condition: value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null), code: 'INVALID_ARGUMENT' });
  if (value === null || typeof value !== 'object') throw new Error('Object expected');
  check({ condition: Object.getOwnPropertySymbols(value).length === 0, code: 'INVALID_ARGUMENT' });
  const output: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    check({ condition: validKey({ key }) && descriptor.enumerable && 'value' in descriptor, code: 'INVALID_ARGUMENT' });
    output[key] = descriptor.value;
  }
  return output;
}

/**
 * On failed result packing, ownership of locally returned streams still needs
 * retirement. Follow only declared capability paths, without invoking getters
 * or allocating copies of finite values. This is not a second value validator.
 */
export function returnedStreams({ plan, value }: { plan: Plan; value: unknown }): ReadonlySet<ReadableStream<unknown>> {
  const streams = new Set<ReadableStream<unknown>>(); let nodes = 0;
  const visit = ({ plan, value, depth }: { plan: Plan; value: unknown; depth: number }): void => {
    check({ condition: ++nodes <= 4096 && depth <= 24, code: 'RESOURCE_EXHAUSTED' });
    switch (plan.node.kind) {
    case 'finite': return;
    case 'capability':
      if (plan.node.capability.kind === 'stream' && value instanceof ReadableStream) streams.add(value);
      return;
    case 'optional':
      if (value !== undefined) visit({ plan: plan.node.inner, value, depth: depth + 1 });
      return;
    case 'object': {
      const input = properties({ value });
      for (const [key, child] of plan.node.fields) visit({ plan: child, value: input[key], depth: depth + 1 });
      return;
    }
    case 'array':
      check({ condition: Array.isArray(value) && value.length <= 4096, code: 'INVALID_ARGUMENT' });
      if (!Array.isArray(value)) return;
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        check({ condition: descriptor !== undefined && 'value' in descriptor, code: 'INVALID_ARGUMENT' });
        visit({ plan: plan.node.item, value: descriptor?.value, depth: depth + 1 });
      }
      return;
    default: { const exhaustive: never = plan.node; throw new Error(String(exhaustive)); }
    }
  };
  visit({ plan, value, depth: 0 }); return streams;
}

function finite({ schema, value, memory }: { schema: z.ZodType; value: unknown; memory?: RpcByteOwner }): WireValue {
  // Application refinements run on a closed finite value, not on accessors.
  const temporary = memory?.fork();
  try {
    const encodedInput = encode({ value, limit: VALUE_BYTES, memory: temporary });
    let input: WireValue;
    try {
      input = decode({ bytes: encodedInput, memory: temporary });
    } finally {
      temporary?.release({ bytes: encodedInput });
    }
    check({ condition: references({ value: input }).size === 0, code: 'INVALID_ARGUMENT' });
    const result: unknown = schema.parse(input);
    const output = decode({ bytes: encode({ value: result, limit: VALUE_BYTES, memory: temporary }), memory });
    check({ condition: references({ value: output }).size === 0, code: 'INVALID_ARGUMENT' }); return output;
  } finally {
    temporary?.clear();
  }
}

/** Prepare the whole value before taking source locks or running callbacks. */
export function pack({ plan, value, allocate, memory }: { plan: Plan; value: unknown; allocate: () => number; memory?: RpcByteOwner }): Packed {
  const sources = new Map<number, Source>(), seen = new Set<object>(); let nodes = 0;
  const visit = ({ plan, value, depth }: { plan: Plan; value: unknown; depth: number }): WireValue => {
    check({ condition: ++nodes <= 4096 && depth <= 24, code: 'RESOURCE_EXHAUSTED' });
    const { schema, node } = plan;
    switch (node.kind) {
    case 'optional': return value === undefined ? undefined : visit({ plan: node.inner, value, depth: depth + 1 });
    case 'finite': return finite({ schema, value, memory });
    case 'capability': {
      check({ condition: sources.size < 16 && ((typeof value === 'object' && value !== null) || typeof value === 'function'), code: 'INVALID_ARGUMENT' });
      if ((typeof value !== 'object' || value === null) && typeof value !== 'function') throw new Error('Capability expected');
      check({ condition: !seen.has(value), code: 'INVALID_ARGUMENT' }); seen.add(value);
      const id = allocate(), capability = node.capability;
      let mode: ReferenceMode;
      switch (capability.kind) {
      case 'stream': check({ condition: value instanceof ReadableStream && !value.locked, code: 'INVALID_ARGUMENT' }); mode = capability.mode; break;
      case 'callback': check({ condition: typeof value === 'function', code: 'INVALID_ARGUMENT' }); mode = 'callback'; break;
      default: { const unreachable: never = capability; throw new Error(String(unreachable)); }
      }
      schema.parse(value); sources.set(id, { capability, value }); return new Reference({ id, mode });
    }
    case 'object': {
      const input = properties({ value }), converted: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input)) if (!node.fields.has(key)) converted[key] = finite({ schema: z.unknown(), value: item, memory });
      for (const [key, child] of node.fields) converted[key] = visit({ plan: child, value: input[key], depth: depth + 1 });
      // Run parent object refinements on validated runtime capabilities, never their wire tags.
      const local: Record<string, unknown> = { ...input };
      for (const key of node.fields.keys()) if (!Object.hasOwn(local, key)) local[key] = undefined;
      schema.parse(local);
      const output: Record<string, WireValue> = {};
      for (const key of node.fields.keys()) output[key] = converted[key] as WireValue;
      return output;
    }
    case 'array': {
      check({ condition: Array.isArray(value) && value.length <= 1024 && Object.keys(value).length === value.length, code: 'INVALID_ARGUMENT' });
      if (!Array.isArray(value)) throw new Error('Array expected');
      const array: WireValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        check({ condition: descriptor && 'value' in descriptor, code: 'INVALID_ARGUMENT' });
        array.push(visit({ plan: node.item, value: descriptor?.value, depth: depth + 1 }));
      }
      schema.parse(value); return array;
    }
    default: { const unreachable: never = node; throw new Error(String(unreachable)); }
    }
  };
  const packed = visit({ plan, value, depth: 0 }); const bytes = encode({ value: packed, limit: VALUE_BYTES, memory }); memory?.release({ bytes }); return { value: packed, sources };
}

/** Project known fields only; the caller declines all valid but unused references after full validation. */
export function project({ plan, value, proxy, memory }: {
  memory?: RpcByteOwner;
  plan: Plan; value: WireValue; proxy: ({ reference, capability }: { reference: Reference; capability: Capability }) => unknown;
}): Projection {
  const accepted = new Set<number>();
  const visit = ({ plan, value }: { plan: Plan; value: WireValue }): unknown => {
    const { schema, node } = plan;
    switch (node.kind) {
    case 'optional': return value === undefined ? undefined : visit({ plan: node.inner, value });
    case 'finite': return finite({ schema, value, memory });
    case 'capability': {
      check({ condition: value instanceof Reference, code: 'INVALID_ARGUMENT' });
      if (!(value instanceof Reference)) throw new Error('Reference expected');
      const expected = capabilityMode({ capability: node.capability });
      check({ condition: value.mode === expected && !accepted.has(value.id), code: 'PROTOCOL_ERROR' });
      accepted.add(value.id); const result = proxy({ reference: value, capability: node.capability });
      schema.parse(result); return result;
    }
    case 'object': {
      const input = properties({ value }), output = { ...input };
      for (const [key, child] of node.fields) output[key] = visit({ plan: child, value: input[key] as WireValue });
      const parsed: unknown = schema.parse(output);
      const source = properties({ value: parsed }), normalized: Record<string, unknown> = {};
      // Unknown output, including capabilities under loose/catchall fields, is not exposed.
      for (const key of node.fields.keys()) normalized[key] = source[key];
      return normalized;
    }
    case 'array': {
      check({ condition: Array.isArray(value) && value.length <= 1024, code: 'INVALID_ARGUMENT' });
      if (!Array.isArray(value)) throw new Error('Array expected');
      const projected = value.map(item => visit({ plan: node.item, value: item }));
      return schema.parse(projected);
    }
    default: { const unreachable: never = node; throw new Error(String(unreachable)); }
    }
  };
  return { value: visit({ plan, value }), accepted };
}

export function capabilityMode({ capability }: { capability: Capability }): ReferenceMode {
  switch (capability.kind) {
  case 'stream': return capability.mode;
  case 'callback': return 'callback';
  default: { const unreachable: never = capability; throw new Error(String(unreachable)); }
  }
}

export function isStream(capability: Capability): capability is Extract<Capability, { kind: 'stream' }> {
  switch (capability.kind) {
  case 'stream': return true;
  case 'callback': return false;
  default: { const unreachable: never = capability; throw new Error(String(unreachable)); }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
