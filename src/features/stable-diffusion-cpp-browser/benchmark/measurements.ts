import { createImageDiagnosticBuffer, imageDiagnosticSchema } from '@/features/stable-diffusion-cpp-browser/diagnostics';
import type { ImageDiagnostic } from '@/features/stable-diffusion-cpp-browser/diagnostics';
import { measurementSchema } from './types';
import type { BenchmarkMeasurements } from './types';

/** Summaries are accumulated before bounded raw-log truncation. Missing metrics
 * remain absent, never a synthetic zero or a guessed fresh/warm observation. */
export function createBenchmarkMeasurements() {
  const buffer = createImageDiagnosticBuffer();
  const values: BenchmarkMeasurements = { diagnosticsReceived: 0, invalidDiagnostics: 0, omittedDiagnostics: 0, steps: [] };
  const files = new Map<string, { reads: number, bytes: number, blobReads: number, blobBytes: number }>();
  function append({ diagnostic }: { diagnostic: ImageDiagnostic }): void {
    const parsed = imageDiagnosticSchema.safeParse(diagnostic);
    if (!parsed.success) {
      values.invalidDiagnostics++; return;
    }
    values.diagnosticsReceived++; buffer.append({ diagnostic: parsed.data });
    const f = parsed.data.fields;
    if (f.perfVersion !== 1) return;
    switch (f.metric) {
    case 'worker-selection':
      if (typeof f.reusedWorker === 'boolean' && typeof f.reason === 'string') values.reuse = { reusedWorker: f.reusedWorker, reason: f.reason };
      break;
    case 'run-wall': values.runWall = { ...f }; break;
    case 'step-wall':
      if (typeof f.step === 'number' && typeof f.milliseconds === 'number' && f.step >= 1 && f.step <= 100 && f.milliseconds >= 0 && !values.steps.some(step => step.step === f.step)) {
        values.steps.push({ step: f.step, milliseconds: f.milliseconds });
      }
      break;
    case 'file-read-run':
      if (typeof f.slot === 'string' && typeof f.path === 'string' && [f.reads, f.bytes, f.blobReads, f.blobBytes].every(v => typeof v === 'number' && v >= 0)) {
        // Key by tuple; repeated summaries for the same file replace, not add.
        files.set(JSON.stringify([f.slot, f.path]), { reads: Number(f.reads), bytes: Number(f.bytes), blobReads: Number(f.blobReads), blobBytes: Number(f.blobBytes) });
      }
      break;
    default: break; // Unrecognised versioned metrics remain in diagnostics.jsonl.
    }
  }
  function snapshot(): { metrics: BenchmarkMeasurements, text: string } {
    const text = buffer.text();
    const truncated = /\{"event":"buffer-truncated","omitted":(\d+)\}/.exec(text);
    values.omittedDiagnostics = truncated ? Number(truncated[1]) : 0;
    if (files.size) values.fileRead = [...files.values()].reduce((a, b) => ({ reads: a.reads + b.reads, bytes: a.bytes + b.bytes, blobReads: a.blobReads + b.blobReads, blobBytes: a.blobBytes + b.blobBytes }), { reads: 0, bytes: 0, blobReads: 0, blobBytes: 0 });
    return { metrics: measurementSchema.parse(values), text };
  }
  return { append, snapshot };
}
export function medianMilliseconds({ values }: { values: number[] }): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
export const TEST_ONLY = {
};
