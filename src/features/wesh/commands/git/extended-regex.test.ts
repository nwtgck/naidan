import { describe, expect, it } from 'vitest';
import { compileGitExtendedRegex, testGitExtendedRegex, testGitExtendedRegexBytes } from './extended-regex';

function matches({ pattern, value }: { pattern: string, value: string }): boolean {
  return testGitExtendedRegex({ regex: compileGitExtendedRegex({ pattern }), value });
}

describe('Git extended regular expressions', () => {
  it('uses ERE operators and treats their escaped forms literally', () => {
    expect(matches({ pattern: 'a+b', value: 'aaab' })).toBe(true);
    expect(matches({ pattern: 'a\\+b', value: 'a+b' })).toBe(true);
    expect(matches({ pattern: '(a|b)+', value: 'abba' })).toBe(true);
    expect(matches({ pattern: 'a\\|b', value: 'a|b' })).toBe(true);
  });

  it('supports POSIX classes and C-locale UTF-8 byte matching', () => {
    expect(matches({ pattern: '[[:digit:]]+', value: 'a12b' })).toBe(true);
    expect(matches({ pattern: '^.$', value: 'é' })).toBe(false);
    expect(matches({ pattern: '^..$', value: 'é' })).toBe(true);
  });

  it('supports GNU ERE intervals and normalizes repeated repetition operators', () => {
    expect(matches({ pattern: 'a{,2}b', value: 'aab' })).toBe(true);
    expect(compileGitExtendedRegex({ pattern: 'a++' }).byteRegex.source).toBe('a+');
    expect(compileGitExtendedRegex({ pattern: 'a+?' }).byteRegex.source).toBe('a*');
    expect(() => compileGitExtendedRegex({ pattern: 'a{32768}' })).toThrow('interval is too large');
  });

  it('supports GNU word escapes and backreferences', () => {
    expect(matches({ pattern: '\\bcat\\b', value: 'a cat b' })).toBe(true);
    expect(matches({ pattern: '(a)\\1', value: 'aa' })).toBe(true);
  });

  it('matches raw bytes without replacing invalid UTF-8', () => {
    const regex = compileGitExtendedRegex({ pattern: '^.$' });
    expect(testGitExtendedRegexBytes({ regex, bytes: new Uint8Array([0xFF]) })).toBe(true);
    expect(testGitExtendedRegexBytes({ regex, bytes: new Uint8Array([0xC3, 0xA9]) })).toBe(false);
  });
});
