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
      fieldLayout: ({ field }: { field: string }) => ({ kind: field === 'ne' ? 'array' : 'signed', offset: field === 'op' ? 0n : field === 'type' ? 4n : 8n, size: field === 'ne' ? 32 : 4 }),
      enumValues: () => [{ name: 'GGML_OP_ADD', value: 2 }, { name: 'GGML_OP_POOL_COUNT', value: 2 }],
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
