export type TextRectangle = { left: number, right: number, top: number, bottom: number };

export function translationGraphemes({ text }: { text: string }): string[] {
  if (typeof Intl.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.segment);
  }
  return Array.from(text);
}

/** Cache each visual line once per update, not a sort for every old grapheme. */
export function createTranslationTextCoverage({ rectangles }: { rectangles: readonly TextRectangle[] }) {
  const lines = new Map<string, { left: number, right: number }[]>();
  const tolerance = 0.75;
  function covers({ rectangle }: { rectangle: TextRectangle }): boolean {
    if (rectangle.right <= rectangle.left || rectangle.bottom <= rectangle.top) {
      return false;
    }
    const key = `${rectangle.top}:${rectangle.bottom}`;
    let intervals = lines.get(key);
    if (intervals === undefined) {
      const candidates = rectangles.filter(next => next.top <= rectangle.top + tolerance && next.bottom >= rectangle.bottom - tolerance && next.right > next.left)
        .sort((a, b) => a.left - b.left);
      intervals = [];
      for (const next of candidates) {
        const last = intervals.at(-1);
        if (last && next.left <= last.right + tolerance) {
          last.right = Math.max(last.right, next.right);
        } else {
          intervals.push({ left: next.left, right: next.right });
        }
      }
      lines.set(key, intervals);
    }
    return intervals.some(interval => interval.left <= rectangle.left + tolerance && interval.right >= rectangle.right - tolerance);
  }
  return { covers };
}

export const TEST_ONLY = {
};
