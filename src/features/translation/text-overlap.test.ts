import { describe, expect, it } from 'vitest';
import { createTranslationTextCoverage, translationGraphemes } from './text-overlap';

describe('translation text coverage', () => {
  const old = { left: 20, right: 30, top: 0, bottom: 18 };

  it('does not erase a glyph before the new text actually covers it', () => {
    expect(createTranslationTextCoverage({ rectangles: [{ ...old, left: 0, right: 24 }] }).covers({ rectangle: old })).toBe(false);
    expect(createTranslationTextCoverage({ rectangles: [{ ...old, left: 0, right: 30 }] }).covers({ rectangle: old })).toBe(true);
  });

  it('unites adjacent visual ranges but not gaps between bidi fragments', () => {
    const coverage = createTranslationTextCoverage({ rectangles: [{ ...old, left: 25, right: 40 }, { ...old, left: 10, right: 25 }] });
    expect(coverage.covers({ rectangle: old })).toBe(true);
    const gap = createTranslationTextCoverage({ rectangles: [{ ...old, left: 26, right: 40 }, { ...old, left: 10, right: 23 }] });
    expect(gap.covers({ rectangle: old })).toBe(false);
  });

  it('does not confuse earlier or later wrapped lines with the current one', () => {
    const coverage = createTranslationTextCoverage({ rectangles: [{ left: 0, right: 300, top: 28, bottom: 46 }] });
    expect(coverage.covers({ rectangle: old })).toBe(false);
    expect(coverage.covers({ rectangle: { ...old, top: 28, bottom: 46 } })).toBe(true);
  });

  it('rejects zero-width and empty boxes while tolerating subpixel rounding', () => {
    const coverage = createTranslationTextCoverage({ rectangles: [{ ...old, right: 29.8 }] });
    expect(coverage.covers({ rectangle: old })).toBe(true);
    expect(coverage.covers({ rectangle: { ...old, right: 20 } })).toBe(false);
    expect(createTranslationTextCoverage({ rectangles: [] }).covers({ rectangle: old })).toBe(false);
  });

  it('keeps combining marks, emoji sequences and Indic graphemes intact', () => {
    const text = 'か\u3099👨‍👩‍👧‍👦A';
    expect(translationGraphemes({ text })).toEqual(['か\u3099', '👨‍👩‍👧‍👦', 'A']);
    expect(translationGraphemes({ text: 'नमस्ते' }).join('')).toBe('नमस्ते');
  });
});
