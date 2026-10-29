import type { ModelFileSource } from './model-file-source';
import { maximumModelReadTailBytes } from './model-file-source';

/** One read window, shared by all model shards during load and retained only
 * when the model reads file-backed rows during inference. Sources must remain
 * immutable until disposal. Large reads copy straight into the native destination;
 * only an optional small tail is retained in this window. */
const windowBytes = 64 * 1024;
const maximumSmallReadBytes = 4096;
const minimumTailReadBytes = windowBytes;

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
    if (disposed) {
      throw new Error('Model read cache has been disposed');
    }
  };
  const getBuffer = (): Uint8Array | undefined => {
    if (buffer || allocationFailed) {
      return buffer;
    }
    try {
      buffer = new Uint8Array(windowBytes);
    } catch (error) {
      if (!(error instanceof RangeError)) {
        throw error;
      }
      allocationFailed = true;
      counters.allocationFallbacks++;
      return undefined;
    }
    counters.peakBufferBytes = buffer.byteLength;
    return buffer;
  };
  return {
    counters,
    wrap({ source }: { source: ModelFileSource }): ModelFileSource {
      assertLive();
      const size = source.size;
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new RangeError('Invalid model source size');
      }
      const identity = Symbol();
      const readSource = ({ destination, offset, tail }: {
        destination: Uint8Array, offset: number, tail: Uint8Array | undefined,
      }): number => {
        counters.sourceCalls++;
        const began = now ? readTime() : undefined;
        let count: number;
        try {
          if (tail) {
            if (!source.readWithTail) {
              throw new Error('Model source does not support tail reads');
            }
            count = source.readWithTail({ destination, offset, tail });
          } else {
            count = source.read({ destination, offset });
          }
        } finally {
          if (began !== undefined && now && counters.sourceReadMs !== undefined) {
            const elapsed = (readTime() ?? NaN) - began;
            if (Number.isFinite(elapsed) && elapsed >= 0) {
              counters.sourceReadMs += elapsed;
            }
          }
        }
        if (!Number.isSafeInteger(count) || count < 0 || count > destination.byteLength + (tail?.byteLength ?? 0) || count > size - offset) {
          throw new Error('Invalid model source read count');
        }
        counters.sourceBytes += count;
        return count;
      };
      return {
        size,
        read({ destination, offset }): number {
          assertLive();
          if (!Number.isSafeInteger(offset) || offset < 0) {
            throw new RangeError('Invalid model read offset');
          }
          counters.requests++;
          const wanted = Math.min(destination.byteLength, Math.max(0, size - offset));
          if (wanted === 0) {
            return 0;
          }
          const small = wanted <= maximumSmallReadBytes;
          const direct = (): number => {
            counters.directReads++;
            const count = readSource({ destination: destination.subarray(0, wanted), offset, tail: undefined });
            next = small && count > 0 ? { owner: identity, offset: offset + count } : undefined;
            counters.deliveredBytes += count;
            return count;
          };
          try {
            switch (mode) {
            case 'direct': return direct();
            case 'read-ahead': break;
            default: {
              const exhaustive: never = mode;
              throw new Error(String(exhaustive));
            }
            }
            if (!small) {
              // FileReaderSync can fetch the stdio read-ahead in the same call.
              // The large body is never retained in the shared small window.
              if (!allocationFailed && source.readWithTail && wanted >= minimumTailReadBytes && wanted < size - offset) {
                const window = getBuffer();
                if (window) {
                  owner = undefined;
                  length = 0;
                  next = undefined;
                  counters.directReads++;
                  const count = readSource({
                    destination: destination.subarray(0, wanted),
                    offset,
                    tail: window.subarray(0, Math.min(maximumModelReadTailBytes, size - offset - wanted)),
                  });
                  start = offset + wanted;
                  length = Math.max(0, count - wanted);
                  owner = length > 0 ? identity : undefined;
                  const delivered = Math.min(wanted, count);
                  counters.deliveredBytes += delivered;
                  return delivered;
                }
              }
              return direct();
            }
            if (allocationFailed) {
              return direct();
            }
            if (buffer && owner === identity && offset >= start && offset - start < length) {
              const count = Math.min(wanted, length - (offset - start));
              destination.set(buffer.subarray(offset - start, offset - start + count));
              counters.hits++;
              counters.hitBytes += count;
              counters.deliveredBytes += count;
              next = { owner: identity, offset: offset + count };
              return count;
            }
            // Isolated header probes/random seeks retain their exact read size.
            // Only a second adjacent small read starts speculative read-ahead.
            if (next?.owner !== identity || next.offset !== offset) {
              return direct();
            }
            const window = getBuffer();
            if (!window) {
              return direct();
            }
            // Invalidate before overwriting: a short, failed, or invalid fill
            // must never expose old bytes under the previous source identity.
            owner = undefined;
            length = 0;
            counters.fills++;
            const count = readSource({ destination: window.subarray(0, Math.min(windowBytes, size - offset)), offset, tail: undefined });
            start = offset;
            length = count;
            owner = identity;
            const delivered = Math.min(wanted, count);
            destination.set(window.subarray(0, delivered));
            counters.deliveredBytes += delivered;
            next = delivered > 0 ? { owner: identity, offset: offset + delivered } : undefined;
            return delivered;
          } catch (error) {
            owner = undefined;
            length = 0;
            next = undefined;
            // Storage failures are not optional allocation failures. Do not
            // retry a failed source operation or preserve its previous window.
            throw error;
          }
        },
      };
    },
    dispose(): void {
      disposed = true;
      buffer = undefined;
      owner = undefined;
      length = 0;
      next = undefined;
    },
  };
}

export const TEST_ONLY = {
  windowBytes,
  maximumSmallReadBytes,
  minimumTailReadBytes,
};
