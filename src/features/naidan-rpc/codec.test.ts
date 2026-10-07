// @vitest-environment node
import { expect, it } from 'vitest';
import { decode, encode, Reference } from '@/features/naidan-rpc/codec';
import type { WireValue } from '@/features/naidan-rpc/codec';

const hex = ({ value }: { value: string }) => new Uint8Array(Buffer.from(value, 'hex'));
const vectors: { bytes: string; value: WireValue }[] = [
  { bytes: '00', value: 0 }, { bytes: '17', value: 23 }, { bytes: '1818', value: 24 }, { bytes: '1903e8', value: 1000 },
  { bytes: '1a000f4240', value: 1000000 }, { bytes: '1b000000e8d4a51000', value: 1000000000000 },
  { bytes: '20', value: -1 }, { bytes: '3863', value: -100 }, { bytes: 'f4', value: false }, { bytes: 'f5', value: true },
  { bytes: 'f7', value: undefined }, { bytes: '40', value: new Uint8Array() }, { bytes: '4401020304', value: new Uint8Array([1, 2, 3, 4]) },
  { bytes: '60', value: '' }, { bytes: '6449455446', value: 'IETF' }, { bytes: '62c3bc', value: 'ü' },
  { bytes: '63e6b0b4', value: '水' }, { bytes: '64f0908591', value: '𐅑' },
  { bytes: '83010203', value: [1, 2, 3] }, { bytes: 'a26161016162820203', value: { a: 1, b: [2, 3] } },
  { bytes: 'fb3ff199999999999a', value: 1.1 }, { bytes: 'fb8000000000000000', value: -0 },
];
for (const vector of vectors) it(`restricted CBOR matches published-style vector ${vector.bytes}`, () => {
  expect(encode({ value: vector.value, limit: 65536 })).toEqual(hex({ value: vector.bytes }));
  expect(decode({ bytes: hex({ value: vector.bytes }) })).toEqual(vector.value);
});

it('reference tags do not collide with ordinary objects or arrays', () => {
  const ordinary = { $stream: 1, kind: 'callback', id: 3, mode: 'bytes' };
  expect(decode({ bytes: encode({ value: ordinary, limit: 65536 }) })).toEqual(ordinary);
  for (const mode of ['bytes', 'items', 'callback'] as const) {
    const original = new Reference({ id: 123, mode });
    const value = decode({ bytes: encode({ value: original, limit: 65536 }) });
    expect(value).toBeInstanceOf(Reference); expect(value).toEqual(original);
  }
});

it('non-finite values, accessors, prototypes, sparse arrays, aliases and unsupported values fail closed', () => {
  let calls = 0;
  const getter = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      calls++; return 2;
    },
  });
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const shared = new Uint8Array(new SharedArrayBuffer(3));
  const detached = new Uint8Array([3]); structuredClone(detached.buffer, { transfer: [detached.buffer] });
  for (const value of [NaN, Infinity, -Infinity, 1n, () => 2, new Date(), new Map(), new Set(), getter, cyclic, shared, detached, new Array(3)])
    expect(() => encode({ value, limit: 65536 })).toThrow();
  const dangerous = Object.create(null) as Record<string, unknown>; dangerous.__proto__ = 3;
  expect(() => encode({ value: dangerous, limit: 65536 })).toThrow();
  expect(calls).toBe(0);
});

it('invalid UTF-8 and unpaired surrogates are rejected instead of being replaced', () => {
  for (const bytes of ['62c080', '63eda080', '64f4908080', '6180', '61ff']) expect(() => decode({ bytes: hex({ value: bytes }) })).toThrow();
  for (const text of ['\ud800', '\udfff', 'x\ud800a']) expect(() => encode({ value: text, limit: 65536 })).toThrow();
  expect(decode({ bytes: hex({ value: '63efbbbf' }) })).toBe('\ufeff');
});

it('all truncated prefixes, trailing bytes, duplicate keys and unsupported tags are rejected', () => {
  const value = { alpha: 2, bytes: new Uint8Array(512).fill(9), stream: new Reference({ id: 7, mode: 'items' }) };
  const bytes = encode({ value, limit: 65536 });
  for (let length = 0; length < bytes.length; length++) expect(() => decode({ bytes: bytes.subarray(0, length) })).toThrow();
  const trailing = new Uint8Array(bytes.length + 1); trailing.set(bytes); expect(() => decode({ bytes: trailing })).toThrow();
  for (const wire of ['a2616101616102', 'bf616101ff', '9f01ff', '5f4101ff', 'c001', 'd9ea60820100', 'f6', 'f93c00', 'fb7ff0000000000000', '1bffffffffffffffff'])
    expect(() => decode({ bytes: hex({ value: wire }) })).toThrow();
});

it('lengths and recursion are bounded before allocating a declared container', () => {
  for (const wire of ['9affffffff', '5affffffff', '7affffffff', 'baffffffff']) expect(() => decode({ bytes: hex({ value: wire }) })).toThrow();
  let value: unknown = undefined;
  for (let depth = 0; depth < 40; depth++) value = [value];
  expect(() => encode({ value, limit: 65536 })).toThrow();
  expect(() => encode({ value: new Uint8Array(65536), limit: 65536 })).toThrow();
  const input = new Uint8Array([1, 2]), encoded = encode({ value: input, limit: 1024 }); input[0] = 9;
  const decoded = decode({ bytes: encoded }) as Uint8Array; decoded[1] = 8;
  expect(decode({ bytes: encoded })).toEqual(new Uint8Array([1, 2]));
});

it('reports the violated byte or string bound without including payload content', () => {
  expect(() => encode({ value: { data: 'x'.repeat(21848) }, limit: 16384 })).toThrow(expect.objectContaining({
    code: 'RESOURCE_EXHAUSTED',
    details: { scope: 'rpc-codec', constraint: 'string-code-units', limit: 16384, observed: 21848 },
  }));
  expect(() => encode({ value: new Uint8Array(16384), limit: 16384 })).toThrow(expect.objectContaining({
    code: 'RESOURCE_EXHAUSTED',
    details: { scope: 'rpc-codec', constraint: 'encoded-bytes', limit: 16384, observed: 16387 },
  }));
});
