import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelReadCache, TEST_ONLY } from './model-read-cache';

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function fixture({ size, mode }: { size: number, mode: 'read-ahead' | 'direct' }) {
  const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 31 + Math.floor(i / 256)) % 256);
  const read = vi.fn(({ destination, offset }: { destination: Uint8Array, offset: number }) => {
    const count = Math.min(destination.length, size - offset);
    destination.set(bytes.subarray(offset, offset + count)); return count;
  });
  const cache = createModelReadCache({ mode, now: undefined });
  const source = cache.wrap({ source: { size, read } });
  const request = ({ offset, length }: { offset: number, length: number }) => {
    const destination = new Uint8Array(length + 6).fill(199);
    const count = source.read({ destination: destination.subarray(3, 3 + length), offset });
    expect(destination.subarray(0, 3).every(byte => byte === 199)).toBe(true);
    expect(destination.subarray(3 + count).every(byte => byte === 199)).toBe(true);
    expect(Buffer.from(destination.subarray(3, 3 + count)).equals(bytes.subarray(offset, offset + count))).toBe(true);
    return count;
  };
  return { bytes, read, cache, source, request };
}

describe('load-scoped small-read window', () => {
  it('uses 17 source reads for 1024 adjacent 1 KiB reads without changing their bytes', () => {
    const f = fixture({ size: 1024 * 1024, mode: 'read-ahead' });
    for (let offset = 0; offset < f.bytes.length; offset += 1024) expect(f.request({ offset, length: 1024 })).toBe(1024);
    expect(f.cache.counters).toMatchObject({
      requests: 1024,
      sourceCalls: 17,
      directReads: 1,
      fills: 16,
      hits: 1007,
      sourceBytes: 1024 * 1024,
      deliveredBytes: 1024 * 1024,
      peakBufferBytes: 65536,
    });
  });

  it('keeps the reference path uncached and allocation-free', () => {
    const f = fixture({ size: 10000, mode: 'direct' });
    for (let offset = 0; offset < 1000; offset++) expect(f.request({ offset, length: 1 })).toBe(1);
    expect(f.cache.counters).toMatchObject({ sourceCalls: 1000, fills: 0, hits: 0, peakBufferBytes: 0 });
  });

  it('does not read ahead for isolated or nonadjacent small probes', () => {
    const f = fixture({ size: 200000, mode: 'read-ahead' });
    for (const offset of [0, 100000, 10, 199990, 90000]) f.request({ offset, length: 8 });
    expect(f.read.mock.calls.map(([args]) => args.destination.length)).toEqual([8, 8, 8, 8, 8]);
    expect(f.cache.counters.peakBufferBytes).toBe(0);
  });

  it('starts no read or allocation for zero bytes or offsets past the file end', () => {
    const f = fixture({ size: 20, mode: 'read-ahead' });
    for (const offset of [0, 19, 20, 21, Number.MAX_SAFE_INTEGER]) f.request({ offset, length: 0 });
    for (const offset of [20, 21, Number.MAX_SAFE_INTEGER]) f.request({ offset, length: 8 });
    expect(f.read).not.toHaveBeenCalled(); expect(f.cache.counters.peakBufferBytes).toBe(0);
  });

  it('reads only to the advertised end and never publishes stale suffix bytes', () => {
    const f = fixture({ size: 19, mode: 'read-ahead' });
    expect(f.request({ offset: 0, length: 8 })).toBe(8);
    expect(f.request({ offset: 8, length: 8 })).toBe(8);
    expect(f.request({ offset: 16, length: 8 })).toBe(3);
    expect(f.request({ offset: 19, length: 8 })).toBe(0);
    expect(f.read.mock.calls.map(([args]) => [args.offset, args.destination.length])).toEqual([[0, 8], [8, 11]]);
  });

  it('leaves large tensor reads in the caller buffer, even with a populated window', () => {
    const f = fixture({ size: 200000, mode: 'read-ahead' });
    f.request({ offset: 0, length: 8 }); f.request({ offset: 8, length: 8 });
    const destination = new Uint8Array(100000 + 9);
    expect(f.source.read({ destination: destination.subarray(9), offset: 16 })).toBe(100000);
    const args = f.read.mock.calls.at(-1)![0];
    expect(args.destination.buffer).toBe(destination.buffer); expect(args.destination.byteOffset).toBe(9);
    expect(args.destination.byteLength).toBe(100000);
    expect(destination.subarray(9)).toEqual(f.bytes.subarray(16, 100016));
  });

  it('serves a window boundary as a short read without dropping its remainder', () => {
    const f = fixture({ size: 150000, mode: 'read-ahead' });
    f.request({ offset: 0, length: 1 }); f.request({ offset: 1, length: 1 });
    expect(f.request({ offset: 65530, length: 16 })).toBe(7);
    expect(f.request({ offset: 65537, length: 9 })).toBe(9);
    expect(f.cache.counters.fills).toBe(2);
  });

  it('shares one fixed window across 100 shards and never confuses their contents', () => {
    const cache = createModelReadCache({ mode: 'read-ahead', now: undefined });
    const sources = Array.from({ length: 100 }, (_, index) => cache.wrap({
      source: {
        size: 200000,
        read: ({ destination }) => {
          destination.fill(index); return destination.length;
        },
      },
    }));
    for (let index = 0; index < sources.length; index++) {
      for (const offset of [0, 8, 16]) {
        const destination = new Uint8Array(8); sources[index]!.read({ destination, offset });
        expect(destination).toEqual(new Uint8Array(8).fill(index));
      }
    }
    const destination = new Uint8Array(8); sources[0]!.read({ destination, offset: 16 });
    expect(destination).toEqual(new Uint8Array(8));
    expect(cache.counters).toMatchObject({ peakBufferBytes: 65536, fills: 100, hits: 100 });
  });

  it('does not use a window for a newly wrapped source even with identical metadata', () => {
    const cache = createModelReadCache({ mode: 'read-ahead', now: undefined });
    let fill = 1;
    const backing = {
      size: 200000,
      read: ({ destination }: { destination: Uint8Array, offset: number }) => {
        destination.fill(fill); return destination.length;
      },
    };
    const old = cache.wrap({ source: backing }); const destination = new Uint8Array(8);
    old.read({ destination, offset: 0 }); old.read({ destination, offset: 8 });
    fill = 2;
    const replacement = cache.wrap({ source: backing }); replacement.read({ destination, offset: 16 });
    expect(destination).toEqual(new Uint8Array(8).fill(2)); expect(cache.counters.hits).toBe(0);
  });

  it('copies into destinations without retaining them or exposing the cache window', () => {
    const f = fixture({ size: 100000, mode: 'read-ahead' });
    f.request({ offset: 0, length: 8 }); f.request({ offset: 8, length: 8 });
    const destination = new Uint8Array(10); f.source.read({ destination, offset: 32 }); destination.fill(0);
    expect(f.request({ offset: 32, length: 10 })).toBe(10);
  });

  it('handles a shared destination and offsets above 4 GiB without truncation', () => {
    const cache = createModelReadCache({ mode: 'read-ahead', now: undefined });
    const size = 2 ** 40 + 100;
    const source = cache.wrap({
      source: {
        size,
        read: ({ destination, offset }) => {
          for (let i = 0; i < destination.length; i++) destination[i] = (offset + i) % 251;
          return destination.length;
        },
      },
    });
    for (const offset of [2 ** 40, 2 ** 40 + 8, 2 ** 40 + 16]) {
      const destination = new Uint8Array(new SharedArrayBuffer(8));
      expect(source.read({ destination, offset })).toBe(8);
      expect([...destination]).toEqual(Array.from({ length: 8 }, (_, i) => (offset + i) % 251));
    }
    expect(cache.counters.sourceCalls).toBe(2);
  });

  it('retains a short fill only up to the successful count and does not invent EOF data', () => {
    const f = fixture({ size: 100000, mode: 'read-ahead' });
    f.request({ offset: 0, length: 8 });
    f.read.mockImplementationOnce(({ destination, offset }) => {
      destination.fill(222); destination.set(f.bytes.subarray(offset, offset + 3)); return 3;
    });
    expect(f.request({ offset: 8, length: 8 })).toBe(3);
    f.read.mockReturnValueOnce(0);
    expect(f.request({ offset: 11, length: 5 })).toBe(0);
    expect(f.request({ offset: 11, length: 5 })).toBe(5);
  });

  it.each([-1, 1.5, NaN, Infinity, 65537])('rejects an invalid source count %s and invalidates previous bytes', count => {
    const f = fixture({ size: 200000, mode: 'read-ahead' });
    f.request({ offset: 0, length: 8 }); f.request({ offset: 8, length: 8 });
    f.read.mockReturnValueOnce(count);
    expect(() => f.request({ offset: 100000, length: 8 })).toThrow('Invalid model source read count');
    const calls = f.read.mock.calls.length;
    f.request({ offset: 16, length: 8 }); expect(f.read.mock.calls.length).toBe(calls + 1);
    expect(f.cache.counters.allocationFallbacks).toBe(0);
  });

  it('does not retry source exceptions or convert them to allocation fallbacks', () => {
    const f = fixture({ size: 100000, mode: 'read-ahead' });
    f.request({ offset: 0, length: 8 });
    const error = new RangeError('source failure');
    f.read.mockImplementationOnce(() => {
      throw error;
    });
    expect(() => f.request({ offset: 8, length: 8 })).toThrow(error);
    expect(f.read).toHaveBeenCalledTimes(2); expect(f.cache.counters.allocationFallbacks).toBe(0);
    f.request({ offset: 8, length: 8 }); expect(f.cache.counters.hits).toBe(0);
  });

  it('falls back once on a rejected optional buffer allocation and keeps reading directly', () => {
    const f = fixture({ size: 100000, mode: 'read-ahead' });
    f.request({ offset: 0, length: 8 });
    const Original = Uint8Array;
    let rejections = 0;
    vi.stubGlobal('Uint8Array', new Proxy(Original, {
      construct(target, args) {
        if (args[0] === TEST_ONLY.windowBytes) {
          rejections++; throw new RangeError('allocation denied');
        }
        return Reflect.construct(target, args);
      },
    }));
    for (const offset of [8, 16, 24, 32]) f.request({ offset, length: 8 });
    expect(rejections).toBe(1); expect(f.cache.counters).toMatchObject({ sourceCalls: 5, allocationFallbacks: 1, fills: 0, peakBufferBytes: 0 });
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid positions before any source call: %s', offset => {
    const f = fixture({ size: 100, mode: 'read-ahead' });
    expect(() => f.request({ offset, length: 8 })).toThrow('Invalid model read offset'); expect(f.read).not.toHaveBeenCalled();
  });

  it.each([-1, 0.5, NaN, Infinity])('rejects invalid source size: %s', size => {
    const cache = createModelReadCache({ mode: 'read-ahead', now: undefined });
    expect(() => cache.wrap({ source: { size, read: () => 0 } })).toThrow('Invalid model source size');
  });

  it('disposes once, refuses later source use, and retains only numeric counters for reporting', () => {
    const f = fixture({ size: 100000, mode: 'read-ahead' });
    f.request({ offset: 0, length: 8 }); f.request({ offset: 8, length: 8 });
    const counters = { ...f.cache.counters }; f.cache.dispose(); f.cache.dispose();
    expect(() => f.request({ offset: 16, length: 8 })).toThrow('disposed');
    expect(() => f.cache.wrap({ source: { size: 1, read: () => 0 } })).toThrow('disposed');
    expect(f.cache.counters).toEqual(counters);
  });

  it('measures source calls only, not cache hits, when timing is enabled', () => {
    let clock = 0; const now = vi.fn(() => clock++);
    const cache = createModelReadCache({ mode: 'read-ahead', now });
    const source = cache.wrap({
      source: {
        size: 100000,
        read: ({ destination }) => {
          destination.fill(0); return destination.length;
        },
      },
    });
    for (const offset of [0, 8, 16, 24]) source.read({ destination: new Uint8Array(8), offset });
    expect(now).toHaveBeenCalledTimes(4); expect(cache.counters.sourceReadMs).toBe(2);
  });

  it('never lets an observational clock failure replace storage reads or their exceptions', () => {
    const error = new Error('storage failure');
    const clockError = new Error('clock failure');
    const now = vi.fn(() => {
      throw clockError;
    });
    const read = vi.fn(({ destination }: { destination: Uint8Array, offset: number }) => {
      destination.fill(7); return destination.length;
    });
    const cache = createModelReadCache({ mode: 'read-ahead', now });
    const source = cache.wrap({ source: { size: 100000, read } });
    const destination = new Uint8Array(8);
    expect(source.read({ destination, offset: 0 })).toBe(8);
    expect(source.read({ destination, offset: 8 })).toBe(8);
    expect(source.read({ destination, offset: 16 })).toBe(8);
    expect(cache.counters.sourceReadMs).toBe(0);
    read.mockImplementationOnce(() => {
      throw error;
    });
    expect(() => source.read({ destination, offset: 90000 })).toThrow(error);
  });

  it('rechecks byte equality for mixed short reads, large bypasses, backward seeks and partial windows', () => {
    const f = fixture({ size: 300000, mode: 'read-ahead' });
    let seed = 47; const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 8;
    };
    let offset = 0;
    for (let i = 0; i < 3000; i++) {
      const length = random() % 3 === 0 ? random() % 8192 : random() % 50;
      if (random() % 4 === 0) offset = random() % 300100;
      offset += f.request({ offset, length });
      if (offset > f.bytes.length) offset = 0;
    }
    expect(f.cache.counters.hits).toBeGreaterThan(0); expect(f.cache.counters.fills).toBeGreaterThan(0);
  });
});
