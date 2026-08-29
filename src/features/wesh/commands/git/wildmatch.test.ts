import { describe, expect, it } from 'vitest';
import { compileGitWildmatch } from './wildmatch';

function compilePathspec({ pattern }: { pattern: string }) {
  return compileGitWildmatch({
    pattern,
    slashMode: 'wildcards-include-slash',
    anchorMode: 'full',
  });
}

describe('Git wildmatch translation', () => {
  it('supports POSIX character classes and their negation', () => {
    const digit = compilePathspec({ pattern: 'feat[[:digit:]]' });
    expect(digit.matches({ value: 'feat1' })).toBe(true);
    expect(digit.matches({ value: 'feata' })).toBe(false);

    const nonDigit = compilePathspec({ pattern: 'feat[![:digit:]]' });
    expect(nonDigit.matches({ value: 'feata' })).toBe(true);
    expect(nonDigit.matches({ value: 'feat1' })).toBe(false);
  });

  it('preserves Git bracket literals and ranges', () => {
    const cases: ReadonlyArray<{ pattern: string, matches: readonly string[], rejects: readonly string[] }> = [
      { pattern: 'feat[]a]', matches: ['feata', 'feat]'], rejects: ['feat1'] },
      { pattern: 'feat[-a]', matches: ['feat-', 'feata'], rejects: ['feat1'] },
      { pattern: 'feat[a-]', matches: ['feat-', 'feata'], rejects: ['feat1'] },
    ];
    for (const { pattern, matches, rejects } of cases) {
      const matcher = compilePathspec({ pattern });
      for (const value of matches) expect(matcher.matches({ value })).toBe(true);
      for (const value of rejects) expect(matcher.matches({ value })).toBe(false);
    }
  });

  it('matches Git descending ranges without creating invalid JavaScript regexes', () => {
    const matcher = compilePathspec({ pattern: 'feat[z-a]' });
    expect(matcher.matches({ value: 'featz' })).toBe(true);
    expect(matcher.matches({ value: 'feata' })).toBe(false);
    expect(matcher.matches({ value: 'featm' })).toBe(false);
  });

  it('matches UTF-8 path bytes rather than Unicode code points', () => {
    expect(compilePathspec({ pattern: 'caf?' }).matches({ value: 'café' })).toBe(false);
    expect(compilePathspec({ pattern: 'caf??' }).matches({ value: 'café' })).toBe(true);
    expect(compilePathspec({ pattern: 'caf???' }).matches({ value: 'cafあ' })).toBe(true);
    expect(compilePathspec({ pattern: 'caf[[:alpha:]]' }).matches({ value: 'café' })).toBe(false);
  });

  it('keeps slash excluded for pathname-aware bracket matches', () => {
    const matcher = compileGitWildmatch({
      pattern: '[!a]',
      slashMode: 'wildcards-exclude-slash',
      anchorMode: 'full',
    });
    expect(matcher.matches({ value: 'b' })).toBe(true);
    expect(matcher.matches({ value: '/' })).toBe(false);
  });
});
