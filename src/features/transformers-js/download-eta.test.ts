import { expect, it } from 'vitest';
import { createDownloadEtaEstimator } from './download-eta';

it('keeps the first fetch origin across files and includes completed saving in the average', () => {
  const eta = createDownloadEtaEstimator({ now: () => 0 });
  eta.observe({ info: { status: 'saving', loaded: 100, downloadCumulativeTiming: { clockId: 'source', sequence: 1, firstFetchStartedAtMs: 1000, observedAtMs: 3000, receivedBytes: 100 } } });
  eta.observe({ info: { status: 'download', loaded: 0, downloadCumulativeTiming: { clockId: 'source', sequence: 2, firstFetchStartedAtMs: 1000, observedAtMs: 5000, receivedBytes: 100 } } });
  eta.observe({ info: { status: 'progress', loaded: 50, downloadCumulativeTiming: { clockId: 'source', sequence: 3, firstFetchStartedAtMs: 1000, observedAtMs: 6000, receivedBytes: 150 } } });
  expect(eta.snapshot({ remainingBytes: 450, active: true })).toEqual({ status: 'estimating', remainingSeconds: 15, bytesPerSecond: 30 });
});

it('recovers from stale delivery without resetting the wall-time average', () => {
  let now = 0;
  const eta = createDownloadEtaEstimator({ now: () => now });
  eta.observe({ info: { status: 'progress', loaded: 100, downloadCumulativeTiming: { clockId: 'source', sequence: 1, firstFetchStartedAtMs: 0, observedAtMs: 4000, receivedBytes: 100 } } });
  expect(eta.snapshot({ remainingBytes: 100, active: true })).toMatchObject({ remainingSeconds: 4 });
  now = 11000;
  expect(eta.snapshot({ remainingBytes: 100, active: true })).toEqual({ status: 'stalled' });
  eta.observe({ info: { status: 'progress', loaded: 200, downloadCumulativeTiming: { clockId: 'source', sequence: 2, firstFetchStartedAtMs: 0, observedAtMs: 104000, receivedBytes: 200 } } });
  expect(eta.snapshot({ remainingBytes: 200, active: true })).toEqual({ status: 'estimating', remainingSeconds: 104, bytesPerSecond: 200 / 104 });
});

it('does not claim an ETA warmup when no source clock can be observed', () => {
  const eta = createDownloadEtaEstimator({ now: () => 0 });
  eta.observe({ info: { status: 'progress', loaded: 300, total: 600 } });
  expect(eta.snapshot({ remainingBytes: 300, active: true })).toEqual({ status: 'unavailable' });
});

it('keeps source clock failure unavailable until a new candidate owns a fresh estimator', () => {
  const eta = createDownloadEtaEstimator({ now: () => 0 });
  eta.observe({ info: { status: 'download', loaded: 0, downloadCumulativeTiming: { clockId: 'source', sequence: 1, firstFetchStartedAtMs: 0, observedAtMs: 0, receivedBytes: 0 } } });
  eta.observe({ info: { status: 'progress', loaded: 300, downloadCumulativeTiming: { clockId: 'source', sequence: 2, firstFetchStartedAtMs: 0, observedAtMs: 3000, receivedBytes: 300 } } });
  expect(eta.snapshot({ remainingBytes: 300, active: true }).status).toBe('estimating');
  eta.observe({ info: { status: 'metadata', loaded: 900 } });
  expect(eta.snapshot({ remainingBytes: 300, active: true }).status).toBe('estimating');
  eta.observe({ info: { status: 'progress', loaded: 301, downloadCumulativeTiming: 'unavailable' } });
  expect(eta.snapshot({ remainingBytes: 299, active: true })).toEqual({ status: 'unavailable' });
  eta.observe({ info: { status: 'progress', loaded: 400, downloadCumulativeTiming: { clockId: 'source', sequence: 3, firstFetchStartedAtMs: 0, observedAtMs: 4000, receivedBytes: 400 } } });
  expect(eta.snapshot({ remainingBytes: 200, active: true })).toEqual({ status: 'unavailable' });
});

it('uses source elapsed time rather than delivery time and initializes after three seconds', () => {
  let now = 100;
  const eta = createDownloadEtaEstimator({ now: () => now });
  eta.observe({ info: { status: 'download', loaded: 0, downloadCumulativeTiming: { clockId: 'worker', sequence: 1, firstFetchStartedAtMs: 20000, observedAtMs: 20000, receivedBytes: 0 } } });
  now = 150;
  eta.observe({ info: { status: 'progress', loaded: 300, downloadCumulativeTiming: { clockId: 'worker', sequence: 2, firstFetchStartedAtMs: 20000, observedAtMs: 23000, receivedBytes: 300 } } });
  expect(eta.snapshot({ remainingBytes: 200, active: true })).toEqual({ status: 'estimating', remainingSeconds: 2, bytesPerSecond: 100 });
  expect(eta.snapshot({ remainingBytes: undefined, active: true })).toEqual({ status: 'unavailable' });
  expect(eta.snapshot({ remainingBytes: 200, active: false })).toEqual({ status: 'unavailable' });
});

