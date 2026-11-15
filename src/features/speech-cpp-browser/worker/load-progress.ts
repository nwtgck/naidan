import type { SpeechLoadProgress } from '@/features/speech-cpp-browser/types';

/** Track the union of successful reads, not their sum or the largest offset.
 * Adjacent ranges are merged, keeping sequential multi-GiB reads inexpensive. */
export function createSpeechReadCoverage({ size }: { size: number }) {
  const ranges: { start: number, end: number }[] = [];
  let covered = 0;
  return {
    add({ offset, length }: { offset: number, length: number }): number {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size) {
        throw new RangeError('Invalid speech file coverage range');
      }
      if (length === 0) {
        return covered;
      }
      let low = 0, high = ranges.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (ranges[middle]!.end < offset) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
      let start = offset, end = offset + length, index = low, removed = 0;
      while (index < ranges.length && ranges[index]!.start <= end) {
        const range = ranges[index++]!;
        start = Math.min(start, range.start);
        end = Math.max(end, range.end);
        removed += range.end - range.start;
      }
      ranges.splice(low, index - low, { start, end });
      covered += end - start - removed;
      return covered;
    },
  };
}

/** Load-only observations: at most one update per 1% step or 100 ms, plus
 * stage transitions. No progress tracking runs in the audio frame callback. */
export function createSpeechLoadReporter({ onProgress, now }: {
  onProgress: ({ progress }: { progress: SpeechLoadProgress }) => void, now: () => number,
}) {
  let previous: SpeechLoadProgress | undefined;
  let previousTime = -Infinity, previousRatio = 0;
  return ({ progress }: { progress: SpeechLoadProgress }): void => {
    const ratio = (() => {
      switch (progress.stage) {
      case 'preparing_runtime': case 'preparing_model': return 0;
      case 'loading_runtime': return progress.decompressedBytes / progress.totalDecompressedBytes;
      case 'reading_model': return progress.readBytes / progress.totalBytes;
      default: {
        const exhaustive: never = progress;
        throw new Error(String(exhaustive));
      }
      }
    })();
    const time = now();
    if (progress.stage !== previous?.stage || ratio - previousRatio >= 0.01 || time - previousTime >= 100) {
      previous = progress;
      previousTime = time;
      previousRatio = ratio;
      onProgress({ progress });
    }
  };
}

export async function readSpeechWasm({ response, wasmBytes, onProgress }: {
  response: Response, wasmBytes: number, onProgress: ({ progress }: { progress: SpeechLoadProgress }) => void,
}): Promise<Uint8Array<ArrayBuffer>> {
  if (response.body === null) {
    throw new Error('Missing speech Wasm response body');
  }
  const wasmBinary = new Uint8Array(wasmBytes);
  let fetchedBytes = 0, offset = 0;
  function publish(): void {
    onProgress({ progress: { stage: 'loading_runtime', fetchedBytes, decompressedBytes: offset, totalDecompressedBytes: wasmBytes } });
  }
  publish();
  const counted = response.body.pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      fetchedBytes += chunk.byteLength;
      publish();
      controller.enqueue(chunk);
    },
  }));
  const reader = counted.pipeThrough(new DecompressionStream('gzip')).getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      if (offset + chunk.value.length > wasmBinary.length) {
        throw new Error('Decompressed speech Wasm exceeds manifest size');
      }
      wasmBinary.set(chunk.value, offset);
      offset += chunk.value.length;
      publish();
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (offset !== wasmBinary.length) {
    throw new Error('Truncated speech Wasm');
  }
  return wasmBinary;
}

export const TEST_ONLY = {
};
