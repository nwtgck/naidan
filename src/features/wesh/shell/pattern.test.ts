import { describe, expect, it } from 'vitest';
import { containsShellPatternMeta, matchesShellPattern } from './pattern';

describe('containsShellPatternMeta', () => {
  it('treats only complete bracket expressions as pathname-expansion metadata', () => {
    for (const pattern of ['[', '[a', '[!', '[a-', 'foo[', 'foo[a']) {
      expect(containsShellPatternMeta({
        pattern,
        extglob: 'disabled',
      })).toBe(false);
    }

    for (const pattern of ['[a]', '[!a]', '[a-z]', '[[:digit:]]', '[[:digit:]', 'foo[a]']) {
      expect(containsShellPatternMeta({
        pattern,
        extglob: 'disabled',
      })).toBe(true);
    }
  });
});


describe('matchesShellPattern', () => {
  it('matches single-character equivalence classes and collating symbols', () => {
    for (const [pattern, text] of [
      ['[[=a=]]', 'a'],
      ['[[=A=]]', 'A'],
      ['[[===]]', '='],
      ['[[.a.]]', 'a'],
      ['[[.-.]]', '-'],
      ['[[=é=]]', 'é'],
      ['[[.😀.]]', '😀'],
    ] as const) {
      expect(matchesShellPattern({ pattern, text })).toBe(true);
    }

    for (const pattern of ['[[=ab=]]', '[[.ab.]]'] as const) {
      expect(matchesShellPattern({ pattern, text: 'a' })).toBe(false);
      expect(matchesShellPattern({ pattern, text: 'b' })).toBe(false);
    }
  });
});
