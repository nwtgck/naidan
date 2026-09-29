// @vitest-environment node
import { expect, it } from 'vitest';
import { createBenchmarkMeasurements, medianMilliseconds } from './measurements';
import { metricFixture } from './test-fixtures';
it('reads the actual perfVersion=1 metrics; unknown/missing fields are not fabricated as zero', () => {
  const measure = createBenchmarkMeasurements(); expect(measure.snapshot().metrics.runWall).toBeUndefined(); expect(measure.snapshot().metrics.fileRead).toBeUndefined();
  measure.append({ diagnostic: metricFixture({ metric: 'run-wall', fields: { sampling: 158, milliseconds: 170 } }) });
  measure.append({ diagnostic: metricFixture({ metric: 'worker-selection', fields: { reusedWorker: true, reason: 'same' } }) });
  const snapshot = measure.snapshot(); expect(snapshot.metrics.runWall?.sampling).toBe(158); expect(snapshot.metrics.reuse?.reusedWorker).toBe(true);
});
it('deduplicates file summaries and step reports, and excludes legacy cumulative reads', () => {
  const measure = createBenchmarkMeasurements();
  for (let i = 0; i < 3; i++) {
    measure.append({ diagnostic: metricFixture({ metric: 'file-read-run', fields: { slot: 'model', path: 'file', reads: 2, bytes: 42, blobReads: 1, blobBytes: 42 } }) });
    measure.append({ diagnostic: metricFixture({ metric: 'step-wall', fields: { step: 1, milliseconds: 30 } }) });
  }
  measure.append({ diagnostic: { event: 'file-read', stage: 'model-load', elapsedMs: 1, fields: { reads: 5000, bytes: 99999, path: 'file' } } });
  expect(measure.snapshot().metrics.fileRead).toEqual({ reads: 2, bytes: 42, blobReads: 1, blobBytes: 42 });
  expect(measure.snapshot().metrics.steps).toEqual([{ step: 1, milliseconds: 30 }]);
});
it('retains measurements independently of the bounded raw-log buffer', () => {
  const measure = createBenchmarkMeasurements();
  for (let i = 0; i < 17; i++) measure.append({ diagnostic: metricFixture({ metric: 'ignore', fields: {} }) });
  measure.append({ diagnostic: metricFixture({ metric: 'run-wall', fields: { sampling: 150 } }) });
  for (let i = 0; i < 1800; i++) measure.append({ diagnostic: metricFixture({ metric: 'ignore', fields: { index: i, text: 'x'.repeat(500) } }) });
  const snap = measure.snapshot(); expect(snap.metrics.runWall?.sampling).toBe(150); expect(snap.metrics.omittedDiagnostics).toBeGreaterThan(0);
  expect(snap.text).not.toContain('"metric":"run-wall"'); expect(snap.text.length).toBeLessThan(400 * 1024);
});
it('computes an honest median and leaves empty groups unknown', () => {
  expect(medianMilliseconds({ values: [] })).toBeUndefined(); expect(medianMilliseconds({ values: [4,1,6] })).toBe(4); expect(medianMilliseconds({ values: [1,4] })).toBe(2.5);
});
