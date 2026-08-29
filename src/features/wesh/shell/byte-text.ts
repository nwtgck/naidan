const RAW_BYTE_SURROGATE_BASE = 0xdc00;
const RAW_BYTE_MINIMUM = 0x80;
const RAW_BYTE_MAXIMUM = 0xff;
const RAW_BYTE_SURROGATE_PATTERN = /[\uDC80-\uDCFF]/u;
const UTF8_ENCODER = new TextEncoder();
const STRICT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export type ShellByteTextProjection = {
  text: string,
  textBoundaryByteOffsets: Array<number | undefined>,
  consumedBytes: number,
};

type ShellByteTextVisitor = ({ codePoint, byteOffset }: {
  codePoint: number,
  byteOffset: number,
}) => boolean;

/**
 * Byte-backed shell source uses U+DC80..U+DCFF as an internal reversible
 * representation for raw bytes that are not part of valid UTF-8. Valid UTF-8
 * cannot decode to lone surrogate code units, so Unicode input remains
 * unambiguous while lexer/parser code can continue operating on strings.
 */
function rawByteToShellCodePoint({ byte }: { byte: number }): number {
  if (byte < RAW_BYTE_MINIMUM || byte > RAW_BYTE_MAXIMUM) {
    throw new Error(`Invalid raw shell byte: ${byte}`);
  }
  return RAW_BYTE_SURROGATE_BASE + byte;
}

export function shellByteValueToText({ byte }: { byte: number }): string {
  if (!Number.isSafeInteger(byte) || byte < 0 || byte > 0xff) {
    throw new Error(`Invalid shell byte value: ${byte}`);
  }
  return byte <= 0x7f
    ? String.fromCharCode(byte)
    : String.fromCodePoint(rawByteToShellCodePoint({ byte }));
}

function visitShellUtf8Text({ bytes, completion, visit }: {
  bytes: Uint8Array,
  completion: 'complete' | 'may-continue',
  visit: ShellByteTextVisitor,
}): number {
  let index = 0;

  const visitRawByte = ({ byteOffset }: { byteOffset: number }): boolean => {
    const byte = bytes[byteOffset];
    if (byte === undefined) {
      throw new Error(`Missing raw shell byte at offset ${byteOffset}`);
    }
    index = byteOffset + 1;
    return visit({
      codePoint: rawByteToShellCodePoint({ byte }),
      byteOffset: index,
    });
  };

  while (index < bytes.length) {
    const firstOffset = index;
    const first = bytes[firstOffset];
    if (first === undefined) {
      throw new Error('Missing shell source byte');
    }
    if (first <= 0x7f) {
      index += 1;
      if (visit({ codePoint: first, byteOffset: index })) {
        return index;
      }
      continue;
    }

    let length: 2 | 3 | 4;
    let codePoint: number;
    let secondMinimum = 0x80;
    let secondMaximum = 0xbf;
    if (first >= 0xc2 && first <= 0xdf) {
      length = 2;
      codePoint = first & 0x1f;
    } else if (first >= 0xe0 && first <= 0xef) {
      length = 3;
      codePoint = first & 0x0f;
      if (first === 0xe0) {
        secondMinimum = 0xa0;
      } else if (first === 0xed) {
        secondMaximum = 0x9f;
      }
    } else if (first >= 0xf0 && first <= 0xf4) {
      length = 4;
      codePoint = first & 0x07;
      if (first === 0xf0) {
        secondMinimum = 0x90;
      } else if (first === 0xf4) {
        secondMaximum = 0x8f;
      }
    } else {
      if (visitRawByte({ byteOffset: firstOffset })) {
        return index;
      }
      continue;
    }

    if (firstOffset + length > bytes.length) {
      switch (completion) {
      case 'may-continue': {
        let validPrefix = true;
        for (let offset = firstOffset + 1; offset < bytes.length; offset += 1) {
          const byte = bytes[offset];
          if (byte === undefined) {
            throw new Error(`Missing shell source byte at offset ${offset}`);
          }
          const minimum = offset === firstOffset + 1 ? secondMinimum : 0x80;
          const maximum = offset === firstOffset + 1 ? secondMaximum : 0xbf;
          if (byte < minimum || byte > maximum) {
            validPrefix = false;
            break;
          }
        }
        if (validPrefix) {
          return firstOffset;
        }
        break;
      }
      case 'complete':
        break;
      default: {
        const _ex: never = completion;
        throw new Error(`Unhandled shell source completion: ${_ex}`);
      }
      }
    }

    const second = bytes[firstOffset + 1];
    if (second === undefined || second < secondMinimum || second > secondMaximum) {
      if (visitRawByte({ byteOffset: firstOffset })) {
        return index;
      }
      continue;
    }
    codePoint = (codePoint << 6) | (second & 0x3f);

    if (length >= 3) {
      const third = bytes[firstOffset + 2];
      if (third === undefined || third < 0x80 || third > 0xbf) {
        if (visitRawByte({ byteOffset: firstOffset })) {
          return index;
        }
        continue;
      }
      codePoint = (codePoint << 6) | (third & 0x3f);
    }

    if (length === 4) {
      const fourth = bytes[firstOffset + 3];
      if (fourth === undefined || fourth < 0x80 || fourth > 0xbf) {
        if (visitRawByte({ byteOffset: firstOffset })) {
          return index;
        }
        continue;
      }
      codePoint = (codePoint << 6) | (fourth & 0x3f);
    }

    index = firstOffset + length;
    if (visit({ codePoint, byteOffset: index })) {
      return index;
    }
  }

  return index;
}

