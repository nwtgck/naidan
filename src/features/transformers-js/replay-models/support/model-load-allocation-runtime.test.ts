// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { trapLargeModelAllocation } from './model-load-allocation-runtime';

describe('allocation control safety fence', () => {
  it.each(['Uint8Array', 'ArrayBuffer', 'WebAssembly.Memory'] as const)('refuses an unexpected large %s constructor before native allocation', allocator => {
    const failure = new RangeError('Safety fence sentinel');
    // A broken fence must fail safely here, without allocating model-sized memory.
    const requestedBytes = 1024 * 1024 + 1;
    const trap = trapLargeModelAllocation({ failure });
    try {
      const construct = () => {
        switch (allocator) {
        case 'Uint8Array': return new Uint8Array(requestedBytes);
        case 'ArrayBuffer': return new ArrayBuffer(requestedBytes);
        case 'WebAssembly.Memory': return new WebAssembly.Memory({ initial: Math.ceil(requestedBytes / 65536) });
        default: { const _ex: never = allocator; throw new Error(`Unhandled allocator ${_ex}`); }
        }
      };
      expect(construct).toThrow(failure);
      expect(trap.requests).toEqual([{ bytes: allocator === 'WebAssembly.Memory' ? Math.ceil(requestedBytes / 65536) * 65536 : requestedBytes, boundary: 'unexpected' }]);
      expect(new Uint8Array([1, 2, 3])).toEqual(new Uint8Array([1, 2, 3]));
      expect(new ArrayBuffer(4).byteLength).toBe(4);
    } finally {
      trap.restore();
    }
  });
});
