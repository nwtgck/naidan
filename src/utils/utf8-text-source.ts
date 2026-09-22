// A block is measured in UTF-16 code units, not bytes. Its UTF-8 encoding is at
// most three times this size. Never split a valid surrogate pair across blocks.
const TEXT_BLOCK_CODE_UNITS = 16 * 1024;

interface TextBlock {
  characterStart: number,
  characterEnd: number,
  byteStart: number,
  byteEnd: number,
}

function isHighSurrogate({ value }: { value: number }): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate({ value }: { value: number }): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

/** Same replacement of unpaired surrogates as TextEncoder, without encoding. */
function byteLengthOfRange({ text, start, end }: { text: string, start: number, end: number }): number {
  let length = 0;
  for (let i = start; i < end; i++) {
    const codeUnit = text.charCodeAt(i);
    if (codeUnit < 0x80) length++;
    else if (codeUnit < 0x800) length += 2;
    else if (isHighSurrogate({ value: codeUnit }) && i + 1 < end
      && isLowSurrogate({ value: text.charCodeAt(i + 1) })) {
      length += 4;
      i++;
    } else length += 3;
  }
  return length;
}

/** Count bytes without allocating a full encoded copy just to obtain its size. */
export function utf8ByteLength({ text }: { text: string }): number {
  if (typeof text !== 'string') throw new TypeError('UTF-8 byte length requires a string');
  return byteLengthOfRange({ text, start: 0, end: text.length });
}

export interface Utf8TextSource {
  /** Copy UTF-8 bytes at any byte offset, including inside a multibyte character. */
  read({ buffer, position }: { buffer: Uint8Array, position: number }): number,
  /** Scan any remaining text, but do not encode it or allocate its byte array. */
  getByteLength(): number,
}

/**
 * An immutable string viewed as UTF-8 bytes. Build a sparse offset index lazily
 * and retain only the most recently encoded block, not the complete byte file.
 * This retains the input string; it does not make the original renderer stream.
 */
export function createUtf8TextSource({ text }: { text: string }): Utf8TextSource {
  if (typeof text !== 'string') throw new TypeError('UTF-8 text source requires a string');
  const encoder = new TextEncoder();
  const blocks: TextBlock[] = [];
  let characterEnd = 0;
  let byteEnd = 0;
  let cached: { block: TextBlock, bytes: Uint8Array<ArrayBuffer> } | undefined;

  function indexNextBlock(): void {
    const start = characterEnd;
    let end = Math.min(start + TEXT_BLOCK_CODE_UNITS, text.length);
    if (end < text.length && isHighSurrogate({ value: text.charCodeAt(end - 1) })
      && isLowSurrogate({ value: text.charCodeAt(end) })) end--;
    const length = byteLengthOfRange({ text, start, end });
    if (length > Number.MAX_SAFE_INTEGER - byteEnd) throw new RangeError('UTF-8 text is too large');
    blocks.push({ characterStart: start, characterEnd: end, byteStart: byteEnd, byteEnd: byteEnd + length });
    characterEnd = end;
    byteEnd += length;
  }

  function findBlock({ position }: { position: number }): TextBlock | undefined {
    while (byteEnd <= position && characterEnd < text.length) indexNextBlock();
    if (position >= byteEnd) return undefined;
    let low = 0;
    let high = blocks.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (blocks[middle]!.byteEnd <= position) low = middle + 1;
      else high = middle;
    }
    return blocks[low];
  }

  function bytesForBlock({ block }: { block: TextBlock }): Uint8Array<ArrayBuffer> {
    if (cached?.block === block) return cached.bytes;
    const bytes = encoder.encode(text.slice(block.characterStart, block.characterEnd));
    if (bytes.byteLength !== block.byteEnd - block.byteStart) throw new Error('UTF-8 block length mismatch');
    cached = { block, bytes };
    return bytes;
  }

  return {
    read({ buffer, position }) {
      if (!Number.isSafeInteger(position) || position < 0) throw new RangeError('Invalid UTF-8 byte position');
      let copied = 0;
      while (copied < buffer.byteLength) {
        const block = findBlock({ position });
        if (block === undefined) break;
        const bytes = bytesForBlock({ block });
        const offset = position - block.byteStart;
        const length = Math.min(bytes.byteLength - offset, buffer.byteLength - copied);
        buffer.set(bytes.subarray(offset, offset + length), copied);
        copied += length;
        position += length;
      }
      return copied;
    },
    getByteLength() {
      while (characterEnd < text.length) indexNextBlock();
      return byteEnd;
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  TEXT_BLOCK_CODE_UNITS,
};
