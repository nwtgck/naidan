import { isAsciiHexDigit, isAsciiOctalDigit } from './ascii';
import { shellByteValueToText } from './byte-text';

function decodeCodePoint({ value, fallback }: { value: number; fallback: string }): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x10ffff) return fallback;
  if (value >= 0xd800 && value <= 0xdfff) return fallback;
  return String.fromCodePoint(value);
}

export function decodeShellAnsiCQuote({ text }: { text: string }): string {
  let result = '';

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== '\\') {
      result += character ?? '';
      continue;
    }

    const escaped = text[index + 1];
    if (escaped === undefined) {
      result += '\\';
      continue;
    }

    const simpleEscapes: Readonly<Record<string, string>> = {
      a: '\x07',
      b: '\x08',
      e: '\x1b',
      E: '\x1b',
      f: '\x0c',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\x0b',
      '\\': '\\',
      "'": "'",
      '"': '"',
      '?': '?',
    };
    const simple = simpleEscapes[escaped];
    if (simple !== undefined) {
      result += simple;
      index += 1;
      continue;
    }

    if (escaped === 'c') {
      const control = text[index + 2];
      if (control === undefined) {
        result += '\\c';
        index += 1;
        continue;
      }
      const codePoint = control.codePointAt(0)!;
      result += String.fromCharCode(control === '?' ? 0x7f : codePoint & 0x1f);
      index += 2;
      continue;
    }

    if (escaped === 'x') {
      let digits = '';
      let cursor = index + 2;
      while (digits.length < 2 && isAsciiHexDigit({ value: text[cursor] })) {
        digits += text[cursor]!;
        cursor += 1;
      }
      if (digits.length === 0) {
        result += '\\x';
        index += 1;
        continue;
      }
      result += shellByteValueToText({ byte: Number.parseInt(digits, 16) });
      index = cursor - 1;
      continue;
    }

    if (escaped === 'u' || escaped === 'U') {
      const maximumDigits = (() => {
        switch (escaped) {
        case 'u': return 4;
        case 'U': return 8;
        default: {
          const _ex: never = escaped;
          throw new Error(`Unhandled Unicode escape: ${_ex}`);
        }
        }
      })();
      let digits = '';
      let cursor = index + 2;
      while (digits.length < maximumDigits && isAsciiHexDigit({ value: text[cursor] })) {
        digits += text[cursor]!;
        cursor += 1;
      }
      if (digits.length === 0) {
        result += `\\${escaped}`;
        index += 1;
        continue;
      }
      const literal = text.slice(index, cursor);
      result += decodeCodePoint({ value: Number.parseInt(digits, 16), fallback: literal });
      index = cursor - 1;
      continue;
    }

    if (isAsciiOctalDigit({ value: escaped })) {
      let digits = escaped;
      let cursor = index + 2;
      while (digits.length < 3 && isAsciiOctalDigit({ value: text[cursor] })) {
        digits += text[cursor]!;
        cursor += 1;
      }
      result += shellByteValueToText({ byte: Number.parseInt(digits, 8) & 0xff });
      index = cursor - 1;
      continue;
    }

    if (escaped === '\n') {
      index += 1;
      continue;
    }

    result += `\\${escaped}`;
    index += 1;
  }

  return result;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
