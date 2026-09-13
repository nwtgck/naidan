import { expect, it } from 'vitest';
import { createDownloadProgressTracker, downloadResourcePath } from './download-progress';

it('publishes the complete current plan while totals are unknown and uses real file bytes independently of work progress', () => {
  const tracker = createDownloadProgressTracker();
  expect(tracker.snapshot().overallProgress).toBe(0);
  tracker.observe({ event: { kind: 'phase', phase: 'checking-cache' } });
  expect(tracker.snapshot().overallProgress).toBe(3);
  tracker.observe({ event: { kind: 'candidate', candidate: { device: 'webgpu', dtype: 'q4f16' }, index: 0, count: 3 } });
  tracker.observe({ event: { kind: 'plan', index: 0, paths: ['decoder/model.onnx', 'encoder/model.onnx'] } });
  expect(tracker.snapshot()).toMatchObject({ unknownTotalCount: 2, files: [
    { path: 'decoder/model.onnx', status: 'queued', progress: undefined },
    { path: 'encoder/model.onnx', status: 'queued', progress: undefined },
  ] });
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'progress', file: 'decoder/model.onnx', loaded: 25, total: 100 } } });
  const snapshot = tracker.snapshot();
  expect(snapshot.files[0]).toMatchObject({ loaded: 25, total: 100, progress: 25 });
  expect(snapshot.files[1]?.progress).toBeUndefined();
  expect(snapshot.overallProgress).toBeGreaterThan(10);
  expect(snapshot.overallProgress).toBeLessThan(25);
  expect(snapshot.receivedBytes).toBe(25);
});

it('advances unknown-size file work, preserves known totals on sparse samples, and does not mistake body completion for saved data', () => {
  const tracker = createDownloadProgressTracker();
  tracker.observe({ event: { kind: 'candidate', candidate: { device: 'wasm', dtype: 'q4' }, index: 0, count: 1 } });
  tracker.observe({ event: { kind: 'plan', index: 0, paths: ['a', 'b'] } });
  const initial = tracker.snapshot().overallProgress;
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'done', file: 'a', loaded: 10, total: 10 } } });
  const completed = tracker.snapshot().overallProgress;
  expect(completed).toBeGreaterThan(initial);
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'download', file: 'b', loaded: 0, total: 1000 } } });
  expect(tracker.snapshot().overallProgress).toBe(completed);
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'progress', file: 'b', loaded: 500 } } });
  expect(tracker.snapshot().files[1]).toMatchObject({ total: 1000, progress: 50 });
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'saving', file: 'b', loaded: 1000, total: 1000 } } });
  const saving = tracker.snapshot();
  expect(saving.files[1]).toMatchObject({ status: 'saving', progress: 100 });
  expect(saving.overallProgress).toBeLessThan(100);
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'progress', file: 'b', loaded: 900, total: 1000 } } });
  expect(tracker.snapshot()).toEqual(saving);
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'error', file: 'b' } } });
  expect(tracker.snapshot().files[1]?.status).toBe('failed');
});

it('reserves future candidate work instead of stranding a fallback at the previous acceptance percentage', () => {
  const tracker = createDownloadProgressTracker();
  tracker.observe({ event: { kind: 'candidate', candidate: { device: 'webgpu', dtype: 'q4f16' }, index: 0, count: 2 } });
  tracker.observe({ event: { kind: 'plan', index: 0, paths: ['old'] } });
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'done', file: 'old', loaded: 5, total: 5 } } });
  tracker.observe({ event: { kind: 'acceptance', index: 0 } });
  const rejected = tracker.snapshot().overallProgress;
  expect(rejected).toBeLessThan(50);
  tracker.observe({ event: { kind: 'candidate', candidate: { device: 'wasm', dtype: 'q4' }, index: 1, count: 2 } });
  tracker.observe({ event: { kind: 'plan', index: 1, paths: ['new'] } });
  const next = tracker.snapshot();
  expect(next.overallProgress).toBeGreaterThan(rejected);
  expect(next.overallProgress).toBeLessThan(70);
  expect(next.files.map(file => file.path)).toEqual(['new']);
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'done', file: 'new', loaded: 500, total: 500 } } });
  expect(tracker.snapshot()).toEqual(next);
  tracker.observe({ event: { kind: 'phase', phase: 'complete' } });
  expect(tracker.snapshot().overallProgress).toBe(100);
  const final = tracker.snapshot();
  tracker.observe({ event: { kind: 'phase', phase: 'failed' } });
  expect(tracker.snapshot()).toEqual(final);
});

it('distinguishes cached bytes, unknown size, zero length and contradictory size without manufacturing completion', () => {
  const tracker = createDownloadProgressTracker();
  tracker.observe({ event: { kind: 'candidate', candidate: { device: 'wasm', dtype: 'q4' }, index: 0, count: 1 } });
  tracker.observe({ event: { kind: 'plan', index: 0, paths: ['cache', 'unknown', 'zero', 'mismatch'] } });
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'cached', file: 'cache', loaded: 20, total: 20 } } });
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'progress', file: 'unknown', loaded: 7 } } });
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'done', file: 'zero', loaded: 0, total: 0 } } });
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'progress', file: 'mismatch', loaded: 12, total: 10 } } });
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'error', file: 'mismatch' } } });
  expect(tracker.snapshot()).toMatchObject({ cachedBytes: 20, receivedBytes: 19, files: [
    { status: 'cached', progress: 100 }, { progress: undefined, loaded: 7 },
    { status: 'queued', progress: undefined }, { status: 'failed', loaded: 12, total: 10, progress: 100 },
  ] });
});

it('uses the structural resolve segment and retains directories for duplicate basenames', () => {
  expect(downloadResourcePath({ url: 'https://huggingface.co/resolve/resolve/resolve/abc/decoder/model.onnx' })).toBe('decoder/model.onnx');
  expect(downloadResourcePath({ url: 'https://huggingface.co/org/resolve/resolve/abc/encoder/model.onnx' })).toBe('encoder/model.onnx');
  expect(downloadResourcePath({ url: 'https://huggingface.co/org/model/blob/main/model.onnx' })).toBeUndefined();
  expect(downloadResourcePath({ url: 'not a URL' })).toBeUndefined();
});
