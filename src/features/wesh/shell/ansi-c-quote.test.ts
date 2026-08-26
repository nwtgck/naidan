import { describe, expect, it } from 'vitest';
import { encodeShellTextToBytes } from './byte-text';
import { decodeShellAnsiCQuote } from './ansi-c-quote';

describe('decodeShellAnsiCQuote', () => {
  it('truncates the shell string at NUL-producing escapes like Bash', () => {
    expect(decodeShellAnsiCQuote({ text: String.raw`a\c@b` })).toBe('a');
    expect(decodeShellAnsiCQuote({ text: String.raw`a\000b` })).toBe('a');
    expect(decodeShellAnsiCQuote({ text: String.raw`a\x00b` })).toBe('a');
    expect(decodeShellAnsiCQuote({ text: String.raw`a\u0000b` })).toBe('a');
  });

  it('preserves backslash-newline inside ANSI-C quotes', () => {
    const text = ['a', '\\', '\n', 'b'].join('');
    expect(decodeShellAnsiCQuote({ text })).toBe(text);
  });

  it('preserves Bash legacy UTF-8 bytes for non-Unicode scalar escapes', () => {
    const cases = [
      { escape: String.raw`\uD800`, bytes: [0xed, 0xa0, 0x80] },
      { escape: String.raw`\U00110000`, bytes: [0xf4, 0x90, 0x80, 0x80] },
      { escape: String.raw`\U00200000`, bytes: [0xf8, 0x88, 0x80, 0x80, 0x80] },
      { escape: String.raw`\U04000000`, bytes: [0xfc, 0x84, 0x80, 0x80, 0x80, 0x80] },
    ] as const;
    for (const testCase of cases) {
      const decoded = decodeShellAnsiCQuote({ text: testCase.escape });
      expect([...encodeShellTextToBytes({ text: decoded })]).toEqual(testCase.bytes);
    }
  });

  it('drops out-of-range Bash Unicode escapes above the legacy UTF-8 range', () => {
    expect(decodeShellAnsiCQuote({ text: String.raw`a\U80000000b` })).toBe('ab');
    expect(decodeShellAnsiCQuote({ text: String.raw`a\UFFFFFFFFb` })).toBe('ab');
  });
});
