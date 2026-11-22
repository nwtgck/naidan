export interface RgInputLine {
  readonly text: string,
  readonly number: number,
  readonly byteOffset: number,
}

export function createRgLineReader({ trackByteOffsets }: { trackByteOffsets: boolean }) {
  const decoder = new TextDecoder();
  let lineNumber = 0;
  let lineOffset = 0;
  let chunkOffset = 0;
  let fragments: string[] = [];

  return function* read({ bytes, endOfInput }: { bytes: Uint8Array, endOfInput: boolean }): IterableIterator<RgInputLine> {
    const text = decoder.decode(bytes, { stream: !endOfInput });
    let start = 0;
    let byteStart = 0;
    for (let delimiter = text.indexOf('\n', start); delimiter !== -1; delimiter = text.indexOf('\n', start)) {
      const tail = text.slice(start, delimiter);
      let line = tail;
      if (fragments.length !== 0) {
        fragments.push(tail);
        line = fragments.join('');
        fragments = [];
      }
      yield { text: line, number: ++lineNumber, byteOffset: lineOffset };
      start = delimiter + 1;
      if (trackByteOffsets) {
        // LF always decodes from one ASCII byte, including after invalid UTF-8.
        byteStart = bytes.indexOf(10, byteStart) + 1;
        lineOffset = chunkOffset + byteStart;
      }
    }
    chunkOffset += bytes.length;
    if (start < text.length) {
      fragments.push(text.slice(start));
    }
    if (endOfInput && fragments.length !== 0) {
      yield { text: fragments.join(''), number: ++lineNumber, byteOffset: lineOffset };
      fragments = [];
    }
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
