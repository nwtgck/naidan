/** Scalar-only accounting: no queue of timestamps grows with an inference run.
 * Sum and union are wall-clock observations, NOT GPU execution time. A wait
 * crossing a checkpoint is apportioned to both windows without double counting
 * its union. Different kinds of wait still must not be added to each other. */
export function createWaitAccounting({ now }: { now: () => number }) {
  let started = 0, settled = 0, rejected = 0, pending = 0, peak = 0;
  let completedMs = 0, pendingStarts = 0, unionMs = 0, unionStart = 0, maxMs = 0;
  return {
    start(): ({ failed }: { failed: boolean }) => void {
      const start = now(); started++; pendingStarts += start;
      if (pending++ === 0) unionStart = start;
      peak = Math.max(peak, pending);
      let done = false;
      return ({ failed }) => {
        if (done) return;
        done = true;
        const end = now(), duration = Math.max(0, end - start);
        settled++; rejected += Number(failed); completedMs += duration; maxMs = Math.max(maxMs, duration);
        pendingStarts -= start;
        if (--pending === 0) {
          unionMs += Math.max(0, end - unionStart); pendingStarts = 0;
        }
      };
    },
    snapshot() {
      const time = now();
      return { started, settled, rejected, pending, peakPending: peak, maxCompletedMs: maxMs,
        wallSumMs: completedMs + Math.max(0, pending * time - pendingStarts),
        wallUnionMs: unionMs + (pending ? Math.max(0, time - unionStart) : 0) };
    },
  };
}

/** writeBuffer's offset/size are ELEMENTS for typed arrays, BYTES for
 * ArrayBuffer/SharedArrayBuffer/DataView. Never read or copy payload contents.
 * Native validation has already run; unknown/invalid metadata is not guessed. */
export function uploadByteLength({ data, dataOffset = 0, size }: {
  data: Parameters<GPUQueue['writeBuffer']>[2], dataOffset?: number, size?: number,
}): number | undefined {
  try {
    const elementBytes = ArrayBuffer.isView(data) && 'BYTES_PER_ELEMENT' in data ? Number(data.BYTES_PER_ELEMENT) : 1;
    const offset = dataOffset * elementBytes;
    const bytes = size === undefined ? data.byteLength - offset : size * elementBytes;
    if (![offset, bytes, data.byteLength].every(value => Number.isSafeInteger(value) && value >= 0) || offset + bytes > data.byteLength) return undefined;
    return bytes;
  } catch {
    return undefined;
  }
}

/** Fixed 8 buckets; inclusive upper bounds, final bucket is all larger values. */
export const UPLOAD_BUCKET_LIMITS = [256, 4096, 65536, 1048576, 8388608, 67108864, 268435456] as const;
export function uploadBucket({ bytes }: { bytes: number }): number {
  const index = UPLOAD_BUCKET_LIMITS.findIndex(limit => bytes <= limit);
  return index < 0 ? UPLOAD_BUCKET_LIMITS.length : index;
}
export const TEST_ONLY = {
};
