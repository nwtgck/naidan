import { encodeShellTextToBytes, shellByteValueToText } from './byte-text';

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
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

  let result = '';
  for (const byte of encodeLegacyUtf8Bytes({ value })) {
    result += shellByteValueToText({ byte });
  }
  return result;
}

function asciiHexDigitValue({ value }: { value: string | undefined }): number | undefined {
  if (value === undefined) return undefined;
  const code = value.charCodeAt(0);
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return undefined;
}

function asciiOctalDigitValue({ value }: { value: string | undefined }): number | undefined {
  if (value === undefined) return undefined;
  const code = value.charCodeAt(0);
  return code >= 0x30 && code <= 0x37 ? code - 0x30 : undefined;
}

function readEscapeInteger({
  text,
  startIndex,
  maximumDigits,
  base,
}: {
  text: string,
  startIndex: number,
  maximumDigits: number,
  base: 8 | 16,
}): {
  value: number,
  digits: number,
  nextIndex: number,
} {
  let value = 0;
  let digits = 0;
  let nextIndex = startIndex;
  while (digits < maximumDigits) {
    const digit = base === 16
      ? asciiHexDigitValue({ value: text[nextIndex] })
      : asciiOctalDigitValue({ value: text[nextIndex] });
    if (digit === undefined) break;
    value = value * base + digit;
    digits += 1;
    nextIndex += 1;
  }
  return { value, digits, nextIndex };
}

export function decodeShellAnsiCQuote({ text }: { text: string }): string {
  const output: string[] = [];
  let literalStart = 0;
  let index = 0;

  const appendLiteralRun = ({ endIndex }: { endIndex: number }): void => {
    if (literalStart < endIndex) {
      output.push(text.slice(literalStart, endIndex));
    }
  };

  const finishAtNul = (): string => output.join('');

  while (index < text.length) {
    if (text[index] !== '\\') {
      index += 1;
      continue;
    }

    appendLiteralRun({ endIndex: index });
    const escaped = text[index + 1];
    if (escaped === undefined) {
      output.push('\\');
      index += 1;
      literalStart = index;
      continue;
    }

    const simple = SIMPLE_ESCAPES[escaped];
    if (simple !== undefined) {
      output.push(simple);
      index += 2;
      literalStart = index;
      continue;
    }

    if (escaped === 'c') {
      const controlStart = index + 2;
      const control = text[controlStart];
      if (control === undefined) {
        output.push('\\c');
        index += 2;
        literalStart = index;
        continue;
      }

      // Bash applies `\c` to the first byte of the next shell character,
      // not to its Unicode code point. For a multibyte UTF-8 character the
      // remaining bytes are preserved verbatim after the controlled byte.
      // `\c\\` is the one source-level special case: two backslashes encode
      // one logical backslash operand and are both consumed.
      const quotedBackslash = control === '\\' && text[controlStart + 1] === '\\';
      const controlCodePoint = text.codePointAt(controlStart)!;
      const controlCharacters = quotedBackslash
        ? 2
        : controlCodePoint > 0xffff ? 2 : 1;
      const operandText = quotedBackslash
        ? '\\'
        : text.slice(controlStart, controlStart + controlCharacters);
      const operandBytes = encodeShellTextToBytes({ text: operandText });
      const firstByte = operandBytes[0];
      if (firstByte === undefined) {
        throw new Error('Missing Bash control escape operand byte');
      }
      const controlValue = firstByte === 0x3f ? 0x7f : firstByte & 0x1f;
      if (controlValue === 0) return finishAtNul();
      output.push(shellByteValueToText({ byte: controlValue }));
      for (let byteIndex = 1; byteIndex < operandBytes.length; byteIndex += 1) {
        const byte = operandBytes[byteIndex];
        if (byte === undefined) {
          throw new Error(`Missing Bash control escape operand byte at offset ${byteIndex}`);
        }
        output.push(shellByteValueToText({ byte }));
      }
      index = controlStart + controlCharacters;
      literalStart = index;
      continue;
    }

    if (escaped === 'x') {
      const parsed = readEscapeInteger({
        text,
        startIndex: index + 2,
        maximumDigits: 2,
        base: 16,
      });
      if (parsed.digits === 0) {
        output.push('\\x');
        index += 2;
        literalStart = index;
        continue;
      }
      if (parsed.value === 0) return finishAtNul();
      output.push(shellByteValueToText({ byte: parsed.value }));
      index = parsed.nextIndex;
      literalStart = index;
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
      const parsed = readEscapeInteger({
        text,
        startIndex: index + 2,
        maximumDigits,
        base: 16,
      });
      if (parsed.digits === 0) {
        output.push(`\\${escaped}`);
        index += 2;
        literalStart = index;
        continue;
      }
      if (parsed.value === 0) return finishAtNul();
      output.push(decodeUnicodeEscape({ value: parsed.value }));
      index = parsed.nextIndex;
      literalStart = index;
      continue;
    }

    if (asciiOctalDigitValue({ value: escaped }) !== undefined) {
      const parsed = readEscapeInteger({
        text,
        startIndex: index + 1,
        maximumDigits: 3,
        base: 8,
      });
      const byte = parsed.value & 0xff;
      if (byte === 0) return finishAtNul();
      output.push(shellByteValueToText({ byte }));
      index = parsed.nextIndex;
      literalStart = index;
      continue;
    }

    output.push(text.slice(index, index + 2));
    index += 2;
    literalStart = index;
  }

  appendLiteralRun({ endIndex: text.length });
  return output.join('');
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
