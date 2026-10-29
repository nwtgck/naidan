import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelReadCache } from './model-read-cache';
import type { ModelFileSource } from './model-file-source';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture() {
  const bytes = Uint8Array.from({ length: 300000 }, (_, index) => (index * 31 + Math.floor(index / 256)) % 251);
  const read = vi.fn<ModelFileSource['read']>(({ destination, offset }) => {
    const part = bytes.subarray(offset, offset + destination.length);
    destination.set(part);
    return part.length;
  });
  const readWithTail = vi.fn<NonNullable<ModelFileSource['readWithTail']>>(({ destination, offset, tail }) => {
    const body = bytes.subarray(offset, offset + destination.length);
    const after = bytes.subarray(offset + body.length, offset + body.length + tail.length);
    destination.set(body);
    tail.set(after);
    return body.length + after.length;
  });
  const backing: ModelFileSource = { size: bytes.length, read, readWithTail };
  const cache = createModelReadCache({ mode: 'read-ahead', now: undefined });
  return { bytes, read, readWithTail, backing, cache, source: cache.wrap({ source: backing }) };
}

describe('bounded tail reads from snapshot-backed model files', () => {
  it('keeps the large body in its native destination and caches only the adjacent stdio tail', () => {
    const f = fixture();
    using _cleanup = { [Symbol.dispose]: () => f.cache.dispose() };
    const allocation = new Uint8Array(new SharedArrayBuffer(65536 + 10)).fill(255);
    const destination = allocation.subarray(5, -5);
    expect(f.source.read({ destination, offset: 13 })).toBe(65536);
    expect(destination).toEqual(f.bytes.subarray(13, 65549));
    expect(allocation.subarray(0, 5)).toEqual(new Uint8Array(5).fill(255));
    expect(allocation.subarray(-5)).toEqual(new Uint8Array(5).fill(255));
    const [args] = f.readWithTail.mock.calls[0]!;
    expect(args.destination.buffer).toBe(allocation.buffer);
    expect(args.destination.byteOffset).toBe(5);
    expect(args.tail.byteLength).toBe(1024);
    const tail = new Uint8Array(1024);
    expect(f.source.read({ destination: tail, offset: 65549 })).toBe(1024);
    expect(tail).toEqual(f.bytes.subarray(65549, 66573));
    tail.fill(0);
    f.source.read({ destination: tail, offset: 65549 });
    expect(tail).toEqual(f.bytes.subarray(65549, 66573));
    expect(f.readWithTail).toHaveBeenCalledOnce();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.cache.counters).toMatchObject({ sourceCalls: 1, sourceBytes: 66560, deliveredBytes: 67584, hits: 2, peakBufferBytes: 65536 });
  });

  it('clamps a tail to the last byte and handles backseek plus a partial hit', () => {
    const f = fixture();
    using _cleanup = { [Symbol.dispose]: () => f.cache.dispose() };
    const destination = new Uint8Array(65536);
    const offset = f.bytes.length - destination.length - 1;
    f.source.read({ destination, offset });
    expect(f.readWithTail.mock.calls[0]![0].tail.length).toBe(1);
    const last = new Uint8Array(1024).fill(255);
    expect(f.source.read({ destination: last, offset: f.bytes.length - 1 })).toBe(1);
    expect(last[0]).toBe(f.bytes.at(-1));
    expect(last.subarray(1).every(value => value === 255)).toBe(true);
    expect(f.source.read({ destination: last, offset: f.bytes.length })).toBe(0);
    f.source.read({ destination, offset: 0 });
    expect(f.source.read({ destination: last, offset: 65536 })).toBe(1024);
    const crossing = new Uint8Array(2047);
    expect(f.source.read({ destination: crossing, offset: 65537 })).toBe(1023);
    expect(f.source.read({ destination: crossing.subarray(1023), offset: 66560 })).toBe(1024);
    expect(crossing).toEqual(f.bytes.subarray(65537, 67584));
  });

  it('preserves direct mode, ordinary sources, probes and metadata fills', () => {
    const f = fixture();
    using _cleanup = { [Symbol.dispose]: () => f.cache.dispose() };
    for (const offset of [0, 8, 16]) {
      f.source.read({ destination: new Uint8Array(8), offset });
    }
    expect(f.read.mock.calls.map(([args]) => args.destination.length)).toEqual([8, 65536]);
    expect(f.readWithTail).not.toHaveBeenCalled();
    const direct = createModelReadCache({ mode: 'direct', now: undefined });
    using _directCleanup = { [Symbol.dispose]: () => direct.dispose() };
    direct.wrap({ source: f.backing }).read({ destination: new Uint8Array(65536), offset: 100000 });
    expect(f.readWithTail).not.toHaveBeenCalled();
    expect(direct.counters.peakBufferBytes).toBe(0);
    delete f.backing.readWithTail;
    f.source.read({ destination: new Uint8Array(65536), offset: 100000 });
    expect(f.read.mock.calls.at(-1)![0].destination.length).toBe(65536);
  });

  it('does not reuse a tail for another shard or a replacement source', () => {
    const f = fixture();
    using _cleanup = { [Symbol.dispose]: () => f.cache.dispose() };
    f.source.read({ destination: new Uint8Array(65536), offset: 0 });
    const other = f.cache.wrap({
      source: {
        size: f.bytes.length,
        read: ({ destination }) => {
          destination.fill(211);
          return destination.length;
        },
      },
    });
    const destination = new Uint8Array(1024);
    other.read({ destination, offset: 65536 });
    expect(destination).toEqual(new Uint8Array(1024).fill(211));
    const replacement = f.cache.wrap({ source: f.backing });
    replacement.read({ destination, offset: 65536 });
    expect(destination).toEqual(f.bytes.subarray(65536, 66560));
    expect(f.cache.counters.hits).toBe(0);
    expect(f.cache.counters.peakBufferBytes).toBe(65536);
  });

  it('invalidates the old window on a failed bulk read without retrying it', () => {
    const f = fixture();
    using _cleanup = { [Symbol.dispose]: () => f.cache.dispose() };
    f.source.read({ destination: new Uint8Array(65536), offset: 0 });
    const failure = new RangeError('snapshot unavailable');
    f.readWithTail.mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => f.source.read({ destination: new Uint8Array(65536), offset: 100000 })).toThrow(failure);
    expect(f.readWithTail).toHaveBeenCalledTimes(2);
    const destination = new Uint8Array(1024);
    f.source.read({ destination, offset: 65536 });
    expect(f.read).toHaveBeenCalledOnce();
    expect(destination).toEqual(f.bytes.subarray(65536, 66560));
    expect(f.cache.counters.allocationFallbacks).toBe(0);
  });

  it.each([-1, 0.5, NaN, Infinity, 66561])('rejects an invalid combined source count %s', count => {
    const f = fixture();
    using _cleanup = { [Symbol.dispose]: () => f.cache.dispose() };
    f.readWithTail.mockReturnValueOnce(count);
    expect(() => f.source.read({ destination: new Uint8Array(65536), offset: 0 })).toThrow('Invalid model source read count');
    expect(f.cache.counters.sourceBytes).toBe(0);
    f.source.read({ destination: new Uint8Array(1024), offset: 65536 });
    expect(f.read).toHaveBeenCalledOnce();
  });

  it('does not publish a speculative tail after a partial body read', () => {
    const f = fixture();
    using _cleanup = { [Symbol.dispose]: () => f.cache.dispose() };
    f.readWithTail.mockImplementationOnce(({ destination, tail }) => {
      destination.set(f.bytes.subarray(0, 65529));
      tail.fill(211);
      return 65529;
    });
    expect(f.source.read({ destination: new Uint8Array(65536), offset: 0 })).toBe(65529);
    const destination = new Uint8Array(1024);
    f.source.read({ destination, offset: 65536 });
    expect(destination).toEqual(f.bytes.subarray(65536, 66560));
    expect(f.read).toHaveBeenCalledOnce();
  });

  it('uses the existing allocation fallback for an optional tail window', () => {
    const f = fixture();
    using _cleanup = { [Symbol.dispose]: () => f.cache.dispose() };
    const destination = new Uint8Array(65537);
    const Original = Uint8Array;
    let allocations = 0;
    vi.stubGlobal('Uint8Array', new Proxy(Original, {
      construct(target, args) {
        if (args[0] === 65536) {
          allocations++;
          throw new RangeError('allocation denied');
        }
        return Reflect.construct(target, args);
      },
    }));
    f.source.read({ destination, offset: 0 });
    f.source.read({ destination, offset: 65537 });
    expect(allocations).toBe(1);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.readWithTail).not.toHaveBeenCalled();
    expect(f.cache.counters).toMatchObject({ peakBufferBytes: 0, allocationFallbacks: 1 });
  });
});
