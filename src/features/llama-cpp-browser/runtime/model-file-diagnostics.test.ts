import { describe, expect, it, vi } from 'vitest';
import { createModelFileDiagnostics } from './model-file-diagnostics';

describe('ordinal-only model file read diagnostics', () => {
  it('preserves offsets above 4 GiB and records delivered rather than requested bytes', () => {
    const size = 50_000_000_000;
    const read = vi.fn(() => 7);
    const trace = createModelFileDiagnostics({ ordinal: 2, source: { size, read } });
    const destination = new Uint8Array(90);
    const offset = 2 ** 32 + 100;
    expect(trace.source.read({ destination, offset })).toBe(7);
    expect(read).toHaveBeenCalledExactlyOnceWith({ destination, offset });
    expect(trace.counters).toEqual({ ordinal: 2, sizeBytes: size, sourceCalls: 1, sourceBytes: 7, failures: 0, lastOffsetBytes: offset, maximumReadEndBytes: offset + 7 });
    read.mockReturnValue(0);
    expect(trace.source.read({ destination, offset: size })).toBe(0);
    expect(trace.counters.maximumReadEndBytes).toBe(offset + 7);
    expect(trace.counters.lastOffsetBytes).toBe(size);
  });

  it('records storage failures without replacing the original exception', () => {
    const error = new Error('private path must not be collected');
    const trace = createModelFileDiagnostics({
      ordinal: 3,
      source: {
        size: 30,
        read: () => {
          throw error;
        },
      },
    });
    expect(() => trace.source.read({ destination: new Uint8Array(10), offset: 7 })).toThrow(error);
    expect(trace.counters.failures).toBe(1);
    expect(trace.counters.sourceBytes).toBe(0);
    expect(JSON.stringify(trace.counters)).not.toContain('private');
  });

  it.each([-1, 11, NaN, Infinity, 1.5])('rejects invalid source result %s', count => {
    const trace = createModelFileDiagnostics({ ordinal: 1, source: { size: 10, read: () => count } });
    expect(() => trace.source.read({ destination: new Uint8Array(10), offset: 0 })).toThrow('Invalid model read count');
    expect(trace.counters.failures).toBe(1);
  });

  it('rejects over-EOF counts and invalid offsets before reading', () => {
    const read = vi.fn(() => 2);
    const trace = createModelFileDiagnostics({ ordinal: 1, source: { size: 10, read } });
    expect(() => trace.source.read({ destination: new Uint8Array(10), offset: 9 })).toThrow('Invalid model read count');
    for (const offset of [-1, 11, NaN, 0.5]) expect(() => trace.source.read({ destination: new Uint8Array(10), offset })).toThrow('Invalid model read offset');
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 65536, 0.5, NaN])('rejects invalid shard ordinal %s', ordinal => {
    expect(() => createModelFileDiagnostics({ ordinal, source: { size: 0, read: () => 0 } })).toThrow('Invalid model shard geometry');
  });
});
