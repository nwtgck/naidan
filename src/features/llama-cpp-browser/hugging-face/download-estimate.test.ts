import { describe, expect, it } from 'vitest';
import { advanceThroughputSample, remainingEstimate, startThroughputSample } from './download-estimate';
describe('download remaining time', () => {
  it('waits for observations and estimates remaining work rather than treating resumed bytes as throughput', () => {
    let sample = startThroughputSample({ now: 0 });
    expect(remainingEstimate({ sample, now: 0, remaining: 300, phase: 'transferring' })).toEqual({ status: 'estimating' });
    for (let second = 1; second <= 3; second++) sample = advanceThroughputSample({ sample, now: second * 1000, processed: second * 100 });
    expect(remainingEstimate({ sample, now: 3000, remaining: 900, phase: 'transferring' })).toEqual({ status: 'remaining', seconds: 9 });
    expect(remainingEstimate({ sample, now: 3000, remaining: 0, phase: 'verifying' })).toEqual({ status: 'verifying' });
  });
  it('weights smoothing by elapsed time and retains history across file transitions', () => {
    const initial = advanceThroughputSample({ sample: startThroughputSample({ now: 0 }), now: 1000, processed: 100 });
    let frequent = initial;
    for (let second = 2; second <= 11; second++) frequent = advanceThroughputSample({ sample: frequent, now: second * 1000, processed: 100 + (second - 1) * 200 });
    const grouped = advanceThroughputSample({ sample: initial, now: 11000, processed: 2100 });
    expect(frequent.bytesPerSecond).toBeCloseTo(grouped.bytesPerSecond!);
    expect(grouped.bytesPerSecond).toBeCloseTo(100 + (1 - Math.exp(-1)) * 100);
  });
  it('withdraws stale estimates during a stall and preserves the current baseline on reset', () => {
    const sample = advanceThroughputSample({ sample: startThroughputSample({ now: 0 }), now: 3000, processed: 300 });
    expect(remainingEstimate({ sample, now: 13000, remaining: 900, phase: 'transferring' })).toEqual({ status: 'estimating' });
    const reset = advanceThroughputSample({ sample, now: 14000, processed: 50 });
    expect(reset.processed).toBe(50);
    expect(advanceThroughputSample({ sample: reset, now: 15000, processed: 150 }).bytesPerSecond).toBe(100);
  });
});
