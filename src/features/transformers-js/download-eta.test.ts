import { expect, it } from 'vitest';
import { createDownloadEtaEstimator } from './download-eta';

it('does not claim an ETA warmup when no source clock can be observed', () => {
  const eta = createDownloadEtaEstimator({ now: () => 0 });
  eta.observe({ info: { status: 'progress', loaded: 300, total: 600 } });
  expect(eta.snapshot({ remainingBytes: 300, active: true })).toEqual({ status: 'unavailable' });
});

it('invalidates an existing estimate immediately on failed sampling and warms up on recovery', () => {
  const eta = createDownloadEtaEstimator({ now: () => 0 });
  eta.observe({ info: { status: 'download', loaded: 0, downloadTiming: { clockId: 'source', requestId: 1, sequence: 1, observedAtMs: 0 } } });
  eta.observe({ info: { status: 'progress', loaded: 300, downloadTiming: { clockId: 'source', requestId: 1, sequence: 2, observedAtMs: 3000 } } });
  expect(eta.snapshot({ remainingBytes: 300, active: true }).status).toBe('estimating');
  eta.observe({ info: { status: 'metadata', loaded: 900 } });
  expect(eta.snapshot({ remainingBytes: 300, active: true }).status).toBe('estimating');
  eta.observe({ info: { status: 'progress', loaded: 301, downloadTiming: 'unavailable' } });
  expect(eta.snapshot({ remainingBytes: 299, active: true })).toEqual({ status: 'unavailable' });
  eta.observe({ info: { status: 'progress', loaded: 400, downloadTiming: { clockId: 'source', requestId: 1, sequence: 3, observedAtMs: 4000 } } });
  expect(eta.snapshot({ remainingBytes: 200, active: true })).toEqual({ status: 'warming-up' });
});

it('uses source elapsed time rather than delivery time and initializes after three seconds', () => {
  let now = 100;
  const eta = createDownloadEtaEstimator({ now: () => now });
  eta.observe({ info: { status: 'download', loaded: 0, downloadTiming: { clockId: 'worker', requestId: 1, sequence: 1, observedAtMs: 20000 } } });
  now = 150;
  eta.observe({ info: { status: 'progress', loaded: 300, downloadTiming: { clockId: 'worker', requestId: 1, sequence: 2, observedAtMs: 23000 } } });
  expect(eta.snapshot({ remainingBytes: 200, active: true })).toEqual({ status: 'estimating', remainingSeconds: 2, bytesPerSecond: 100 });
  expect(eta.snapshot({ remainingBytes: undefined, active: true })).toEqual({ status: 'unavailable' });
  expect(eta.snapshot({ remainingBytes: 200, active: false })).toEqual({ status: 'unavailable' });
});

it('invalidates stale delivery without counting down and restarts sampling after a long gap', () => {
  let now = 0;
  const eta = createDownloadEtaEstimator({ now: () => now });
  eta.observe({ info: { status: 'download', loaded: 0, downloadTiming: { clockId: 'worker', requestId: 1, sequence: 1, observedAtMs: 0 } } });
  now = 3000;
  eta.observe({ info: { status: 'progress', loaded: 300, downloadTiming: { clockId: 'worker', requestId: 1, sequence: 2, observedAtMs: 3000 } } });
  expect(eta.snapshot({ remainingBytes: 300, active: true })).toMatchObject({ remainingSeconds: 3 });
  now = 13000;
  expect(eta.snapshot({ remainingBytes: 300, active: true })).toEqual({ status: 'stalled' });
  now = 20000;
  eta.observe({ info: { status: 'progress', loaded: 400, downloadTiming: { clockId: 'worker', requestId: 1, sequence: 3, observedAtMs: 20000 } } });
  expect(eta.snapshot({ remainingBytes: 200, active: true })).toEqual({ status: 'warming-up' });
});

it('rejects stale sequence and never combines clocks or resource requests', () => {
  const eta = createDownloadEtaEstimator({ now: () => 0 });
  eta.observe({ info: { status: 'download', loaded: 0, downloadTiming: { clockId: 'first', requestId: 1, sequence: 1, observedAtMs: 0 } } });
  eta.observe({ info: { status: 'progress', loaded: 300, downloadTiming: { clockId: 'first', requestId: 1, sequence: 2, observedAtMs: 3000 } } });
  eta.observe({ info: { status: 'progress', loaded: 9000, downloadTiming: { clockId: 'first', requestId: 1, sequence: 1, observedAtMs: 3001 } } });
  expect(eta.snapshot({ remainingBytes: 300, active: true })).toMatchObject({ remainingSeconds: 3 });
  eta.observe({ info: { status: 'download', loaded: 0, downloadTiming: { clockId: 'second', requestId: 1, sequence: 1, observedAtMs: 999999 } } });
  expect(eta.snapshot({ remainingBytes: 300, active: true })).toEqual({ status: 'warming-up' });
});
