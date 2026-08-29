import { describe, expect, it } from 'vitest';
import { compileGitBasicRegex, testGitBasicRegex } from './basic-regex';

function matches({ pattern, values }: { pattern: string, values: readonly string[] }): string[] {
  const regex = compileGitBasicRegex({ pattern });
  return values.filter(value => testGitBasicRegex({ regex, value }));
}

describe('Git basic regular expressions', () => {
  const values = [
    '', '+a', '-', '\\', 'a', 'aa', 'aaa', 'a+b', 'ab', 'aab', 'aaab', 'a{2}b', '123', 'abc', 'abab',
    'word', 'swordx', 'é', '😀',
  ];

  it('keeps unescaped extended-regex punctuation literal', () => {
    expect(matches({ pattern: '^a+b$', values })).toEqual(['a+b']);
    expect(matches({ pattern: '^a{2}b$', values })).toEqual(['a{2}b']);
  });

  it('supports escaped repetition, grouping, alternation, intervals, and backreferences', () => {
    expect(matches({ pattern: '^a\\+b$', values })).toEqual(['ab', 'aab', 'aaab']);
    expect(matches({ pattern: '^a\\{1,2\\}b$', values })).toEqual(['ab', 'aab']);
    expect(matches({ pattern: '^\\(ab\\)\\1$', values })).toEqual(['abab']);
    expect(matches({ pattern: '^word\\|abc$', values })).toEqual(['abc', 'word']);
  });

  it('translates POSIX character classes and GNU word boundaries', () => {
    expect(matches({ pattern: '^[[:digit:]]\\+$', values })).toEqual(['123']);
    expect(matches({ pattern: '^\\<word\\>$', values })).toEqual(['word']);
  });

  it('supports GNU BRE repetition edge semantics used by Git', () => {
    expect(matches({ pattern: '^\\+a$', values })).toEqual(['+a']);
    expect(matches({ pattern: '^a\\+\\+$', values })).toEqual(['a', 'aa', 'aaa']);
    expect(matches({ pattern: '^a\\+\\?$', values })).toEqual(['', 'a', 'aa', 'aaa']);
    expect(matches({ pattern: '^a\\{,2\\}$', values })).toEqual(['', 'a', 'aa']);
    expect(compileGitBasicRegex({ pattern: 'a\\+\\+' }).byteRegex.source).toBe('a+');
    expect(compileGitBasicRegex({ pattern: 'a\\+\\?' }).byteRegex.source).toBe('a*');
  });

  it('keeps backslash literal inside BRE bracket expressions', () => {
    expect(matches({ pattern: '^[\\-]$', values })).toEqual(['-', '\\']);
  });

  it('matches in the C-locale UTF-8 byte domain', () => {
    expect(matches({ pattern: '^.$', values })).not.toContain('é');
    expect(matches({ pattern: '^.$', values })).not.toContain('😀');
    expect(matches({ pattern: '^..$', values })).toContain('é');
    expect(matches({ pattern: '^..$', values })).not.toContain('😀');
  });

  it('rejects Git intervals larger than the C-locale regex engine limit', () => {
    expect(() => compileGitBasicRegex({ pattern: 'a\\{32768\\}' })).toThrow('interval is too large');
  });

  it('rejects unsupported alphabetic escapes rather than silently changing their meaning', () => {
    expect(() => compileGitBasicRegex({ pattern: '\\q' })).toThrow('unsupported BRE escape');
  });
});
