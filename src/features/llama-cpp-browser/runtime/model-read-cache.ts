/** One load-scoped read window, shared by all model shards. Sources must remain
 * immutable until disposal (the callers hold exclusive OPFS sync handles).
 * Large tensor reads still go straight into the native destination. */
const windowBytes = 64 * 1024;
const maximumSmallReadBytes = 4096;
type Source = { size: number, read: ({ destination, offset }: { destination: Uint8Array, offset: number }) => number };

export function createModelReadCache({ mode, now }: {
  mode: 'read-ahead' | 'direct', now: (() => number) | undefined,
}) {
  let buffer: Uint8Array | undefined;
  let owner: symbol | undefined;
  let start = 0;
  let length = 0;
  let next: { owner: symbol, offset: number } | undefined;
  let disposed = false;
  let allocationFailed = false;
  const counters = {
    mode,
    requests: 0,
    sourceCalls: 0,
    sourceBytes: 0,
    deliveredBytes: 0,
    directReads: 0,
    fills: 0,
    hits: 0,
    hitBytes: 0,
    peakBufferBytes: 0,
    allocationFallbacks: 0,
    sourceReadMs: now ? 0 : undefined as number | undefined,
  };
  const readTime = (): number | undefined => {
    try {
      return now?.();
    } catch {
      return undefined;
    }
  };
  const assertLive = (): void => {
    if (disposed) throw new Error('Model read cache has been disposed');
  };
  return {
    counters,
    wrap({ source }: { source: Source }): Source {
      assertLive();
      const size = source.size;
      if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('Invalid model source size');
      const identity = Symbol();
      const readSource = ({ destination, offset }: { destination: Uint8Array, offset: number }): number => {
        counters.sourceCalls++;
        const began = now ? readTime() : undefined;
        let count: number;
        try {
          count = source.read({ destination, offset });
        } finally {
          if (began !== undefined && now && counters.sourceReadMs !== undefined) {
            const elapsed = (readTime() ?? NaN) - began;
            if (Number.isFinite(elapsed) && elapsed >= 0) counters.sourceReadMs += elapsed;
          }
        }
        if (!Number.isSafeInteger(count) || count < 0 || count > destination.byteLength) throw new Error('Invalid model source read count');
        counters.sourceBytes += count;
        return count;
      };
      return {
        size,
        read({ destination, offset }): number {
          assertLive();
          if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Invalid model read offset');
          counters.requests++;
          const wanted = Math.min(destination.byteLength, Math.max(0, size - offset));
          if (wanted === 0) return 0;
          const small = wanted <= maximumSmallReadBytes;
          const direct = (): number => {
            counters.directReads++;
            const count = readSource({ destination: destination.subarray(0, wanted), offset });
            next = small && count > 0 ? { owner: identity, offset: offset + count } : undefined;
            counters.deliveredBytes += count;
            return count;
          };
          try {
            switch (mode) {
            case 'direct': return direct();
            case 'read-ahead': break;
            default: { const exhaustive: never = mode; throw new Error(String(exhaustive)); }
            }
            // Never stage large weights through a second host buffer, even if
            // their initial bytes happen to be in the read-ahead window.
            if (!small || allocationFailed) return direct();
            if (buffer && owner === identity && offset >= start && offset - start < length) {
              const count = Math.min(wanted, length - (offset - start));
              destination.set(buffer.subarray(offset - start, offset - start + count));
              counters.hits++; counters.hitBytes += count; counters.deliveredBytes += count;
              next = { owner: identity, offset: offset + count };
              return count;
            }
            // Isolated header probes/random seeks retain their exact read size.
            // Only a second adjacent small read starts speculative read-ahead.
            if (next?.owner !== identity || next.offset !== offset) return direct();
            if (!buffer) {
              try {
                buffer = new Uint8Array(windowBytes);
              } catch (error) {
                if (!(error instanceof RangeError)) throw error;
                allocationFailed = true; counters.allocationFallbacks++;
                return direct();
              }
              counters.peakBufferBytes = buffer.byteLength;
            }
            // Invalidate before overwriting: a short, failed, or invalid fill
            // must never expose old bytes under the previous source identity.
            owner = undefined; length = 0;
            counters.fills++;
            const count = readSource({ destination: buffer.subarray(0, Math.min(windowBytes, size - offset)), offset });
            start = offset; length = count; owner = identity;
            const delivered = Math.min(wanted, count);
            destination.set(buffer.subarray(0, delivered));
            counters.deliveredBytes += delivered;
            next = delivered > 0 ? { owner: identity, offset: offset + delivered } : undefined;
            return delivered;
          } catch (error) {
            owner = undefined; length = 0; next = undefined;
            // Storage errors are not allocation failures: never retry or hide
            // them, and never reuse a window after a failed source operation.
            throw error;
          }
        },
      };
    },
    dispose(): void {
      disposed = true; buffer = undefined; owner = undefined; length = 0; next = undefined;
    },
  };
}

export const TEST_ONLY = {
  windowBytes,
  maximumSmallReadBytes,
};
