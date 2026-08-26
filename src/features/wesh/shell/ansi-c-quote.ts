import { isAsciiHexDigit, isAsciiOctalDigit } from './ascii';
import { shellByteValueToText } from './byte-text';

function encodeLegacyUtf8Bytes({ value }: { value: number }): readonly number[] {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) return [];
  if (value <= 0x7f) return [value];

  let continuationCount: 1 | 2 | 3 | 4 | 5;
  let prefix: number;
  if (value <= 0x7ff) {
    continuationCount = 1;
    prefix = 0xc0;
  } else if (value <= 0xffff) {
    continuationCount = 2;
    prefix = 0xe0;
  } else if (value <= 0x1fffff) {
    continuationCount = 3;
    prefix = 0xf0;
  } else if (value <= 0x3ffffff) {
    continuationCount = 4;
    prefix = 0xf8;
  } else {
    continuationCount = 5;
    prefix = 0xfc;
  }

  const output = new Array<number>(continuationCount + 1);
  let remaining = value;
  for (let index = continuationCount; index >= 1; index -= 1) {
    output[index] = 0x80 | (remaining & 0x3f);
    remaining >>= 6;
  }
  output[0] = prefix | remaining;
  return output;
}

function decodeUnicodeEscape({ value }: { value: number }): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) return '';
  if (value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)) {
    return String.fromCodePoint(value);
  }
  return encodeLegacyUtf8Bytes({ value })
    .map((byte) => shellByteValueToText({ byte }))
    .join('');
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
      const controlValue = control === '?' ? 0x7f : codePoint & 0x1f;
      if (controlValue === 0) return result;
      result += String.fromCharCode(controlValue);
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
      const byte = Number.parseInt(digits, 16);
      if (byte === 0) return result;
      result += shellByteValueToText({ byte });
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
      const value = Number.parseInt(digits, 16);
      if (value === 0) return result;
      result += decodeUnicodeEscape({ value });
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
      const byte = Number.parseInt(digits, 8) & 0xff;
      if (byte === 0) return result;
      result += shellByteValueToText({ byte });
      index = cursor - 1;
      continue;
    }

    if (escaped === '\n') {
      result += '\\' + '\n';
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
