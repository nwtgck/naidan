// @vitest-environment node
import { expect, it } from 'vitest';
import { z } from 'zod';
import { rpc, compile, pack, project } from '@/features/naidan-rpc/schema';
import { Reference } from '@/features/naidan-rpc/codec';
import { contract, procedure, expose } from '@/features/naidan-rpc/contract';

it('ordinary Zod optional fields materialize as explicit undefined and unknown fields are removed', () => {
  const plan = compile({ schema: z.object({ known: z.number(), missing: z.string().optional() }), capabilitiesAllowed: true, callbacksAllowed: true });
  const result = project({ plan, value: { known: 2, newer: true }, proxy: () => {
    throw new Error('No refs');
  } });
  expect(result.value).toEqual({ known: 2, missing: undefined });
  expect(Object.hasOwn(result.value as object, 'missing')).toBe(true);
  expect(() => project({ plan, value: { known: '2' }, proxy: () => {} })).toThrow();
});

it('stream-only wrappers retain known metadata, while opaque transforms and resource unions are not accepted', () => {
  const stream = rpc.stream({ item: z.number() });
  expect(() => compile({ schema: z.object({ stream: stream.optional() }), capabilitiesAllowed: true, callbacksAllowed: true })).not.toThrow();
  expect(() => compile({ schema: z.object({ x: z.string().transform(value => value.length) }), capabilitiesAllowed: true, callbacksAllowed: true })).toThrow();
  expect(() => compile({ schema: z.union([stream, z.string()]), capabilitiesAllowed: true, callbacksAllowed: true })).toThrow();
  expect(() => compile({ schema: z.object({ fn: rpc.callback({ input: z.object({}), result: z.number() }) }), capabilitiesAllowed: true, callbacksAllowed: false })).toThrow();
});

it('a cloned stream custom schema is not silently serialized as a finite value', () => {
  const schema = rpc.stream({ item: z.number() }).clone();
  const plan = compile({ schema, capabilitiesAllowed: true, callbacksAllowed: true });
  expect(() => pack({ plan, value: new ReadableStream(), allocate: () => 1 })).toThrow();
});

it('unknown capability fields are not exposed through a loose object schema', () => {
  const plan = compile({ schema: z.looseObject({ value: z.number() }), capabilitiesAllowed: true, callbacksAllowed: true });
  const projection = project({ plan, value: { value: 5, extra: new Reference({ id: 1, mode: 'items' }) }, proxy: () => {
    throw new Error('Unknown proxy');
  } });
  expect(projection.value).toEqual({ value: 5 }); expect(projection.accepted.size).toBe(0);
});

it('source validation rejects duplicate or locked streams without reading any producer', () => {
  const plan = compile({ schema: z.object({ a: rpc.bytes(), b: rpc.bytes() }), capabilitiesAllowed: true, callbacksAllowed: true });
  let reads = 0;
  const source = new ReadableStream({ pull() {
    reads++;
  } }, { highWaterMark: 0 }); let id = 1;
  expect(() => pack({ plan, value: { a: source, b: source }, allocate: () => id++ })).toThrow();
  const reader = source.getReader();
  expect(() => pack({ plan, value: { a: source, b: new ReadableStream() }, allocate: () => id++ })).toThrow();
  expect(reads).toBe(0); reader.releaseLock();
});

it('contract names cannot turn a client into a thenable or expose prototype properties', () => {
  const method = procedure({ input: z.object({}), result: z.number(), notifications: {} });
  for (const name of ['then', 'constructor', 'prototype', '__proto__', 'x/y'])
    expect(() => contract({ name: 'valid', methods: { [name]: method } })).toThrow();
  expect(() => expose({ contract: contract({ name: 'valid', methods: { run: method } }), allowedMethods: [], implementation: {} as never })).toThrow();
});
