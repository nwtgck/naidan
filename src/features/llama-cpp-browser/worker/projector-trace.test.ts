import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { subscribeDiagnostics } from '@/features/llama-cpp-browser/debug-log';
import { readDiagnostics } from '@/features/llama-cpp-browser/test-utils/diagnostics';
import { createProjectorTrace } from './projector-trace';

afterEach(() => vi.restoreAllMocks());
describe('synchronous projector tensor tracing', () => {
  it.each([4, 8] as const)('reads only metadata with %i-byte pointers and does not confuse pooling modes with op names', pointerBytes => {
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    const memory = new Uint8Array(64); const view = new DataView(memory.buffer);
    view.setInt32(0, 2, true); view.setInt32(4, 1, true);
    [768n, 240n, 3n, 1n].forEach((value, index) => view.setBigInt64(8 + index * 8, value, true));
    const tensorPointer = pointerBytes === 4 ? 0x80000000n : 0x100000000n;
    let callback: (tensor: number | bigint, ask: number, userData: number | bigint) => number = () => 0;
    const core = {
      pointerBytes,
      fieldLayout: ({ field }: { field: string }) => ({ kind: field === 'ne' || field === 'src' ? 'array' : 'signed', offset: field === 'op' ? 0n : field === 'type' ? 4n : field === 'ne' ? 8n : 40n, size: field === 'ne' ? 32 : field === 'src' ? pointerBytes * 2 : 4 }),
      enumValues: ({ prefix }: { prefix: string }) => prefix === 'GGML_OP_' ? [{ name: 'GGML_OP_ADD', value: 2 }, { name: 'GGML_OP_POOL_COUNT', value: 2 }] : [{ name: 'GGML_TYPE_F16', value: 1 }],
      bytes: ({ pointer, length }: { pointer: bigint, length: number }) => memory.subarray(Number(pointer - tensorPointer), Number(pointer - tensorPointer) + length),
      module: { addFunction: (fn: typeof callback) => {
        callback = fn; return 9;
      }, removeFunction: vi.fn() },
    } as unknown as Core;
    const unsubscribe = subscribeDiagnostics({ debug: 'on', listener: () => {} }); const trace = createProjectorTrace({ core });
    try {
      const pointer = pointerBytes === 4 ? -2147483648 : tensorPointer;
      expect(callback(pointer, 1, 0)).toBe(1); expect(callback(pointer, 0, 0)).toBe(1);
      const diagnostics = readDiagnostics({ calls: debug.mock.calls });
      expect(diagnostics).toHaveLength(2);
      expect(diagnostics[0]).toEqual(expect.objectContaining({ event: 'native-node-start', nativeOpName: 'GGML_OP_ADD', nativeTensorType: 1, nativeTensorShape: [768, 240, 3, 1] }));
      expect(diagnostics[1]).toEqual(expect.objectContaining({ event: 'native-node-complete', nativeNode: 1 }));
      view.setBigInt64(8, 9007199254740992n, true);
      expect(() => callback(pointer, 1, 0)).not.toThrow(); expect(callback(pointer, 0, 0)).toBe(1);
      expect(readDiagnostics({ calls: debug.mock.calls }).filter(entry => entry.stage === 'projector-trace')).toHaveLength(1);
    } finally {
      trace.release(); unsubscribe();
    }
  });
});