it('invalidates stale delivery without counting down and retains the original start after a long gap', () => {
  let now = 0;
  const eta = createDownloadEtaEstimator({ now: () => now });
  eta.observe({ info: { status: 'download', loaded: 0, downloadCumulativeTiming: { clockId: 'worker', sequence: 1, firstFetchStartedAtMs: 0, observedAtMs: 0, receivedBytes: 0 } } });
  now = 3000;
  eta.observe({ info: { status: 'progress', loaded: 300, downloadCumulativeTiming: { clockId: 'worker', sequence: 2, firstFetchStartedAtMs: 0, observedAtMs: 3000, receivedBytes: 300 } } });
  expect(eta.snapshot({ remainingBytes: 300, active: true })).toMatchObject({ remainingSeconds: 3 });
  now = 13000;
  expect(eta.snapshot({ remainingBytes: 300, active: true })).toEqual({ status: 'stalled' });
  now = 20000;
  eta.observe({ info: { status: 'progress', loaded: 400, downloadCumulativeTiming: { clockId: 'worker', sequence: 3, firstFetchStartedAtMs: 0, observedAtMs: 20000, receivedBytes: 400 } } });
  expect(eta.snapshot({ remainingBytes: 200, active: true })).toEqual({ status: 'estimating', remainingSeconds: 10, bytesPerSecond: 20 });
});

it('rejects stale sequence and never combines distinct source clocks', () => {
  const eta = createDownloadEtaEstimator({ now: () => 0 });
  eta.observe({ info: { status: 'download', loaded: 0, downloadCumulativeTiming: { clockId: 'first', sequence: 1, firstFetchStartedAtMs: 0, observedAtMs: 0, receivedBytes: 0 } } });
  eta.observe({ info: { status: 'progress', loaded: 300, downloadCumulativeTiming: { clockId: 'first', sequence: 2, firstFetchStartedAtMs: 0, observedAtMs: 3000, receivedBytes: 300 } } });
  eta.observe({ info: { status: 'progress', loaded: 9000, downloadCumulativeTiming: { clockId: 'first', sequence: 1, firstFetchStartedAtMs: 0, observedAtMs: 3001, receivedBytes: 9000 } } });
  expect(eta.snapshot({ remainingBytes: 300, active: true })).toMatchObject({ remainingSeconds: 3 });
  eta.observe({ info: { status: 'download', loaded: 0, downloadCumulativeTiming: { clockId: 'second', sequence: 1, firstFetchStartedAtMs: 999999, observedAtMs: 999999, receivedBytes: 0 } } });
  expect(eta.snapshot({ remainingBytes: 300, active: true })).toEqual({ status: 'unavailable' });
});

it.each([
  { name: 'changed start', next: { firstFetchStartedAtMs: 1 } },
  { name: 'decreasing bytes', next: { receivedBytes: 99 } },
  { name: 'decreasing source time', next: { observedAtMs: 3999 } },
  { name: 'unsafe bytes', next: { receivedBytes: Number.MAX_SAFE_INTEGER + 1 } },
  { name: 'expired duration', next: { observedAtMs: 7 * 24 * 60 * 60 * 1000 + 1 } },
])('invalidates $name without repairing the source clock from host time', ({ next }) => {
  const eta = createDownloadEtaEstimator({ now: () => 123 });
  const first = { clockId: 'source', sequence: 1, firstFetchStartedAtMs: 0, observedAtMs: 4000, receivedBytes: 100 };
  eta.observe({ info: { status: 'progress', downloadCumulativeTiming: first } });
  expect(eta.snapshot({ remainingBytes: 100, active: true })).toMatchObject({ remainingSeconds: 4 });
  eta.observe({ info: { status: 'progress', downloadCumulativeTiming: { ...first, sequence: 2, ...next } } });
  expect(eta.snapshot({ remainingBytes: 100, active: true })).toEqual({ status: 'unavailable' });
});

it('uses the cumulative origin even when every earlier sample was coalesced', () => {
  const eta = createDownloadEtaEstimator({ now: () => 999_999 });
  eta.observe({ info: { status: 'progress', loaded: 50, downloadCumulativeTiming: { clockId: 'source', sequence: 1000, firstFetchStartedAtMs: 20000, observedAtMs: 25000, receivedBytes: 150 } } });
  expect(eta.snapshot({ remainingBytes: 450, active: true })).toEqual({ status: 'estimating', remainingSeconds: 15, bytesPerSecond: 30 });
  expect(eta.matchesReceivedBytes({ bytes: 150 })).toBe(true);
  expect(eta.matchesReceivedBytes({ bytes: 50 })).toBe(false);
  expect(eta.snapshot({ remainingBytes: 0, active: true })).toEqual({ status: 'unavailable' });
});

it('does not let an unavailable host clock throw from the progress snapshot', () => {
  const eta = createDownloadEtaEstimator({ now: () => {
    throw new Error('Clock unavailable');
  } });
  eta.observe({ info: { status: 'progress', downloadCumulativeTiming: { clockId: 'source', sequence: 1, firstFetchStartedAtMs: 0, observedAtMs: 4000, receivedBytes: 100 } } });
  expect(eta.snapshot({ remainingBytes: 100, active: true })).toEqual({ status: 'unavailable' });
});
