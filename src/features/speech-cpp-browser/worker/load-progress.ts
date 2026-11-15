import type { SpeechLoadProgress } from '@/features/speech-cpp-browser/types';
import type { SpeechInvestigationObserver, SpeechInvestigationEvent } from '@/features/speech-cpp-browser/investigation/types';

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
      case 'preparing_runtime': case 'checking_model': case 'preparing_model': case 'checking_loaded_model': return 0;
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

/** Stage intervals are Worker host wall time, not GPU/kernel time. */
export function createSpeechLoadObservation({ observer, now }: { observer: SpeechInvestigationObserver | undefined, now: () => number }) {
  if (observer === undefined) {
    return undefined;
  }
  let send: SpeechInvestigationObserver | undefined = observer;
  let previous: { stage: SpeechLoadProgress['stage'], started: number } | undefined;
  function emit({ event }: { event: SpeechInvestigationEvent }): void {
    try {
      send?.({ event });
    } catch { /* Observational only. */ }
  }
  function finishStage({ state }: { state: 'completed' | 'cancelled' | 'failed' }): void {
    if (previous !== undefined) {
      emit({ event: { kind: 'stage', stage: previous.stage, state, durationMilliseconds: Math.max(0, now() - previous.started), heapBytes: undefined, details: undefined } });
    }
  }
  return {
    progress({ progress }: { progress: SpeechLoadProgress }): void {
      if (progress.stage !== previous?.stage) {
        finishStage({ state: 'completed' });
        previous = { stage: progress.stage, started: now() };
        emit({ event: { kind: 'stage', stage: progress.stage, state: 'started', durationMilliseconds: undefined, heapBytes: undefined, details: undefined } });
      }
      switch (progress.stage) {
      case 'loading_runtime': emit({ event: { kind: 'progress', stage: progress.stage, value: progress.decompressedBytes, total: progress.totalDecompressedBytes, unit: 'bytes', provenance: 'observed', details: { fetchedBytes: progress.fetchedBytes } } });
        break;
      case 'reading_model': emit({ event: { kind: 'progress', stage: progress.stage, value: progress.readBytes, total: progress.totalBytes, unit: 'bytes', provenance: 'observed', details: undefined } });
        break;
      case 'preparing_runtime': case 'checking_model': case 'preparing_model': case 'checking_loaded_model': break;
      default: {
        const exhaustive: never = progress;
        throw new Error(String(exhaustive));
      }
      }
    },
    finish({ state }: { state: 'completed' | 'cancelled' | 'failed' }): void {
      finishStage({ state });
      switch (state) {
      case 'completed': emit({ event: { kind: 'stage', stage: 'load_ready', state: 'completed', durationMilliseconds: undefined, heapBytes: undefined, details: undefined } });
        break;
      case 'cancelled': case 'failed': break;
      default: {
        const exhaustive: never = state;
        throw new Error(String(exhaustive));
      }
      }
      previous = undefined;
      send = undefined;
    },
  };
}

export const TEST_ONLY = {
};
