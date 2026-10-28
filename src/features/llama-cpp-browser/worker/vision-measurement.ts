import { subscribeDiagnostics, type Diagnostic } from '@/features/llama-cpp-browser/debug-log';
import { subscribeMemoryDiagnostics } from '@/features/llama-cpp-browser/runtime/memory-diagnostics';
import { visionDiagnosticSchema, visionStageSchema, type VisionDiagnostic } from '@/features/llama-cpp-browser/performance/vision-diagnostic-schema';
import type { ModelDirectory } from '@/features/llama-cpp-browser/runtime/model-directory';

/** Installed only for the explicit image workload. No native callbacks or waits. */
export function createVisionMeasurement({ directory, now }: { directory: ModelDirectory, now: () => number }) {
  let last = 0;
  let clockAnomalies = 0;
  const readClock = (): number => {
    try {
      const at = now();
      if (Number.isFinite(at) && at >= last) {
        last = at;
        return at;
      }
    } catch { /* Keep partial evidence without affecting inference. */ }
    clockAnomalies++;
    return last;
  };
  const started = readClock();
  const rows: VisionDiagnostic['rows'] = [];
  const nativeFailures: VisionDiagnostic['nativeFailures'] = [];
  const pending = new Map<Diagnostic['stage'], number>();
  let observed = 0, droppedRows = 0, unmatchedCompletions = 0, droppedFailures = 0, memorySamples = 0;
  let wasmCapacityMaxObservedBytes: number | undefined;
  let result: VisionDiagnostic | undefined;
  const unsubscribe = subscribeDiagnostics({
    debug: 'off',
    listener: ({ diagnostic }) => {
      switch (diagnostic.event) {
      case 'native-error': {
        if (nativeFailures.length < 16) {
          nativeFailures.push({ stage: diagnostic.stage, failureKind: diagnostic.failureKind, requestedBytes: diagnostic.requestedBytes, statusCode: diagnostic.statusCode });
        } else {
          droppedFailures++;
        }
        return;
      }
      case 'operation-start': case 'operation-complete': break;
      default: return; // Other allowlisted diagnostics do not describe image phase boundaries.
      }
      const stage = visionStageSchema.safeParse(diagnostic.stage);
      if (!stage.success) {
        return;
      }
      const open = pending.get(stage.data) ?? 0;
      switch (diagnostic.event) {
      case 'operation-start': pending.set(stage.data, open + 1);
        break;
      case 'operation-complete':
        if (open > 0) {
          pending.set(stage.data, open - 1);
        } else {
          unmatchedCompletions++;
        }
        break;
      default: {
        const exhaustive: never = diagnostic.event;
        throw new Error(String(exhaustive));
      }
      }
      observed++;
      if (rows.length >= 512) {
        droppedRows++;
        return;
      }
      rows.push({
        ordinal: observed,
        observedMs: Math.max(0, readClock() - started),
        event: diagnostic.event,
        stage: stage.data,
        nativeElapsedMs: diagnostic.elapsedMs,
        imageIndex: diagnostic.imageIndex,
        imageCount: diagnostic.imageCount,
        imageWidth: diagnostic.imageWidth,
        imageHeight: diagnostic.imageHeight,
        batchIndex: diagnostic.batchIndex,
        batchCount: diagnostic.batchCount,
        batchTokens: diagnostic.batchTokens,
        tokens: diagnostic.tokens,
        positions: diagnostic.positions,
        nextPosition: diagnostic.nextPosition,
        statusCode: diagnostic.statusCode,
      });
    },
  });
  const unsubscribeMemory = subscribeMemoryDiagnostics({
    listener: ({ diagnostic }) => {
      memorySamples++;
      wasmCapacityMaxObservedBytes = Math.max(wasmCapacityMaxObservedBytes ?? 0, diagnostic.capacityBytes);
    },
  });
  return {
    finish({ outcome }: { outcome: VisionDiagnostic['outcome'] }): VisionDiagnostic {
      if (result) {
        return result;
      }
      unsubscribe();
      unsubscribeMemory();
      result = visionDiagnosticSchema.parse({
        version: 1,
        captureStatus: 'observed',
        storagePolicy: 'runtime-default',
        storageComparison: 'unavailable',
        pureLmPrefill: 'unavailable',
        physicalMemoryPeak: 'unavailable',
        outcome,
        rows,
        droppedRows,
        pendingOperations: Array.from(pending.values()).reduce((sum, value) => sum + value, 0),
        unmatchedCompletions,
        clockAnomalies,
        nativeFailures,
        droppedFailures,
        memorySamples,
        wasmCapacityMaxObservedBytes,
        files: directory.files.slice(0, 128).map(file => ({
          role: file === directory.projectorFile ? 'projector' : 'model',
          relativePath: file.relativePath,
          bytes: file.file.size,
          lastModified: file.file.lastModified,
          storageKind: file.storageKind,
          registrationRevision: (() => {
            switch (file.storageKind) {
            case 'temp': return file.registrationRevision;
            case 'opfs': case 'host': return undefined;
            default: {
              const exhaustive: never = file;
              throw new Error(String(exhaustive));
            }
            }
          })(),
          contentIdentity: 'unverified',
        })),
        droppedFiles: Math.max(0, directory.files.length - 128),
      });
      return result;
    },
  };
}

export const TEST_ONLY = {
};
