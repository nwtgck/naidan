// @vitest-environment node
import { expect, it } from 'vitest';
import { nativePointer } from './native-pointer';

it('preserves unsigned wasm32 addresses while passing numbers to direct C exports', () => {
  expect(nativePointer({ pointer: 0xffffffffn, pointerBytes: 4 })).toBe(0xffffffff);
  expect(nativePointer({ pointer: 0n, pointerBytes: 4 })).toBe(0);
});

it('preserves full-width wasm64 addresses', () => {
  expect(nativePointer({ pointer: 0xffffffffffffffffn, pointerBytes: 8 })).toBe(0xffffffffffffffffn);
  expect(nativePointer({ pointer: 123, pointerBytes: 8 })).toBe(123n);
});

it.each([-1n, 0x100000000n, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects an inexact or overflowing wasm32 address: %s', pointer => {
  expect(() => nativePointer({ pointer, pointerBytes: 4 })).toThrow();
});

it.each([0, 2, 16])('rejects an unsupported native pointer width: %s', pointerBytes => {
  expect(() => nativePointer({ pointer: 0n, pointerBytes })).toThrow('pointer width');
});
