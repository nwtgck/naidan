import { describe, expect, it } from 'vitest';
import { getWeshCodePointDisplayWidth, getWeshTextDisplayWidth } from './display-width';

describe('Wesh display width', () => {
  it('classifies combining, wide, emoji, and unassigned code points', () => {
    expect(getWeshCodePointDisplayWidth({ codePoint: 'A'.codePointAt(0)! })).toBe(1);
    expect(getWeshCodePointDisplayWidth({ codePoint: 'é'.codePointAt(0)! })).toBe(1);
    expect(getWeshCodePointDisplayWidth({ codePoint: '漢'.codePointAt(0)! })).toBe(2);
    expect(getWeshCodePointDisplayWidth({ codePoint: '😀'.codePointAt(0)! })).toBe(2);
    expect(getWeshCodePointDisplayWidth({ codePoint: '🏽'.codePointAt(0)! })).toBe(2);
    expect(getWeshCodePointDisplayWidth({ codePoint: '🇯'.codePointAt(0)! })).toBe(1);
    expect(getWeshCodePointDisplayWidth({ codePoint: 0x0301 })).toBe(0);
    expect(getWeshCodePointDisplayWidth({ codePoint: 0x200D })).toBe(0);
    expect(getWeshCodePointDisplayWidth({ codePoint: 0x0378 })).toBe(0);
  });

  it('rejects values that cannot be Unicode scalar values', () => {
    expect(getWeshCodePointDisplayWidth({ codePoint: Number.NaN })).toBe(0);
    expect(getWeshCodePointDisplayWidth({ codePoint: -1 })).toBe(0);
    expect(getWeshCodePointDisplayWidth({ codePoint: 0xD800 })).toBe(0);
    expect(getWeshCodePointDisplayWidth({ codePoint: 0x110000 })).toBe(0);
  });

  it('sums code point widths and tab stops', () => {
    expect(getWeshTextDisplayWidth({ text: 'e\u0301😀漢', initialColumn: 0, tabSize: undefined })).toBe(5);
    expect(getWeshTextDisplayWidth({ text: 'a\tb', initialColumn: 0, tabSize: 8 })).toBe(9);
  });
});
