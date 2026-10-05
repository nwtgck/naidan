import { describe, expect, it, vi } from 'vitest';
import { createOutputPacing } from './output-pacing';

describe('bounded synchronous output pacing', () => {
  it('preserves per-token parsing without clock reads for excluded inputs', () => {
    const now = vi.fn(() => 0);
    const pacing = createOutputPacing({ mode: 'per-token', now });
    for (let i = 0; i < 100; i++) {
      expect(pacing.shouldParse({ outputLength: 0, force: false })).toBe(true);
      pacing.parsed({ outputLength: 0 }); pacing.delivered();
    }
    expect(now).not.toHaveBeenCalled();
  });
  it('parses each changed prefix until an event has actually been delivered', () => {
    const pacing = createOutputPacing({ mode: 'coalesced', now: () => 0 });
    for (let i = 0; i < 50; i++) {
      expect(pacing.shouldParse({ outputLength: i, force: false })).toBe(true);
      pacing.parsed({ outputLength: i });
    }
    pacing.delivered();
    expect(pacing.shouldParse({ outputLength: 50, force: false })).toBe(false);
  });
  it('does not reparse unchanged held bytes, but forces a stop boundary', () => {
    const pacing = createOutputPacing({ mode: 'coalesced', now: () => 1000 });
    pacing.parsed({ outputLength: 0 });
    for (let i = 0; i < 100; i++) expect(pacing.shouldParse({ outputLength: 0, force: false })).toBe(false);
    expect(pacing.shouldParse({ outputLength: 0, force: true })).toBe(true);
    // Even after many empty fragments, the first exposed text is not delayed.
    expect(pacing.shouldParse({ outputLength: 1, force: false })).toBe(true);
  });
  it('flushes on the eighth token even if the clock never advances', () => {
    const pacing = createOutputPacing({ mode: 'coalesced', now: () => 0 });
    pacing.parsed({ outputLength: 1 }); pacing.delivered();
    for (let i = 1; i < 8; i++) expect(pacing.shouldParse({ outputLength: 1 + i, force: false })).toBe(false);
    expect(pacing.shouldParse({ outputLength: 9, force: false })).toBe(true);
    pacing.parsed({ outputLength: 9 });
    expect(pacing.shouldParse({ outputLength: 10, force: false })).toBe(false);
  });
  it('flushes at the elapsed boundary measured before a slow acknowledgement', () => {
    let at = 100;
    const pacing = createOutputPacing({ mode: 'coalesced', now: () => at });
    pacing.parsed({ outputLength: 1 });
    at = 131; pacing.delivered();
    expect(pacing.shouldParse({ outputLength: 2, force: false })).toBe(false);
    at = 132;
    expect(pacing.shouldParse({ outputLength: 3, force: false })).toBe(true);
    pacing.parsed({ outputLength: 3 });
    at = 200; pacing.delivered();
    expect(pacing.shouldParse({ outputLength: 4, force: false })).toBe(true);
  });
  it('flushes at the character budget independently of token count and time', () => {
    const pacing = createOutputPacing({ mode: 'coalesced', now: () => 0 });
    pacing.parsed({ outputLength: 20 }); pacing.delivered();
    expect(pacing.shouldParse({ outputLength: 4115, force: false })).toBe(false);
    expect(pacing.shouldParse({ outputLength: 4116, force: false })).toBe(true);
  });
  it.each([true, false])('forces final boundaries before any deferred work, delivered=%s', delivered => {
    const pacing = createOutputPacing({ mode: 'coalesced', now: () => 0 });
    pacing.parsed({ outputLength: 20 });
    if (delivered) pacing.delivered();
    expect(pacing.shouldParse({ outputLength: 20, force: true })).toBe(true);
  });
  it.each([-1, Infinity, NaN])('does not hold output for an invalid clock result %s', at => {
    let time = 0;
    const pacing = createOutputPacing({ mode: 'coalesced', now: () => time });
    pacing.parsed({ outputLength: 1 }); pacing.delivered(); time = at;
    expect(pacing.shouldParse({ outputLength: 2, force: false })).toBe(true);
  });
  it('lets the caller check a shortened snapshot instead of masking revisions', () => {
    const pacing = createOutputPacing({ mode: 'coalesced', now: () => 0 });
    pacing.parsed({ outputLength: 10 }); pacing.delivered();
    expect(pacing.shouldParse({ outputLength: 9, force: false })).toBe(true);
  });
  it('keeps independent request state and flushes slowly generated tokens immediately', () => {
    let at = 0;
    const first = createOutputPacing({ mode: 'coalesced', now: () => at });
    first.parsed({ outputLength: 1 }); first.delivered();
    const second = createOutputPacing({ mode: 'coalesced', now: () => at });
    expect(second.shouldParse({ outputLength: 1, force: false })).toBe(true);
    for (let i = 2; i < 100; i++) {
      at += 40;
      expect(first.shouldParse({ outputLength: i, force: false })).toBe(true);
      first.parsed({ outputLength: i }); first.delivered();
    }
  });
  it('reduces full-prefix work while bounding the fast-stream backlog', () => {
    const pacing = createOutputPacing({ mode: 'coalesced', now: () => 0 });
    let calls = 0; let visitedCharacters = 0; let lastParsed = 0;
    for (let length = 1; length <= 1000; length++) {
      if (pacing.shouldParse({ outputLength: length, force: length === 1000 })) {
        pacing.parsed({ outputLength: length }); pacing.delivered();
        lastParsed = length; calls++; visitedCharacters += length;
      }
      expect(length - lastParsed).toBeLessThan(8);
    }
    expect(calls).toBe(126);
    expect(visitedCharacters).toBe(63125);
    // This is a deterministic work-count test, not a runtime benchmark.
    expect(visitedCharacters).toBeLessThan((1000 * 1001 / 2) / 7);
  });
});
