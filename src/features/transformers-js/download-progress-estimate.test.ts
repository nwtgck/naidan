import { expect, it } from 'vitest';
import { createDownloadProgressTracker } from './download-progress';

it('does not reserve work for unattempted fallback candidates', () => {
  const single = createDownloadProgressTracker();
  const multiple = createDownloadProgressTracker();
  single.observe({ event: { kind: 'candidate', candidate: { device: 'wasm', dtype: 'q4' }, index: 0, count: 1 } });
  multiple.observe({ event: { kind: 'candidate', candidate: { device: 'wasm', dtype: 'q4' }, index: 0, count: 3 } });
  single.observe({ event: { kind: 'plan', index: 0, paths: ['a', 'b'] } });
  multiple.observe({ event: { kind: 'plan', index: 0, paths: ['a', 'b'] } });
  single.observe({ event: { kind: 'file', index: 0, info: { status: 'done', file: 'a', loaded: 100, total: 100 } } });
  multiple.observe({ event: { kind: 'file', index: 0, info: { status: 'done', file: 'a', loaded: 100, total: 100 } } });
  expect(single.snapshot().overallProgress).toBeUndefined();
  expect(multiple.snapshot().overallProgress).toBeUndefined();
  expect(single.snapshot().receivedBytes).toBe(100);
  expect(multiple.snapshot().files).toEqual(single.snapshot().files);
});

it('keeps preparation within five points and enters final confirmation at ninety-five', () => {
  const tracker = createDownloadProgressTracker();
  tracker.observe({ event: { kind: 'metadata', stage: 'complete' } });
  expect(tracker.snapshot().overallProgress).toBe(5);
  tracker.observe({ event: { kind: 'candidate', candidate: { device: 'wasm', dtype: 'q4' }, index: 0, count: 3 } });
  tracker.observe({ event: { kind: 'plan', index: 0, paths: ['a'] } });
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'done', file: 'a', loaded: 100, total: 100 } } });
  tracker.observe({ event: { kind: 'acceptance', index: 0 } });
  expect(tracker.snapshot().overallProgress).toBe(95);
  tracker.observe({ event: { kind: 'phase', phase: 'complete' } });
  expect(tracker.snapshot().overallProgress).toBe(100);
});

it('computes current candidate satisfaction without double counting cache or saving copies', () => {
  const tracker = createDownloadProgressTracker();
  tracker.observe({ event: { kind: 'candidate', candidate: { device: 'wasm', dtype: 'q4' }, index: 0, count: 3 } });
  tracker.observe({ event: { kind: 'plan', index: 0, paths: ['a', 'b'] } });
  tracker.observe({ event: { kind: 'sizes', index: 0, sizes: [{ path: 'a', bytes: 100 }, { path: 'b', bytes: 100 }] } });
  expect(tracker.snapshot().overallProgress).toBe(5);
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'cached', file: 'a', loaded: 100, total: 100 } } });
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'progress', file: 'b', loaded: 50 } } });
  expect(tracker.snapshot()).toMatchObject({ overallProgress: 72, receivedBytes: 50, cachedBytes: 100 });
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'saving', file: 'b', loaded: 100 } } });
  expect(tracker.snapshot()).toMatchObject({ overallProgress: 94, phase: 'saving', receivedBytes: 100 });
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'done', file: 'b', loaded: 100, total: 100 } } });
  expect(tracker.snapshot().overallProgress).toBe(94);
  tracker.observe({ event: { kind: 'prefetch-complete', index: 0 } });
  expect(tracker.snapshot().overallProgress).toBe(95);
});

it('retains correction reasons across snapshots and does not pin a wrong high water mark', () => {
  const tracker = createDownloadProgressTracker();
  tracker.observe({ event: { kind: 'candidate', candidate: { device: 'wasm', dtype: 'q4' }, index: 0, count: 1 } });
  tracker.observe({ event: { kind: 'plan', index: 0, paths: ['a', 'b'] } });
  tracker.observe({ event: { kind: 'sizes', index: 0, sizes: [{ path: 'a', bytes: 100 }, { path: 'b', bytes: 100 }] } });
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'progress', file: 'a', loaded: 90 } } });
  expect(tracker.snapshot()).toMatchObject({ overallProgress: 45, estimateGeneration: 0, revisionReason: undefined });
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'done', file: 'a', loaded: 1000, total: 1000 } } });
  expect(tracker.snapshot()).toMatchObject({ overallProgress: 86, estimateGeneration: 1, revisionReason: 'size-updated' });
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'progress', file: 'b', loaded: 101 } } });
  expect(tracker.snapshot()).toMatchObject({ overallProgress: undefined, estimateGeneration: 2, revisionReason: 'size-conflict', receivedBytes: 1101 });
});

it('does not use an unverified HTTP total or unsafe aggregate for a percentage', () => {
  const tracker = createDownloadProgressTracker();
  tracker.observe({ event: { kind: 'candidate', candidate: { device: 'wasm', dtype: 'q4' }, index: 0, count: 1 } });
  tracker.observe({ event: { kind: 'plan', index: 0, paths: ['a', 'b'] } });
  tracker.observe({ event: { kind: 'file', index: 0, info: { status: 'progress', file: 'a', loaded: 20, total: 10, downloadTotalKind: 'unverified-http' } } });
  expect(tracker.snapshot().files[0]?.progress).toBeUndefined();
  tracker.observe({ event: { kind: 'sizes', index: 0, sizes: [{ path: 'a', bytes: Number.MAX_SAFE_INTEGER }, { path: 'b', bytes: Number.MAX_SAFE_INTEGER }] } });
  expect(tracker.snapshot()).toMatchObject({ overallProgress: undefined, knownTotalBytes: 0, downloadEta: { status: 'unavailable' } });
});