describe('projector input tensor metadata', () => {
  it.each([4, 8] as const)('distinguishes BF16 inputs from F32 outputs with %i-byte pointers', pointerBytes => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const base = pointerBytes === 4 ? 0x80000000n : 0x100000000n;
    const memory = new Uint8Array(384);
    const view = new DataView(memory.buffer);
    for (const offset of [0, 128, 256]) {
      view.setInt32(offset, 29, true);
      view.setInt32(offset + 4, offset === 128 ? 30 : 0, true);
      [1152n, 476n, 1n, 1n].forEach((dimension, index) => view.setBigInt64(offset + 8 + index * 8, dimension, true));
    }
    for (const index of [0, 1]) {
      const value = base + BigInt(128 * (index + 1));
      if (pointerBytes === 8) view.setBigUint64(40 + index * 8, value, true);
      else view.setUint32(40 + index * 4, Number(value), true);
    }
    let callback: (tensor: number | bigint, ask: number, userData: number | bigint) => number = () => 0;
    const reads: { pointer: bigint, length: number }[] = [];
    const removeFunction = vi.fn();
    const core = {
      pointerBytes,
      fieldLayout: ({ field }: { field: string }) => ({ kind: field === 'ne' || field === 'src' ? 'array' : 'signed',
        offset: field === 'op' ? 0n : field === 'type' ? 4n : field === 'ne' ? 8n : 40n,
        size: field === 'ne' ? 32 : field === 'src' ? pointerBytes * 10 : 4 }),
      enumValues: ({ prefix }: { prefix: string }) => prefix === 'GGML_OP_'
        ? [{ name: 'GGML_OP_MUL_MAT', value: 29 }]
        : [{ name: 'GGML_TYPE_F32', value: 0 }, { name: 'GGML_TYPE_BF16', value: 30 }],
      bytes: ({ pointer, length }: { pointer: bigint, length: number }) => {
        reads.push({ pointer, length });
        const offset = Number(pointer - base);
        if (offset < 0 || offset + length > memory.length) throw new RangeError('Invalid metadata pointer');
        return memory.subarray(offset, offset + length);
      },
      module: { addFunction: (fn: typeof callback) => {
        callback = fn; return 11;
      }, removeFunction },
    } as unknown as Core;
    const unsubscribe = subscribeDiagnostics({ debug: 'on', listener: () => {} });
    const trace = createProjectorTrace({ core });
    const pointer = pointerBytes === 4 ? -2147483648 : base;
    try {
      expect(callback(pointer, 1, 0)).toBe(1);
      expect(callback(pointer, 0, 0)).toBe(1);
      const diagnostics = readDiagnostics({ calls: debug.mock.calls });
      expect(diagnostics[0]).toMatchObject({
        nativeTensorType: 0, nativeTensorTypeName: 'GGML_TYPE_F32',
        nativeTensorInputs: [
          { index: 0, type: 30, typeName: 'GGML_TYPE_BF16', shape: [1152, 476, 1, 1] },
          { index: 1, type: 0, typeName: 'GGML_TYPE_F32', shape: [1152, 476, 1, 1] },
        ],
      });
      expect(diagnostics[1]).toMatchObject({ event: 'native-node-complete', nativeNode: 1 });
      expect(reads.every(({ pointer: address, length }) => {
        const offset = Number(address - base);
        return (offset === 40 && length === pointerBytes * 2)
          || (offset % 128 === 0 && length === 4)
          || (offset % 128 === 4 && length === 4)
          || (offset % 128 === 8 && length === 32);
      })).toBe(true);
      expect(JSON.stringify(diagnostics)).not.toContain(String(base));

      // A missing input is not an invalid pointer, and later inputs keep their index.
      if (pointerBytes === 8) view.setBigUint64(40, 0n, true);
      else view.setUint32(40, 0, true);
      expect(callback(pointer, 1, 0)).toBe(1);
      expect(readDiagnostics({ calls: debug.mock.calls }).at(-1)?.nativeTensorInputs).toHaveLength(1);
      expect(readDiagnostics({ calls: debug.mock.calls }).at(-1)).toMatchObject({ nativeTensorInputs: [{ index: 1 }] });

      // Diagnostic failures must not escape into the native callback or abort inference.
      view.setBigInt64(256 + 8, -1n, true);
      expect(callback(pointer, 1, 0)).toBe(1);
      expect(callback(pointer, 0, 0)).toBe(1);
      expect(readDiagnostics({ calls: debug.mock.calls }).filter(entry => entry.stage === 'projector-trace')).toHaveLength(1);
    } finally {
      trace.release(); trace.release(); unsubscribe();
    }
    expect(removeFunction).toHaveBeenCalledExactlyOnceWith(11);
  });
});
