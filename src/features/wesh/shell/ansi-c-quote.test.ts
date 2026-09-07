import { describe, expect, it } from 'vitest';
import { encodeShellTextToBytes, shellByteValueToText } from './byte-text';
import { decodeShellAnsiCQuote } from './ansi-c-quote';

describe('decodeShellAnsiCQuote', () => {
  it('truncates the shell string at NUL-producing escapes like Bash', () => {
    expect(decodeShellAnsiCQuote({ text: String.raw`a\c@b` })).toBe('a');
    expect(decodeShellAnsiCQuote({ text: String.raw`a\000b` })).toBe('a');
    expect(decodeShellAnsiCQuote({ text: String.raw`a\x00b` })).toBe('a');
    expect(decodeShellAnsiCQuote({ text: String.raw`a\u0000b` })).toBe('a');
  });

  it('consumes the quoted backslash operand of Bash control-backslash escapes', () => {
    expect(decodeShellAnsiCQuote({ text: String.raw`\c\\` })).toBe('\x1c');
    expect(decodeShellAnsiCQuote({ text: String.raw`a\c\\b` })).toBe(`a\x1cb`);
    expect(decodeShellAnsiCQuote({ text: String.raw`\c\\\\` })).toBe('\x1c\\');
  });

  it('applies Bash control escapes to the first UTF-8 byte of non-ASCII operands', () => {
    const cases = [
      { text: String.raw`\cé`, bytes: [0x03, 0xa9] },
      { text: String.raw`\cĀ`, bytes: [0x04, 0x80] },
      { text: String.raw`\c😀`, bytes: [0x10, 0x9f, 0x98, 0x80] },
      { text: String.raw`a\céb`, bytes: [0x61, 0x03, 0xa9, 0x62] },
    ] as const;
    for (const testCase of cases) {
      expect([...encodeShellTextToBytes({
        text: decodeShellAnsiCQuote({ text: testCase.text }),
      })]).toEqual(testCase.bytes);
    }

    expect(decodeShellAnsiCQuote({ text: String.raw`a\cࠀb` })).toBe('a');

    const rawHighByte = shellByteValueToText({ byte: 0xc3 });
    expect([...encodeShellTextToBytes({
      text: decodeShellAnsiCQuote({ text: `\\c${rawHighByte}` }),
    })]).toEqual([0x03]);
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

  it('stops numeric escapes at their Bash digit limits without consuming following text', () => {
    expect(decodeShellAnsiCQuote({ text: String.raw`a\x414b` })).toBe('aA4b');
    expect(decodeShellAnsiCQuote({ text: String.raw`a\1012b` })).toBe('aA2b');
    expect(decodeShellAnsiCQuote({ text: String.raw`a\u0041zb` })).toBe('aAzb');
    expect(decodeShellAnsiCQuote({ text: String.raw`a\U0001F600zb` })).toBe('a😀zb');
  });

  it('preserves long literal runs around decoded escapes', () => {
    const prefix = 'prefix-'.repeat(256);
    const suffix = '-suffix'.repeat(256);
    expect(decodeShellAnsiCQuote({ text: `${prefix}\\n${suffix}` })).toBe(`${prefix}\n${suffix}`);
  });
});
