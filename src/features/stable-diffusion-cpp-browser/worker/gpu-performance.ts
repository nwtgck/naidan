import type { ImageDiagnosticInput, createImageTrace } from '@/features/stable-diffusion-cpp-browser/diagnostics';
import { createWaitAccounting, UPLOAD_BUCKET_LIMITS, uploadBucket } from './performance-counters';
export type MeasurementPoint = { phase: string, step: number, reason: string };
export type MeasurementOutcome = 'complete' | 'cancelled' | 'failed';
const counters = () => ({
  buffers: 0, bufferBytesRequested: 0, shaders: 0, pipelineSync: 0, pipelineAsync: 0,
  shaderHostMs: 0, pipelineHostMs: 0, pipelineAsyncSettled: 0, pipelineAsyncFailed: 0, pipelineAsyncWallMs: 0,
  writes: 0, writeBytes: 0, writeBytesUnknown: 0, uniformWriteBytes: 0, storageWriteBytes: 0, otherWriteBytes: 0,
  submissions: 0, encoders: 0, computePasses: 0, dispatches: 0, indirectDispatches: 0,
  copies: 0, copyBytes: 0, copyBytesUnknown: 0, copyToMapReadBytes: 0,
  mapReadRequests: 0, mapReadBytes: 0, mapWriteRequests: 0, mapWriteBytes: 0, mapBytesUnknown: 0,
});
export type GpuCounters = ReturnType<typeof counters>;
const delta = ({ value, previous }: { value: Record<string, number>, previous: Record<string, number> }) =>
  Object.fromEntries(Object.entries(value).map(([key, count]) => [key, Math.max(0, count - (previous[key] ?? 0))]));

/** Persistent observer, independent run scopes. A promise settles against the
 * run that CREATED it, never whatever run happens to be active later. */
export function createGpuMeasurements({ emit, now }: { emit: ReturnType<typeof createImageTrace>['emit'], now: () => number }) {
  type Run = { runId: number, began: number, lastAt: number, closed: boolean, point: MeasurementPoint, counts: GpuCounters,
    previous: GpuCounters, histogram: number[], previousHistogram: number[], queue: ReturnType<typeof createWaitAccounting>, mapping: ReturnType<typeof createWaitAccounting>,
    previousQueue: Record<string, number>, previousMapping: Record<string, number> };
  let current: Run | undefined;
  const unavailable = new Set<string>();
  const deviceSummaries: ImageDiagnosticInput['fields'][] = [];
  function report({ metric, fields }: { metric: string, fields: ImageDiagnosticInput['fields'] }): void {
    try {
      emit({ event: 'gpu', stage: 'generation', message: 'Passive WebGPU performance counters; wall times are not GPU timestamps', fields: { metric, perfVersion: 1, ...fields } });
    } catch { /* diagnostic only */ }
  }
  function flush({ final, reason }: { final: boolean, reason: string }): void {
    const run = current; if (!run || run.closed) return;
    const time = now();
    const fields = { runId: run.runId, phase: run.point.phase, step: run.point.step, reason,
      windowStartMs: final ? 0 : run.lastAt - run.began, windowWallMs: Math.max(0, time - (final ? run.began : run.lastAt)),
      scope: final ? 'run-total' : 'window' };
    const counts = final ? { ...run.counts } : delta({ value: run.counts, previous: run.previous });
    report({ metric: 'gpu-counters', fields: { ...fields, ...counts } });
    report({ metric: 'gpu-write-sizes', fields: { ...fields, bucketUpperBytes: [...UPLOAD_BUCKET_LIMITS],
      // Last bucket is > final upper bound, no unbounded histogram/labels.
      calls: run.histogram.map((n, i) => final ? n : n - run.previousHistogram[i]!) } });
    for (const [kind, wait, previous] of [['queue', run.queue, run.previousQueue], ['map', run.mapping, run.previousMapping]] as const) {
      const value = wait.snapshot();
      const difference = final ? value : delta({ value, previous });
      report({ metric: 'gpu-wait', fields: { ...fields, kind, ...difference,
        pending: value.pending, peakPending: value.peakPending, maxCompletedMs: value.maxCompletedMs } });
      if (!final) Object.assign(previous, value);
    }
    if (!final) {
      run.previous = { ...run.counts }; run.previousHistogram = [...run.histogram]; run.lastAt = time;
    }
  }
  return {
    current(): Run | undefined {
      return current?.closed ? undefined : current;
    },
    unavailable({ method }: { method: string }): void {
      if (unavailable.size < 32) unavailable.add(method);
    },
    device({ fields }: { fields: ImageDiagnosticInput['fields'] }): void {
      // This runtime requests very few devices. Keep only small immutable facts.
      if (deviceSummaries.length < 4) deviceSummaries.push(fields);
      report({ metric: 'gpu-device', fields });
    },
    begin({ runId }: { runId: number }): void {
      if (current) current.closed = true;
      const time = now();
      current = { runId, began: time, lastAt: time, closed: false, point: { phase: 'runtime', step: 0, reason: 'begin' }, counts: counters(), previous: counters(),
        histogram: Array(8).fill(0), previousHistogram: Array(8).fill(0), queue: createWaitAccounting({ now }), mapping: createWaitAccounting({ now }), previousQueue: {}, previousMapping: {} };
      report({ metric: 'gpu-observation', fields: { runId, gpuTimestamps: false, addedQueueWaits: false,
        countsAreHostCalls: true, bufferBytesAreLiveVram: false, unavailableMethods: [...unavailable].join(',').slice(0, 512) } });
      for (const fields of deviceSummaries) report({ metric: 'gpu-device', fields: { ...fields, runId, reusedDevice: true } });
    },
    checkpoint({ point }: { point: MeasurementPoint }): void {
      if (!current || current.closed) return;
      flush({ final: false, reason: point.reason }); current.point = { ...point };
    },
    finish({ outcome }: { outcome: MeasurementOutcome }): void {
      if (!current || current.closed) return;
      flush({ final: false, reason: outcome }); flush({ final: true, reason: outcome });
      report({ metric: 'gpu-observation-end', fields: { runId: current.runId, unavailableMethods: [...unavailable].join(',').slice(0, 512) } });
      current.closed = true;
    },
    write({ bytes, usage }: { bytes: number | undefined, usage: number }): void {
      const run = current; if (!run || run.closed) return;
      run.counts.writes++;
      if (bytes === undefined) {
        run.counts.writeBytesUnknown++; return;
      }
      run.counts.writeBytes += bytes; run.histogram[uploadBucket({ bytes })]!++;
      // API usage is NOT semantic ownership (weights vs activations).
      if (usage & 0x0040) run.counts.uniformWriteBytes += bytes;
      else if (usage & 0x0080) run.counts.storageWriteBytes += bytes;
      else run.counts.otherWriteBytes += bytes;
    },
    dispose(): void {
      if (current) current.closed = true; current = undefined;
    },
  };
}
export const TEST_ONLY = {
};
