import { describe, expect, it, vi } from 'vitest';
import { createPrefillOutputs } from './prefill-outputs';

function fixture({ mode }: { mode: 'final-only' | 'per-batch' }) {
  const allocations = new Map<bigint, Uint8Array>();
  let pointer = 0n;
  const fields = new Map<bigint, bigint>();
  const core = {
    tryAlloc: vi.fn(({ bytes }: { bytes: number | bigint }): bigint | undefined => {
      const next = pointer += 1024n;
      allocations.set(next, new Uint8Array(Number(bytes)).fill(99)); return next;
    }),
    bytes: vi.fn(({ pointer, length }: { pointer: bigint, length: number | bigint }) => {
      const value = allocations.get(BigInt(pointer));
      if (!value || Number(length) > value.length) throw new Error('Invalid allocation');
      return value.subarray(0, Number(length));
    }),
    setField: vi.fn(({ name, pointer, field, value }: { name: string, pointer: bigint, field: string, value: number | bigint }) => {
      expect(name).toBe('llama_batch'); expect(field).toBe('logits'); fields.set(pointer, BigInt(value));
    }),
    free: vi.fn(({ pointer }: { pointer: bigint }) => {
      if (!allocations.delete(pointer)) throw new Error('Unexpected free');
    }),
  };
  return { core, allocations, fields, outputs: createPrefillOutputs({ core, mode }) };
}

describe('prefill output selection', () => {
  it('uses a single zero-filled bounded buffer and restores the final output', () => {
    const { core, allocations, fields, outputs } = fixture({ mode: 'final-only' });
    outputs.configure({ batch: 1n, count: 512, final: false });
    const flags = fields.get(1n)!;
    expect(flags).not.toBe(0n);
    expect(Array.from(allocations.get(flags)!)).toEqual(Array(512).fill(0));
    outputs.configure({ batch: 1n, count: 17, final: false });
    expect(fields.get(1n)).toBe(flags);
    outputs.configure({ batch: 1n, count: 1, final: true });
    expect(fields.get(1n)).toBe(0n);
    expect(core.tryAlloc).toHaveBeenCalledExactlyOnceWith({ bytes: 512 });
    expect(core.bytes).toHaveBeenCalledOnce();
    expect(outputs.counters).toEqual({ requestedLogits: 1, skippedLogits: 2, allocationFallbacks: 0 });
    expect(core.free).not.toHaveBeenCalled();
    outputs.dispose(); outputs.dispose();
    expect(core.free).toHaveBeenCalledExactlyOnceWith({ pointer: flags });
  });

  it.each(['final-only', 'per-batch'] as const)('does not allocate for a one-batch prompt: %s', mode => {
    const { core, fields, outputs } = fixture({ mode });
    outputs.configure({ batch: 1n, count: 27, final: true }); outputs.dispose();
    expect(fields.get(1n)).toBe(0n);
    expect(core.tryAlloc).not.toHaveBeenCalled(); expect(core.free).not.toHaveBeenCalled();
    expect(outputs.counters.requestedLogits).toBe(1);
  });

  it('keeps every output in the reference/unsupported mode', () => {
    const { core, fields, outputs } = fixture({ mode: 'per-batch' });
    for (const final of [false, false, true]) outputs.configure({ batch: 1n, count: 128, final });
    expect(fields.get(1n)).toBe(0n); expect(core.tryAlloc).not.toHaveBeenCalled();
    expect(outputs.counters).toEqual({ requestedLogits: 3, skippedLogits: 0, allocationFallbacks: 0 });
    outputs.dispose();
  });

  it('falls back once when the optional allocation is declined', () => {
    const { core, fields, outputs } = fixture({ mode: 'final-only' });
    core.tryAlloc.mockReturnValue(undefined);
    for (const final of [false, false, false, true]) outputs.configure({ batch: 1n, count: 128, final });
    expect(core.tryAlloc).toHaveBeenCalledOnce(); expect(fields.get(1n)).toBe(0n);
    expect(core.bytes).not.toHaveBeenCalled();
    expect(outputs.counters).toEqual({ requestedLogits: 4, skippedLogits: 0, allocationFallbacks: 1 });
    outputs.dispose(); expect(core.free).not.toHaveBeenCalled();
  });

  it('propagates allocation traps without selecting a fallback', () => {
    const { core, outputs } = fixture({ mode: 'final-only' });
    const error = new Error('native trap'); core.tryAlloc.mockImplementation(() => {
      throw error;
    });
    expect(() => outputs.configure({ batch: 1n, count: 128, final: false })).toThrow(error);
    expect(core.setField).not.toHaveBeenCalled(); expect(outputs.counters.allocationFallbacks).toBe(0);
    outputs.dispose(); expect(core.free).not.toHaveBeenCalled();
  });

  it.each(['bytes', 'setField'] as const)('retains ownership if %s fails after allocation', method => {
    const { core, allocations, outputs } = fixture({ mode: 'final-only' });
    core[method].mockImplementation(() => {
      throw new Error('injected failure');
    });
    expect(() => outputs.configure({ batch: 1n, count: 128, final: false })).toThrow('injected failure');
    expect(allocations.size).toBe(1); expect(core.free).not.toHaveBeenCalled();
    outputs.dispose(); expect(allocations.size).toBe(0);
  });

  it('holds no stale memory view across native memory growth', () => {
    const { core, allocations, fields, outputs } = fixture({ mode: 'final-only' });
    outputs.configure({ batch: 1n, count: 128, final: false });
    const pointer = fields.get(1n)!;
    const original = allocations.get(pointer)!;
    allocations.set(pointer, original.slice()); original.fill(77);
    outputs.configure({ batch: 1n, count: 512, final: false });
    expect(Array.from(allocations.get(fields.get(1n)!)!)).toEqual(Array(512).fill(0));
    expect(core.bytes).toHaveBeenCalledOnce(); outputs.dispose();
  });

  it('does not share buffers or allocation fallback between requests', () => {
    const { core, outputs } = fixture({ mode: 'final-only' });
    core.tryAlloc.mockReturnValueOnce(undefined);
    outputs.configure({ batch: 1n, count: 128, final: false }); outputs.dispose();
    const next = createPrefillOutputs({ core, mode: 'final-only' });
    next.configure({ batch: 2n, count: 128, final: false });
    expect(next.counters).toEqual({ requestedLogits: 0, skippedLogits: 1, allocationFallbacks: 0 }); next.dispose();
  });

  it.each([0, -1, 513, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects invalid count %s before allocation', count => {
    const { core, outputs } = fixture({ mode: 'final-only' });
    expect(() => outputs.configure({ batch: 1n, count, final: false })).toThrow();
    expect(core.tryAlloc).not.toHaveBeenCalled(); expect(core.setField).not.toHaveBeenCalled(); outputs.dispose();
  });

  it('cannot select outputs after disposal', () => {
    const { core, outputs } = fixture({ mode: 'final-only' }); outputs.dispose();
    expect(() => outputs.configure({ batch: 1n, count: 1, final: true })).toThrow();
    expect(core.setField).not.toHaveBeenCalled();
  });
});
