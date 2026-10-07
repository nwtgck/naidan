import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';

const maximumEntries = 1024;
const maximumCachedBytes = 256 * 1024;
const maximumCachedPieceBytes = 16 * 1024;
const maximumPieceBytes = 1024 * 1024;
type RenderingCore = Pick<Core, 'alloc' | 'free' | 'bytes'> & {
  api: Pick<Core['api'], 'llama_vocab_is_eog' | 'llama_token_to_piece'>;
};

/** Request-local, bounded memoization of vocabulary results, not decoded text.
 * UTF-8 decoding must still consume every piece in stream order. No native view
 * or request-specific parser/sampler state is kept in the cache. */
export function createTokenRenderer({ core, vocab, cacheMode }: {
  core: RenderingCore, vocab: bigint, cacheMode: 'bounded' | 'disabled',
}) {
  const decoder = new TextDecoder();
  const entries = new Map<number, { bytes: Uint8Array, endOfGeneration: boolean }>();
  const counters = {
    cacheHits: 0,
    cacheMisses: 0,
    eogCalls: 0,
    pieceCalls: 0,
    evictions: 0,
    oversizedPieces: 0,
    peakEntries: 0,
    peakCachedBytes: 0,
    allocationFallbacks: 0,
  };
  let cachedBytes = 0;
  let cacheState: 'active' | 'allocation-failed' = 'active';
  let scratch: bigint | undefined;
  let capacity = 256;
  let busy = false;
  let disposed = false;
  const assertIdle = (): void => {
    if (busy) throw new Error('Cannot access a token renderer during a native call');
    if (disposed) throw new Error('Token renderer has been disposed');
  };
  const invalidResult = (): never => {
    throw new LlamaCppBrowserError({ code: 'runtime-error' });
  };
  const evict = (): void => {
    const oldest = entries.entries().next().value;
    if (!oldest) return;
    cachedBytes -= oldest[1].bytes.length;
    entries.delete(oldest[0]);
    counters.evictions++;
  };
  return {
    counters,
    async render({ token, special }: { token: number, special: boolean }): Promise<{ text: string, endOfGeneration: boolean }> {
      assertIdle();
      if (!Number.isSafeInteger(token) || token < 0 || token > 2147483647) return invalidResult();
      // Both modes may occur for the same token. Multiplication (not bitwise
      // shifts) preserves signed-int32 token IDs without truncating the key.
      const key = token * 2 + Number(special);
      const cached = entries.get(key);
      if (cached) {
        entries.delete(key); entries.set(key, cached);
        counters.cacheHits++;
        return { text: decoder.decode(cached.bytes, { stream: true }), endOfGeneration: cached.endOfGeneration };
      }
      counters.cacheMisses++;
      busy = true;
      try {
        counters.eogCalls++;
        const end = await core.api.llama_vocab_is_eog(vocab, token);
        if (end !== 0 && end !== 1) return invalidResult();
        if (scratch === undefined) scratch = core.alloc({ bytes: capacity });
        const piece = async (): Promise<number> => {
          counters.pieceCalls++;
          return core.api.llama_token_to_piece(vocab, token, scratch!, capacity, 0, Number(special));
        };
        let length = await piece();
        if (!Number.isSafeInteger(length) || Math.abs(length) > maximumPieceBytes) return invalidResult();
        if (length < 0) {
          const required = -length;
          if (required <= capacity) return invalidResult();
          // The first call has settled; release before allocating the larger
          // buffer. A rejected allocation must never cause a second free.
          const previous = scratch; scratch = undefined;
          core.free({ pointer: previous });
          capacity = required;
          scratch = core.alloc({ bytes: capacity });
          length = await piece();
          if (length !== required) return invalidResult();
        }
        if (!Number.isSafeInteger(length) || length < 0 || length > capacity) return invalidResult();
        // Reacquire after the native call: Wasm memory may have grown.
        const bytes = core.bytes({ pointer: scratch, length });
        const endOfGeneration = end === 1;
        switch (cacheMode) {
        case 'disabled': break;
        case 'bounded':
          switch (cacheState) {
          case 'allocation-failed': break;
          case 'active':
            if (length > maximumCachedPieceBytes) counters.oversizedPieces++;
            else {
              while (entries.size >= maximumEntries || cachedBytes + length > maximumCachedBytes) evict();
              // Copy before another native call can overwrite or detach the heap.
              let copied: Uint8Array;
              try {
                copied = bytes.slice();
              } catch (error) {
                // Memoization is optional. Release its memory and stop retrying
                // allocation for this request, without resetting UTF-8 state.
                // Native/heap access above stays outside this narrow fallback.
                if (!(error instanceof RangeError)) throw error;
                entries.clear(); cachedBytes = 0;
                cacheState = 'allocation-failed'; counters.allocationFallbacks++;
                break;
              }
              entries.set(key, { bytes: copied, endOfGeneration });
              cachedBytes += length;
              counters.peakEntries = Math.max(counters.peakEntries, entries.size);
              counters.peakCachedBytes = Math.max(counters.peakCachedBytes, cachedBytes);
            }
            break;
          default: { const exhaustive: never = cacheState; throw new Error(String(exhaustive)); }
          }
          break;
        default: { const exhaustive: never = cacheMode; throw new Error(String(exhaustive)); }
        }
        return { text: decoder.decode(bytes, { stream: true }), endOfGeneration };
      } finally {
        busy = false;
      }
    },
    finish(): string {
      assertIdle();
      return decoder.decode();
    },
    dispose(): void {
      if (disposed) return;
      assertIdle();
      disposed = true;
      entries.clear(); cachedBytes = 0;
      const previous = scratch; scratch = undefined;
      if (previous !== undefined) core.free({ pointer: previous });
    },
  };
}
export const TEST_ONLY = {
  maximumEntries,
  maximumCachedBytes,
  maximumCachedPieceBytes,
  maximumPieceBytes,
};
