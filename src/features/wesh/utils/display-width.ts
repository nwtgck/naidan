const ZERO_WIDTH_MARK_PATTERN = /^(?:\p{Nonspacing_Mark}|\p{Enclosing_Mark})$/u;
const DEFAULT_IGNORABLE_PATTERN = /^\p{Default_Ignorable_Code_Point}$/u;
const EMOJI_PRESENTATION_PATTERN = /^\p{Emoji_Presentation}$/u;
const ASSIGNED_PATTERN = /^\p{Assigned}$/u;

function codePointMatches({
  codePoint,
  pattern,
}: {
  codePoint: number,
  pattern: RegExp,
}): boolean {
  pattern.lastIndex = 0;
  return pattern.test(String.fromCodePoint(codePoint));
}

function isZeroWidthCodePoint({
  codePoint,
}: {
  codePoint: number,
}): boolean {
  if (codePoint === 0x00AD) {
    return false;
  }
  return (
    (codePoint >= 0x1160 && codePoint <= 0x11FF)
    || codePointMatches({ codePoint, pattern: ZERO_WIDTH_MARK_PATTERN })
    || codePointMatches({ codePoint, pattern: DEFAULT_IGNORABLE_PATTERN })
  );
}

function isWideCodePoint({
  codePoint,
}: {
  codePoint: number,
}): boolean {
  if (codePoint >= 0x1F1E6 && codePoint <= 0x1F1FF) {
    return false;
  }
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115F)
    || codePoint === 0x2329
    || codePoint === 0x232A
    || (codePoint >= 0x2E80 && codePoint <= 0xA4CF)
    || (codePoint >= 0xAC00 && codePoint <= 0xD7A3)
    || (codePoint >= 0xF900 && codePoint <= 0xFAFF)
    || (codePoint >= 0xFE10 && codePoint <= 0xFE19)
    || (codePoint >= 0xFE30 && codePoint <= 0xFE6F)
    || (codePoint >= 0xFF00 && codePoint <= 0xFF60)
    || (codePoint >= 0xFFE0 && codePoint <= 0xFFE6)
    || (codePoint >= 0x16FE0 && codePoint <= 0x16FFF)
    || (codePoint >= 0x17000 && codePoint <= 0x18CFF)
    || (codePoint >= 0x1AFF0 && codePoint <= 0x1B2FF)
    || (codePoint >= 0x1F200 && codePoint <= 0x1F251)
    || (codePoint >= 0x20000 && codePoint <= 0x3FFFD)
    || codePointMatches({ codePoint, pattern: EMOJI_PRESENTATION_PATTERN })
  );
}


export function getWeshCodePointDisplayWidth({
  codePoint,
}: {
  codePoint: number,
}): number {
  if (
    !Number.isInteger(codePoint)
    || codePoint < 0
    || codePoint > 0x10FFFF
    || (codePoint >= 0xD800 && codePoint <= 0xDFFF)
  ) {
    return 0;
  }

  if (
    codePoint === 0
    || codePoint < 32
    || (codePoint >= 0x7F && codePoint < 0xA0)
  ) {
    return 0;
  }

  // Printable ASCII dominates shell output. Avoid allocating a one-character
  // string and running Unicode-property regular expressions for this path.
  if (codePoint <= 0x7E) {
    return 1;
  }

  if (
    !codePointMatches({ codePoint, pattern: ASSIGNED_PATTERN })
    || isZeroWidthCodePoint({ codePoint })
  ) {
    return 0;
  }

  return isWideCodePoint({ codePoint }) ? 2 : 1;
}

export function getWeshTextDisplayWidth({
  text,
  initialColumn,
  tabSize,
}: {
  text: string,
  initialColumn: number,
  tabSize: number | undefined,
}): number {
  let column = initialColumn;
  for (const character of text) {
    if (character === '\t' && tabSize !== undefined) {
      column += tabSize - (column % tabSize);
      continue;
    }

    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined) {
      column += getWeshCodePointDisplayWidth({ codePoint });
    }
  }
  return column - initialColumn;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  codePointMatches,
  isZeroWidthCodePoint,
  isWideCodePoint,
};
