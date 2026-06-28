import { describe, expect, it } from 'vitest';
import {
  makeFakeLmThinkingSentenceCount,
  normalizeFakeLmThinkingEffort,
} from '@/features/fake-lm/core/thinking';
import { createSeededNonCryptoPseudoRandom } from '@/features/fake-lm/core/random';

describe('normalizeFakeLmThinkingEffort', () => {
  it('normalizes common API thinking values', () => {
    expect(normalizeFakeLmThinkingEffort({ value: undefined })).toBe('off');
    expect(normalizeFakeLmThinkingEffort({ value: false })).toBe('off');
    expect(normalizeFakeLmThinkingEffort({ value: true })).toBe('medium');
    expect(normalizeFakeLmThinkingEffort({ value: 'none' })).toBe('off');
    expect(normalizeFakeLmThinkingEffort({ value: 'low' })).toBe('low');
    expect(normalizeFakeLmThinkingEffort({ value: 'med' })).toBe('medium');
    expect(normalizeFakeLmThinkingEffort({ value: 'medium' })).toBe('medium');
    expect(normalizeFakeLmThinkingEffort({ value: 'high' })).toBe('high');
    expect(normalizeFakeLmThinkingEffort({ value: 'xhigh' })).toBe('high');
    expect(normalizeFakeLmThinkingEffort({ value: { effort: 'low' } })).toBe('low');
  });
});

describe('makeFakeLmThinkingSentenceCount', () => {
  it('uses the requested effort ranges', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const random = createSeededNonCryptoPseudoRandom({ seed });

      expect(makeFakeLmThinkingSentenceCount({ effort: 'off', random })).toBe(0);
    }

    for (let seed = 1; seed <= 20; seed += 1) {
      const low = makeFakeLmThinkingSentenceCount({
        effort: 'low',
        random: createSeededNonCryptoPseudoRandom({ seed }),
      });
      const medium = makeFakeLmThinkingSentenceCount({
        effort: 'medium',
        random: createSeededNonCryptoPseudoRandom({ seed }),
      });
      const high = makeFakeLmThinkingSentenceCount({
        effort: 'high',
        random: createSeededNonCryptoPseudoRandom({ seed }),
      });

      expect(low).toBeGreaterThanOrEqual(6);
      expect(low).toBeLessThanOrEqual(9);
      expect(medium).toBeGreaterThanOrEqual(16);
      expect(medium).toBeLessThanOrEqual(24);
      expect(high).toBeGreaterThanOrEqual(96);
      expect(high).toBeLessThanOrEqual(160);
    }
  });
});
