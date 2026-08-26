import type { WeshFileHandle } from '@/features/wesh/types';
import { writeAllBytesToHandle } from '@/features/wesh/utils/fs';

const UTF8_ENCODER = new TextEncoder();
const SURROGATE_ESCAPE_BASE = 0xdc00;
const SURROGATE_ESCAPE_MIN = 0xdc80;
const SURROGATE_ESCAPE_MAX = 0xdcff;

function isContinuationByte({ byte }: { byte: number | undefined }): boolean {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

function appendEscapedByte({ output, byte }: { output: string; byte: number }): string {
  return output + String.fromCharCode(SURROGATE_ESCAPE_BASE + byte);
}

export function decodeCommandDataBytesAsSingleByte({
  bytes,
}: {
  bytes: Uint8Array,
}): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 4096) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 4096)));
  }
  return chunks.join('');
}

export function decodeCommandDataBytes({ bytes }: { bytes: Uint8Array }): string {
  let output = '';
  let index = 0;

  while (index < bytes.byteLength) {
    const first = bytes[index]!;
    if (first <= 0x7f) {
      output += String.fromCharCode(first);
      index += 1;
      continue;
    }

    if (first >= 0xc2 && first <= 0xdf) {
      const second = bytes[index + 1];
      if (second !== undefined && isContinuationByte({ byte: second })) {
        output += String.fromCodePoint(((first & 0x1f) << 6) | (second & 0x3f));
        index += 2;
        continue;
      }
    } else if (first >= 0xe0 && first <= 0xef) {
      const second = bytes[index + 1];
      const third = bytes[index + 2];
      const secondIsValid = second !== undefined
        && isContinuationByte({ byte: second })
        && (first !== 0xe0 || second >= 0xa0)
        && (first !== 0xed || second <= 0x9f);
      if (secondIsValid && third !== undefined && isContinuationByte({ byte: third })) {
        output += String.fromCodePoint(
          ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f),
        );
        index += 3;
        continue;
      }
    } else if (first >= 0xf0 && first <= 0xf4) {
      const second = bytes[index + 1];
      const third = bytes[index + 2];
      const fourth = bytes[index + 3];
      const secondIsValid = second !== undefined
        && isContinuationByte({ byte: second })
        && (first !== 0xf0 || second >= 0x90)
        && (first !== 0xf4 || second <= 0x8f);
      if (
        secondIsValid
        && third !== undefined
        && isContinuationByte({ byte: third })
        && fourth !== undefined
        && isContinuationByte({ byte: fourth })
      ) {
        output += String.fromCodePoint(
          ((first & 0x07) << 18)
          | ((second & 0x3f) << 12)
          | ((third & 0x3f) << 6)
          | (fourth & 0x3f),
        );
        index += 4;
        continue;
      }
    }

    output = appendEscapedByte({ output, byte: first });
    index += 1;
  }

  return output;
}

function concatenateChunks({ chunks, byteLength }: {
  chunks: readonly Uint8Array[];
  byteLength: number;
}): Uint8Array {
  if (chunks.length === 0) {
    return new Uint8Array(0);
  }
  if (chunks.length === 1) {
    return chunks[0]!;
  }

  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function encodeCommandDataText({ text }: { text: string }): Uint8Array {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let ordinaryText = '';

  const flushOrdinaryText = (): void => {
    if (ordinaryText.length === 0) {
      return;
    }
    const encoded = UTF8_ENCODER.encode(ordinaryText);
    chunks.push(encoded);
    byteLength += encoded.byteLength;
    ordinaryText = '';
  };

  for (let index = 0; index < text.length;) {
    const codeUnit = text.charCodeAt(index);
    const nextCodeUnit = index + 1 < text.length ? text.charCodeAt(index + 1) : undefined;
    if (
      codeUnit >= 0xd800
      && codeUnit <= 0xdbff
      && nextCodeUnit !== undefined
      && nextCodeUnit >= 0xdc00
      && nextCodeUnit <= 0xdfff
    ) {
      ordinaryText += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (codeUnit >= SURROGATE_ESCAPE_MIN && codeUnit <= SURROGATE_ESCAPE_MAX) {
      flushOrdinaryText();
      const escaped = Uint8Array.of(codeUnit - SURROGATE_ESCAPE_BASE);
      chunks.push(escaped);
      byteLength += 1;
      index += 1;
      continue;
    }
    ordinaryText += text[index]!;
    index += 1;
  }
  flushOrdinaryText();

  return concatenateChunks({ chunks, byteLength });
}


function isPotentialIncompleteUtf8Sequence({
  bytes,
  start,
}: {
  bytes: Uint8Array;
  start: number;
}): boolean {
  const first = bytes[start];
  if (first === undefined) return false;
  const available = bytes.byteLength - start;
  let expected: number;
  if (first >= 0xc2 && first <= 0xdf) expected = 2;
  else if (first >= 0xe0 && first <= 0xef) expected = 3;
  else if (first >= 0xf0 && first <= 0xf4) expected = 4;
  else return false;
  if (available >= expected) return false;

  const second = bytes[start + 1];
  if (second !== undefined) {
    if (!isContinuationByte({ byte: second })) return false;
    if (first === 0xe0 && second < 0xa0) return false;
    if (first === 0xed && second > 0x9f) return false;
    if (first === 0xf0 && second < 0x90) return false;
    if (first === 0xf4 && second > 0x8f) return false;
  }
  for (let index = start + 2; index < bytes.byteLength; index += 1) {
    if (!isContinuationByte({ byte: bytes[index] })) return false;
  }
  return true;
}

function getIncompleteUtf8SuffixLength({ bytes }: { bytes: Uint8Array }): number {
  const minimumStart = Math.max(0, bytes.byteLength - 3);
  for (let start = minimumStart; start < bytes.byteLength; start += 1) {
    if (isPotentialIncompleteUtf8Sequence({ bytes, start })) {
      return bytes.byteLength - start;
    }
  }
  return 0;
}

export class CommandDataStreamDecoder {
  private pending = new Uint8Array(0);

  write({ bytes }: { bytes: Uint8Array }): string {
    const combined = this.pending.byteLength === 0
      ? bytes
      : concatenateChunks({
        chunks: [this.pending, bytes],
        byteLength: this.pending.byteLength + bytes.byteLength,
      });
    const pendingLength = getIncompleteUtf8SuffixLength({ bytes: combined });
    const safeLength = combined.byteLength - pendingLength;
    const text = decodeCommandDataBytes({ bytes: combined.subarray(0, safeLength) });
    this.pending = pendingLength === 0
      ? new Uint8Array(0)
      : combined.slice(safeLength);
    return text;
  }

  finish(): string {
    const text = decodeCommandDataBytes({ bytes: this.pending });
    this.pending = new Uint8Array(0);
    return text;
  }
}

export function createBufferedCommandDataWriter({
  handle,
  maxBufferLength,
}: {
  handle: WeshFileHandle;
  maxBufferLength: number;
}): {
  write({ text }: { text: string }): Promise<void>;
  flush(): Promise<void>;
} {
  let chunks: string[] = [];
  let bufferedLength = 0;

  const flush = async (): Promise<void> => {
    if (bufferedLength === 0) {
      return;
    }
    const text = chunks.join('');
    chunks = [];
    bufferedLength = 0;
    await writeAllBytesToHandle({
      handle,
      data: encodeCommandDataText({ text }),
    });
  };

  return {
    async write({ text }) {
      if (text.length === 0) {
        return;
      }
      chunks.push(text);
      bufferedLength += text.length;
      if (bufferedLength >= maxBufferLength) {
        await flush();
      }
    },
    flush,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