export function decodeShellUtf8Text({ bytes, completion }: {
  bytes: Uint8Array,
  completion: 'complete' | 'may-continue',
}): { text: string, consumedBytes: number } {
  try {
    return {
      text: STRICT_UTF8_DECODER.decode(bytes),
      consumedBytes: bytes.length,
    };
  } catch {
    // Invalid or incomplete UTF-8 needs the byte-preserving projection below.
  }

  let text = '';
  const consumedBytes = visitShellUtf8Text({
    bytes,
    completion,
    visit: ({ codePoint }) => {
      text += String.fromCodePoint(codePoint);
      return false;
    },
  });
  return {
    text,
    consumedBytes,
  };
}

export function decodeShellUtf8Projection({ bytes, completion }: {
  bytes: Uint8Array,
  completion: 'complete' | 'may-continue',
}): ShellByteTextProjection {
  const textParts: string[] = [];
  const textBoundaryByteOffsets: Array<number | undefined> = [0];
  const consumedBytes = visitShellUtf8Text({
    bytes,
    completion,
    visit: ({ codePoint, byteOffset }) => {
      textParts.push(String.fromCodePoint(codePoint));
      if (codePoint <= 0xffff) {
        textBoundaryByteOffsets.push(byteOffset);
      } else {
        textBoundaryByteOffsets.push(undefined, byteOffset);
      }
      return false;
    },
  });
  return {
    text: textParts.join(''),
    textBoundaryByteOffsets,
    consumedBytes,
  };
}

export function findShellUtf8ByteOffsetForTextBoundary({ bytes, completion, characters }: {
  bytes: Uint8Array,
  completion: 'complete' | 'may-continue',
  characters: number,
}): number {
  if (!Number.isSafeInteger(characters) || characters < 0) {
    throw new Error(`Invalid shell source text consumption: ${characters}`);
  }
  if (characters === 0) {
    return 0;
  }

  let visitedCharacters = 0;
  let result: number | undefined;
  visitShellUtf8Text({
    bytes,
    completion,
    visit: ({ codePoint, byteOffset }) => {
      const width = codePoint <= 0xffff ? 1 : 2;
      if (visitedCharacters + width > characters) {
        throw new Error('Shell parser consumed part of one Unicode code point');
      }
      visitedCharacters += width;
      if (visitedCharacters === characters) {
        result = byteOffset;
        return true;
      }
      return false;
    },
  });
  if (result === undefined) {
    throw new Error(`Shell parser consumed beyond available source text: ${characters}`);
  }
  return result;
}

export function encodeShellTextToBytes({ text }: { text: string }): Uint8Array {
  if (!RAW_BYTE_SURROGATE_PATTERN.test(text)) {
    return UTF8_ENCODER.encode(text);
  }

  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  let segmentStart = 0;

  const pushChunk = ({ chunk }: { chunk: Uint8Array }) => {
    if (chunk.length === 0) {
      return;
    }
    chunks.push(chunk);
    totalLength += chunk.length;
  };

  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
      }
      continue;
    }
    if (codeUnit < RAW_BYTE_SURROGATE_BASE + RAW_BYTE_MINIMUM ||
      codeUnit > RAW_BYTE_SURROGATE_BASE + RAW_BYTE_MAXIMUM) {
      continue;
    }

    pushChunk({ chunk: UTF8_ENCODER.encode(text.slice(segmentStart, index)) });
    pushChunk({ chunk: Uint8Array.of(codeUnit - RAW_BYTE_SURROGATE_BASE) });
    segmentStart = index + 1;
  }
  pushChunk({ chunk: UTF8_ENCODER.encode(text.slice(segmentStart)) });

  if (chunks.length === 0) {
    return new Uint8Array(0);
  }
  if (chunks.length === 1) {
    return chunks[0] ?? new Uint8Array(0);
  }
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export function decodeShellBytesToText({ bytes }: { bytes: Uint8Array }): string {
  return decodeShellUtf8Text({
    bytes,
    completion: 'complete',
  }).text;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  RAW_BYTE_SURROGATE_BASE,
};
