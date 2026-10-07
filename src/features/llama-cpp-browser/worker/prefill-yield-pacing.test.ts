import { describe, expect, it } from 'vitest';
import { createPrefillYieldPacing } from './prefill-yield-pacing';

describe('prefill yield pacing', () => {
  it('coalesces fast 128-token batches up to the token budget', () => {
    const time = 0;
    const pacing = createPrefillYieldPacing({ now: () => time });
    for (let index = 0; index < 7; index++) expect(pacing.shouldYield({ decodedTokens: 128 })).toBe(false);
    expect(pacing.shouldYield({ decodedTokens: 128 })).toBe(true);
    pacing.yielded();
    expect(pacing.shouldYield({ decodedTokens: 128 })).toBe(false);
  });

  it('yields after a slow batch regardless of token count', () => {
    let time = 10;
    const pacing = createPrefillYieldPacing({ now: () => time });
    time = 27;
    expect(pacing.shouldYield({ decodedTokens: 1 })).toBe(true);
  });

  it('restarts the elapsed and token budgets after yielding', () => {
    let time = 0;
    const pacing = createPrefillYieldPacing({ now: () => time, maximumElapsedMs: 10, maximumTokens: 4 });
    expect(pacing.shouldYield({ decodedTokens: 4 })).toBe(true);
    time = 5; pacing.yielded();
    time = 14; expect(pacing.shouldYield({ decodedTokens: 1 })).toBe(false);
    time = 15; expect(pacing.shouldYield({ decodedTokens: 1 })).toBe(true);
  });

  it.each([NaN, Infinity, -1])('fails open for an unusable elapsed clock %s', value => {
    let call = 0;
    const pacing = createPrefillYieldPacing({ now: () => call++ === 0 ? 1 : value });
    expect(pacing.shouldYield({ decodedTokens: 1 })).toBe(true);
  });
});
