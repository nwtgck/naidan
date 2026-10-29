import type { ModelFileSource } from './model-file-source';

/** A shard is identified only by ordinal. This sits below read-ahead and counts
 * source read attempts and successful bytes, including any tail from the call. */
export function createModelFileDiagnostics({ ordinal, source }: { ordinal: number, source: ModelFileSource }) {
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
  const trace = ({ destination, offset, tail }: { destination: Uint8Array, offset: number, tail: Uint8Array | undefined }): number => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.size) {
      throw new RangeError('Invalid model read offset');
    }
    counters.sourceCalls++;
    counters.lastOffsetBytes = offset;
    try {
      let count: number;
      if (tail) {
        if (!source.readWithTail) {
          throw new Error('Model source does not support tail reads');
        }
        count = source.readWithTail({ destination, offset, tail });
      } else {
        count = source.read({ destination, offset });
      }
      if (!Number.isSafeInteger(count) || count < 0 || count > destination.byteLength + (tail?.byteLength ?? 0) || count > source.size - offset) {
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
  };
  const traced: ModelFileSource = {
    size: source.size,
    read({ destination, offset }) {
      return trace({ destination, offset, tail: undefined });
    },
  };
  if (source.readWithTail) {
    traced.readWithTail = ({ destination, offset, tail }) => trace({ destination, offset, tail });
  }
  return { counters, source: traced };
}

export const TEST_ONLY = {
};
