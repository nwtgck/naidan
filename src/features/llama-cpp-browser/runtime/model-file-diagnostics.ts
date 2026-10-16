/** A shard is identified only by its ordinal, never by a path or model name.
 * This sits below read-ahead, so it measures actual source reads, not cache hits. */
export function createModelFileDiagnostics({ ordinal, source }: { ordinal: number, source: {
  size: number,
  read: ({ destination, offset }: { destination: Uint8Array, offset: number }) => number,
} }) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 65535 || !Number.isSafeInteger(source.size) || source.size < 0) {
    throw new RangeError('Invalid model shard geometry');
  }
  const counters = {
    ordinal,
    sizeBytes: source.size,
    sourceCalls: 0,
    sourceBytes: 0,
    failures: 0,
    maximumReadEndBytes: 0,
    lastOffsetBytes: undefined as number | undefined,
  };
  return {
    counters,
    source: {
      size: source.size,
      read({ destination, offset }: { destination: Uint8Array, offset: number }): number {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.size) {
          throw new RangeError('Invalid model read offset');
        }
        counters.sourceCalls++;
        counters.lastOffsetBytes = offset;
        try {
          const count = source.read({ destination, offset });
          if (!Number.isSafeInteger(count) || count < 0 || count > destination.byteLength || count > source.size - offset) {
            throw new RangeError('Invalid model read count');
          }
          counters.sourceBytes += count;
          if (count > 0) {
            counters.maximumReadEndBytes = Math.max(counters.maximumReadEndBytes, offset + count);
          }
          return count;
        } catch (error) {
          counters.failures++;
          throw error;
        }
      },
    },
  };
}

export const TEST_ONLY = {
};
