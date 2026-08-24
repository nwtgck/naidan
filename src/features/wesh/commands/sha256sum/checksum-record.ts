import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';

export interface ParsedChecksumRecord {
  expectedHash: string,
  fileName: string,
  inputMode: 'binary' | 'text',
  format: 'bsd' | 'gnu',
}

export interface ChecksumLine {
  lineNumber: number,
  text: string | undefined,
}

export type ChecksumRecordParseResult =
  | { kind: 'ignored' }
  | { kind: 'malformed' }
  | { kind: 'record', record: ParsedChecksumRecord };

function combineLineParts({
  parts,
  byteLength,
}: {
  parts: Uint8Array[],
  byteLength: number,
}): Uint8Array {
  if (parts.length === 1) {
    return parts[0]!;
  }

  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export async function* iterateChecksumLines({
  stream,
}: {
  stream: ReadableStream<Uint8Array>,
}): AsyncIterable<ChecksumLine> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let parts: Uint8Array[] = [];
  let byteLength = 0;
  let lineNumber = 0;

  const finishLine = (): ChecksumLine => {
    lineNumber += 1;
    let bytes = combineLineParts({ parts, byteLength });
    parts = [];
    byteLength = 0;
    if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 0x0d) {
      bytes = bytes.subarray(0, bytes.byteLength - 1);
    }

    try {
      return {
        lineNumber,
        text: decoder.decode(bytes),
      };
    } catch {
      return {
        lineNumber,
        text: undefined,
      };
    }
  };

  for await (const chunk of iterateReadableStreamChunks({ stream })) {
    let segmentStart = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) {
        continue;
      }

      if (index > segmentStart) {
        const segment = chunk.subarray(segmentStart, index);
        parts.push(segment);
        byteLength += segment.byteLength;
      }
      yield finishLine();
      segmentStart = index + 1;
    }

    if (segmentStart < chunk.byteLength) {
      const segment = chunk.subarray(segmentStart);
      parts.push(segment);
      byteLength += segment.byteLength;
    }
  }

  if (byteLength > 0) {
    yield finishLine();
  }
}

function isHexHash({ value }: { value: string }): boolean {
  return /^[0-9a-fA-F]{64}$/u.test(value);
}

function unescapeFileName({ value }: { value: string }): string | undefined {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '\\') {
      result += character;
      continue;
    }

    index += 1;
    if (index >= value.length) {
      return undefined;
    }

    const escaped = value[index];
    switch (escaped) {
    case '\\':
      result += '\\';
      break;
    case 'n':
      result += '\n';
      break;
    case 'r':
      result += '\r';
      break;
    default:
      return undefined;
    }
  }
  return result;
}


function decodeFileName({
  encodedFileName,
  escaped,
}: {
  encodedFileName: string,
  escaped: 'escaped' | 'plain',
}): string | undefined {
  switch (escaped) {
  case 'escaped':
    return unescapeFileName({ value: encodedFileName });
  case 'plain':
    return encodedFileName;
  default: {
    const _ex: never = escaped;
    throw new Error(`Unhandled escape mode: ${_ex}`);
  }
  }
}

function parseGnuRecord({
  line,
  escaped,
}: {
  line: string,
  escaped: 'escaped' | 'plain',
}): ParsedChecksumRecord | undefined {
  if (line.length < 66) {
    return undefined;
  }

  const expectedHash = line.slice(0, 64);
  const checksumSeparator = line[64];
  if (
    !isHexHash({ value: expectedHash })
    || (checksumSeparator !== ' ' && checksumSeparator !== '\t')
  ) {
    return undefined;
  }

  let fileNameOffset = 65;
  let inputMode: 'binary' | 'text' = 'text';
  if (line.length > 66) {
    switch (line[65]) {
    case '*':
      inputMode = 'binary';
      fileNameOffset = 66;
      break;
    case ' ':
      inputMode = 'text';
      fileNameOffset = 66;
      break;
    default:
      break;
    }
  }

  const encodedFileName = line.slice(fileNameOffset);
  const fileName = decodeFileName({ encodedFileName, escaped });
  if (fileName === undefined) {
    return undefined;
  }

  return {
    expectedHash: expectedHash.toLowerCase(),
    fileName,
    inputMode,
    format: 'gnu',
  };
}

function parseBsdRecord({
  line,
  escaped,
}: {
  line: string,
  escaped: 'escaped' | 'plain',
}): ParsedChecksumRecord | undefined {
  const prefix = 'SHA256 (';
  const separator = ') = ';
  if (!line.startsWith(prefix) || line.length < prefix.length + separator.length + 64) {
    return undefined;
  }

  const hashOffset = line.length - 64;
  const separatorOffset = hashOffset - separator.length;
  if (line.slice(separatorOffset, hashOffset) !== separator) {
    return undefined;
  }

  const expectedHash = line.slice(hashOffset);
  if (!isHexHash({ value: expectedHash })) {
    return undefined;
  }

  const encodedFileName = line.slice(prefix.length, separatorOffset);
  const fileName = decodeFileName({ encodedFileName, escaped });
  if (fileName === undefined) {
    return undefined;
  }

  return {
    expectedHash: expectedHash.toLowerCase(),
    fileName,
    inputMode: 'text',
    format: 'bsd',
  };
}

export function parseChecksumRecord({
  text,
}: {
  text: string,
}): ChecksumRecordParseResult {
  if (text.length === 0 || text.startsWith('#')) {
    return { kind: 'ignored' };
  }

  const candidate = text.replace(/^[ \t]+/u, '');
  const hasEscapeMarker = candidate.startsWith('\\');
  const escaped: 'escaped' | 'plain' = hasEscapeMarker ? 'escaped' : 'plain';
  const line = hasEscapeMarker ? candidate.slice(1) : candidate;
  const gnuRecord = parseGnuRecord({ line, escaped });
  if (gnuRecord !== undefined) {
    return { kind: 'record', record: gnuRecord };
  }

  const bsdRecord = parseBsdRecord({ line, escaped });
  if (bsdRecord !== undefined) {
    return { kind: 'record', record: bsdRecord };
  }

  return { kind: 'malformed' };
}

export function escapeChecksumFileName({
  fileName,
}: {
  fileName: string,
}): {
  escaped: 'escaped' | 'plain',
  value: string,
} {
  let value = '';
  let escaped: 'escaped' | 'plain' = 'plain';
  for (const character of fileName) {
    switch (character) {
    case '\\':
      value += '\\\\';
      escaped = 'escaped';
      break;
    case '\n':
      value += '\\n';
      escaped = 'escaped';
      break;
    case '\r':
      value += '\\r';
      escaped = 'escaped';
      break;
    default:
      value += character;
      break;
    }
  }
  return { escaped, value };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
