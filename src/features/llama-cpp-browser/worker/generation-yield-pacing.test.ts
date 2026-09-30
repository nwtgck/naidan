import { describe, expect, it, vi } from 'vitest';
import { createGenerationYieldPacing } from './generation-yield-pacing';

describe('bounded generation task yields', () => {
  it('always yields after the first decode, then after at most four fast decodes', () => {
    const pacing = createGenerationYieldPacing({ mode: 'coalesced', now: () => 0 });
    expect(pacing.shouldYield()).toBe(true);
    pacing.yielded();
    for (let i = 0; i < 3; i++) expect(pacing.shouldYield()).toBe(false);
    expect(pacing.shouldYield()).toBe(true);
    pacing.yielded();
    expect(pacing.counters).toEqual({ mode: 'coalesced', checks: 5, requestedYields: 2,
      completedYields: 2, coalescedYields: 3, maximumDecodesBetweenYields: 4 });
  });
  it('checks elapsed time at each decode boundary, including parsing and delivery time', () => {
    let at = 0;
    const pacing = createGenerationYieldPacing({ mode: 'coalesced', now: () => at });
    expect(pacing.shouldYield()).toBe(true); pacing.yielded();
    at = 7.99; expect(pacing.shouldYield()).toBe(false);
    at = 8; expect(pacing.shouldYield()).toBe(true); pacing.yielded();
    at = 100; expect(pacing.shouldYield()).toBe(true); pacing.yielded();
    expect(pacing.counters.maximumDecodesBetweenYields).toBe(2);
  });
  it('starts a fresh budget when the real task yield completes rather than when scheduled', () => {
    let at = 0;
    const pacing = createGenerationYieldPacing({ mode: 'coalesced', now: () => at });
    expect(pacing.shouldYield()).toBe(true);
    expect(pacing.counters.completedYields).toBe(0);
    at = 500; pacing.yielded();
    at = 507; expect(pacing.shouldYield()).toBe(false);
    at = 508; expect(pacing.shouldYield()).toBe(true);
  });
  it.each([NaN, Infinity, -Infinity, -1])('yields on unusable clock value %s and can recover', invalid => {
    let at = 0;
    const pacing = createGenerationYieldPacing({ mode: 'coalesced', now: () => at });
    expect(pacing.shouldYield()).toBe(true); pacing.yielded();
    at = invalid; expect(pacing.shouldYield()).toBe(true);
    at = 100; pacing.yielded();
    expect(pacing.shouldYield()).toBe(false);
  });
  it('also detects a backwards clock that has not crossed the last yield time', () => {
    let at = 0;
    const pacing = createGenerationYieldPacing({ mode: 'coalesced', now: () => at });
    expect(pacing.shouldYield()).toBe(true); pacing.yielded();
    at = 5; expect(pacing.shouldYield()).toBe(false);
    at = 4; expect(pacing.shouldYield()).toBe(true);
  });
  it('recovers from an invalid clock at initialization or completion', () => {
    let at = NaN;
    const pacing = createGenerationYieldPacing({ mode: 'coalesced', now: () => at });
    expect(pacing.shouldYield()).toBe(true); pacing.yielded();
    at = 0; expect(pacing.shouldYield()).toBe(true); pacing.yielded();
    expect(pacing.shouldYield()).toBe(false);
  });
  it('does not replace the per-token path or read a clock for it', () => {
    const now = vi.fn(() => 0);
    const pacing = createGenerationYieldPacing({ mode: 'per-token', now });
    for (let i = 0; i < 20; i++) {
      expect(pacing.shouldYield()).toBe(true); pacing.yielded();
    }
    expect(now).not.toHaveBeenCalled();
    expect(pacing.counters).toEqual({ mode: 'per-token', checks: 20, requestedYields: 20,
      completedYields: 20, coalescedYields: 0, maximumDecodesBetweenYields: 1 });
  });
  it('never lets a caller replace a pending real task with another decode', () => {
    const pacing = createGenerationYieldPacing({ mode: 'coalesced', now: () => 0 });
    expect(() => pacing.yielded()).toThrow('No generation yield');
    expect(pacing.shouldYield()).toBe(true);
    expect(() => pacing.shouldYield()).toThrow('Complete the requested');
    expect(pacing.counters.checks).toBe(1);
    pacing.yielded();
    expect(() => pacing.yielded()).toThrow('No generation yield');
  });
  it('bounds fast or coarse-clock runs without retaining per-token events', () => {
    const pacing = createGenerationYieldPacing({ mode: 'coalesced', now: () => 0 });
    for (let i = 0; i < 10001; i++) if (pacing.shouldYield()) pacing.yielded();
    expect(pacing.counters.requestedYields).toBe(2501);
    expect(pacing.counters.completedYields).toBe(2501);
    expect(pacing.counters.maximumDecodesBetweenYields).toBe(4);
    expect(JSON.stringify(pacing.counters).length).toBeLessThan(250);
    const next = createGenerationYieldPacing({ mode: 'coalesced', now: () => 0 });
    expect(next.shouldYield()).toBe(true);
    expect(next.counters.checks).toBe(1);
  });
  it('rejects unknown modes instead of silently dropping cooperation', () => {
    expect(() => createGenerationYieldPacing({ mode: 'unexpected' as 'coalesced', now: () => 0 })).toThrow('Unknown generation pacing');
  });
});
