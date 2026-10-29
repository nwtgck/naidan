// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logNativeDiagnostic, logNativeCheckpoint } from '@/features/llama-cpp-browser/debug-log';
import { beginMemoryDiagnostics, sampleMemoryDiagnostics } from '@/features/llama-cpp-browser/runtime/memory-diagnostics';
import { visionDiagnosticSchema } from '@/features/llama-cpp-browser/performance/vision-diagnostic-schema';
import { createVisionMeasurement } from './vision-measurement';
import type { ModelDirectory } from '@/features/llama-cpp-browser/runtime/model-directory';

afterEach(() => vi.restoreAllMocks());

function directory(): ModelDirectory {
  const model = { relativePath: 'model.gguf', file: new File(['model'], 'model.gguf', { lastModified: 1 }), storageKind: 'temp' as const, registrationRevision: 3 };
  const projector = { relativePath: 'projector.gguf', file: new File(['projector'], 'projector.gguf', { lastModified: 2 }), storageKind: 'temp' as const, registrationRevision: 3 };
  return { files: [model, projector], primaryFile: model, projectorFile: projector };
}

describe('image measurement lifetime and bounded evidence', () => {
  it('retains existing native media timers, image phases, file identities and observed capacity', () => {
    let now = 0;
    const observation = createVisionMeasurement({ directory: directory(), now: () => now });
    using _cleanup = {
      [Symbol.dispose]() {
        observation.finish({ outcome: 'failed' });
      },
    };
    logNativeCheckpoint({ diagnostic: { event: 'operation-start', stage: 'image-evaluate', tokens: 64 } });
    now = 20;
    logNativeDiagnostic({ message: 'encoding image slice...' });
    logNativeDiagnostic({ message: 'image slice encoded in 12 ms' });
    logNativeDiagnostic({ message: 'decoding image batch 1/1, n_tokens_batch = 64' });
    logNativeDiagnostic({ message: 'image decoded (batch 1/1) in 7 ms' });
    now = 30;
    logNativeCheckpoint({ diagnostic: { event: 'operation-complete', stage: 'image-evaluate', nextPosition: 66 } });
    const core = { module: { HEAPU8: new Uint8Array(512) } };
    beginMemoryDiagnostics({ core, profile: 'cpu-wasm32' });
    core.module.HEAPU8 = new Uint8Array(1024);
    sampleMemoryDiagnostics({ core, checkpoint: 'prefill-complete' });
    const result = observation.finish({ outcome: 'completed' });
    expect(result.rows.map(row => row.stage)).toEqual(['image-evaluate', 'media-encode', 'media-encode', 'media-decode', 'media-decode', 'image-evaluate']);
    expect(result.rows[2]?.nativeElapsedMs).toBe(12);
    expect(result.rows[4]?.nativeElapsedMs).toBe(7);
    expect(result).toMatchObject({ pendingOperations: 0, unmatchedCompletions: 0, droppedRows: 0, wasmCapacityMaxObservedBytes: 1024, storageComparison: 'unavailable', pureLmPrefill: 'unavailable', physicalMemoryPeak: 'unavailable' });
    expect(result.files.map(file => file.role)).toEqual(['model', 'projector']);
    expect(result.files.every(file => file.contentIdentity === 'unverified')).toBe(true);
    logNativeDiagnostic({ message: 'encoding image slice...' });
    expect(observation.finish({ outcome: 'failed' })).toBe(result);
    expect(result.rows).toHaveLength(6);
  });

  it('keeps failures and incomplete boundaries without interpreting missing memory as zero', () => {
    const observation = createVisionMeasurement({ directory: directory(), now: () => 10 });
    logNativeCheckpoint({ diagnostic: { event: 'operation-start', stage: 'image-tokenize' } });
    logNativeCheckpoint({ diagnostic: { event: 'native-error', stage: 'media-encode', failureKind: 'native-buffer-allocation', requestedBytes: 4096 } });
    const result = observation.finish({ outcome: 'failed' });
    expect(result).toMatchObject({ outcome: 'failed', pendingOperations: 1, memorySamples: 0, nativeFailures: [{ requestedBytes: 4096 }] });
    expect(result.wasmCapacityMaxObservedBytes).toBeUndefined();
    expect(visionDiagnosticSchema.safeParse({ ...result, physicalMemoryPeak: 4096 }).success).toBe(false);
  });

  it('bounds event storage and marks invalid clock reads and unmatched completion', () => {
    const clock = vi.fn<() => number>().mockReturnValueOnce(10).mockReturnValueOnce(9).mockReturnValue(Number.NaN);
    const observation = createVisionMeasurement({ directory: directory(), now: clock });
    for (let index = 0; index < 530; index++) {
      logNativeCheckpoint({ diagnostic: { event: 'operation-complete', stage: 'image-decode' } });
    }
    const result = observation.finish({ outcome: 'aborted' });
    expect(result.rows).toHaveLength(512);
    expect(result).toMatchObject({ droppedRows: 18, unmatchedCompletions: 530, clockAnomalies: 512, outcome: 'aborted' });
    expect(result.rows.every(row => row.observedMs === 0)).toBe(true);
  });
});
