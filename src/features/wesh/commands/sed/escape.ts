import { decodeCommandDataBytes } from '@/features/wesh/commands/_shared/data-codec';

export function decodeSedSingleCharacterEscape({
  escaped,
}: {
  escaped: string;
}): string | undefined {
  switch (escaped) {
  case 'a': return '\x07';
  case 'f': return '\f';
  case 'n': return '\n';
  case 'r': return '\r';
  case 't': return '\t';
  case 'v': return '\x0b';
  default: return undefined;
  }
}

interface SedDecodedEscape {
  value: string;
  lastIndex: number;
}

export function decodeSedExtendedEscape({
  source,
  backslashIndex,
}: {
  source: string;
  backslashIndex: number;
}): SedDecodedEscape | undefined {
  const escaped = source[backslashIndex + 1];
  if (escaped === undefined) return undefined;

  const decoded = decodeSedSingleCharacterEscape({ escaped });
  if (decoded !== undefined) {
    return { value: decoded, lastIndex: backslashIndex + 1 };
  }

  if (escaped === 'c') {
    const controlled = source[backslashIndex + 2];
    if (controlled === undefined) return undefined;
    const codePoint = controlled.codePointAt(0);
    if (codePoint === undefined) return undefined;
    const normalizedCodePoint = codePoint >= 0x61 && codePoint <= 0x7a
      ? codePoint - 0x20
      : codePoint;
    const byte = normalizedCodePoint ^ 0x40;
    return {
      value: decodeCommandDataBytes({ bytes: Uint8Array.of(byte) }),
      lastIndex: backslashIndex + 2,
    };
  }

  const numericEscape = (() => {
    switch (escaped) {
    case 'x':
      return { radix: 16, pattern: /^[0-9A-Fa-f]{1,2}/u };
    case 'o':
      return { radix: 8, pattern: /^[0-7]{1,3}/u };
    case 'd':
      return { radix: 10, pattern: /^\d{1,3}/u };
    default:
      return undefined;
    }
  })();
  if (numericEscape === undefined) return undefined;

  const match = numericEscape.pattern.exec(source.slice(backslashIndex + 2));
  if (match === null) return undefined;
  const byte = Number.parseInt(match[0], numericEscape.radix) & 0xff;
  return {
    value: decodeCommandDataBytes({ bytes: Uint8Array.of(byte) }),
    lastIndex: backslashIndex + 1 + match[0].length,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
