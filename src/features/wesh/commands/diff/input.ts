import { resolvePath } from '@/features/wesh/path';
import type { WeshCommandContext, WeshFileHandle, WeshStat } from '@/features/wesh/types';
import { readAllFileBytes } from '@/features/wesh/utils/fs';
import type { DiffComparisonOptions, DiffInput, DiffLineTable } from './model';

const MAX_TYPED_ARRAY_INDEX = 0xFFFF_FFFF;
const BINARY_PROBE_BYTE_COUNT = 32 * 1024;
const STREAM_READ_CHUNK_SIZE = 64 * 1024;

function countLines({ bytes }: { bytes: Uint8Array }): number {
  if (bytes.byteLength === 0) {
    return 0;
  }

  let count = 0;
  for (const byte of bytes) {
    if (byte === 0x0A) {
      count++;
    }
  }
  if (bytes[bytes.byteLength - 1] !== 0x0A) {
    count++;
  }
  return count;
}

export function createLineTable({ bytes }: { bytes: Uint8Array }): DiffLineTable {
  if (bytes.byteLength > MAX_TYPED_ARRAY_INDEX) {
    throw new Error('input is too large to index safely');
  }

  const lineCount = countLines({ bytes });
  const starts = new Uint32Array(lineCount);
  const ends = new Uint32Array(lineCount);
  const hasLineFeed = new Uint8Array(lineCount);
  let lineIndex = 0;
  let lineStart = 0;

  for (let byteIndex = 0; byteIndex < bytes.byteLength; byteIndex++) {
    if (bytes[byteIndex] !== 0x0A) {
      continue;
    }
    starts[lineIndex] = lineStart;
    ends[lineIndex] = byteIndex;
    hasLineFeed[lineIndex] = 1;
    lineIndex++;
    lineStart = byteIndex + 1;
  }

  if (lineStart < bytes.byteLength) {
    starts[lineIndex] = lineStart;
    ends[lineIndex] = bytes.byteLength;
    hasLineFeed[lineIndex] = 0;
  }

  return {
    bytes,
    starts,
    ends,
    hasLineFeed,
  };
}

export function createDiffInput({
  displayName,
  resolvedPath,
  mtime,
  bytes,
}: {
  displayName: string,
  resolvedPath: string | undefined,
  mtime: number | undefined,
  bytes: Uint8Array,
}): DiffInput {
  return {
    displayName,
    resolvedPath,
    mtime,
    lines: createLineTable({ bytes }),
  };
}

async function readAllHandleBytes({ handle }: { handle: WeshFileHandle }): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const buffer = new Uint8Array(STREAM_READ_CHUNK_SIZE);
    const { bytesRead } = await handle.read({ buffer });
    if (bytesRead === 0) {
      break;
    }
    const chunk = buffer.slice(0, bytesRead);
    chunks.push(chunk);
    totalLength += chunk.byteLength;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readStdinBytes({ context }: { context: WeshCommandContext }): Promise<Uint8Array> {
  return await readAllHandleBytes({ handle: context.stdin });
}

export async function readFileInput({
  context,
  operand,
}: {
  context: WeshCommandContext,
  operand: string,
}): Promise<{ input: DiffInput, stat: WeshStat }> {
  const resolvedPath = resolvePath({ cwd: context.cwd, path: operand });
  const stat = await context.files.stat({ path: resolvedPath });
  switch (stat.type) {
  case 'file':
    break;
  case 'directory':
    throw new Error('Is a directory');
  case 'fifo':
  case 'chardev':
  case 'symlink':
    throw new Error(`unsupported file type: ${stat.type}`);
  default: {
    const _ex: never = stat.type;
    throw new Error(`Unhandled file type: ${_ex}`);
  }
  }
  const bytes = await readAllFileBytes({ files: context.files, path: resolvedPath });
  return {
    input: createDiffInput({
      displayName: operand,
      resolvedPath,
      mtime: stat.mtime,
      bytes,
    }),
    stat,
  };
}

export function areBytesIdentical({ left, right }: { left: Uint8Array, right: Uint8Array }): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

export function isBinaryInput({ input }: { input: DiffInput }): boolean {
  const bytes = input.lines.bytes;
  const end = Math.min(bytes.byteLength, BINARY_PROBE_BYTE_COUNT);
  for (let index = 0; index < end; index++) {
    if (bytes[index] === 0) {
      return true;
    }
  }
  return false;
}

export function getLineContentEnd({
  input,
  lineIndex,
  stripTrailingCarriageReturn,
}: {
  input: DiffInput,
  lineIndex: number,
  stripTrailingCarriageReturn: boolean,
}): number {
  const end = input.lines.ends[lineIndex];
  if (end === undefined) {
    throw new Error(`line index out of range: ${lineIndex}`);
  }
  if (
    stripTrailingCarriageReturn
    && input.lines.hasLineFeed[lineIndex] === 1
    && end > input.lines.starts[lineIndex]!
    && input.lines.bytes[end - 1] === 0x0D
  ) {
    return end - 1;
  }
  return end;
}

export function getLineBytes({
  input,
  lineIndex,
  stripTrailingCarriageReturn,
}: {
  input: DiffInput,
  lineIndex: number,
  stripTrailingCarriageReturn: boolean,
}): Uint8Array {
  const start = input.lines.starts[lineIndex];
  if (start === undefined) {
    throw new Error(`line index out of range: ${lineIndex}`);
  }
  const end = getLineContentEnd({ input, lineIndex, stripTrailingCarriageReturn });
  return input.lines.bytes.subarray(start, end);
}

function isComparisonWhitespace({ byte }: { byte: number }): boolean {
  return byte === 0x09
    || byte === 0x0B
    || byte === 0x0C
    || byte === 0x0D
    || byte === 0x20;
}

function normalizeLineBytes({
  bytes,
  options,
}: {
  bytes: Uint8Array,
  options: DiffComparisonOptions,
}): Uint8Array {
  let values: number[] = [];
  let column = 0;
  for (const byte of bytes) {
    if (options.ignoreTabExpansion && byte === 0x09) {
      const spaces = options.tabSize - (column % options.tabSize);
      for (let index = 0; index < spaces; index++) values.push(0x20);
      column += spaces;
    } else {
      values.push(byte);
      column++;
    }
  }

  if (options.ignoreAllSpace) {
    values = values.filter((byte) => !isComparisonWhitespace({ byte }));
  } else if (options.ignoreSpaceChange) {
    const collapsed: number[] = [];
    let pendingWhitespace = false;
    for (const byte of values) {
      if (isComparisonWhitespace({ byte })) {
        pendingWhitespace = true;
        continue;
      }
      if (pendingWhitespace) collapsed.push(0x20);
      collapsed.push(byte);
      pendingWhitespace = false;
    }
    values = collapsed;
  } else if (options.ignoreTrailingSpace) {
    while (values.length > 0 && isComparisonWhitespace({ byte: values[values.length - 1]! })) {
      values.pop();
    }
  }

  if (options.ignoreCase) {
    values = values.map((byte) => byte >= 0x41 && byte <= 0x5A ? byte + 0x20 : byte);
  }
  return Uint8Array.from(values);
}

function requiresByteNormalization({ options }: { options: DiffComparisonOptions }): boolean {
  return options.ignoreCase
    || options.ignoreTabExpansion
    || options.ignoreTrailingSpace
    || options.ignoreSpaceChange
    || options.ignoreAllSpace;
}

function hashBytes({ bytes }: { bytes: Uint8Array }): number {
  let hash = 0x811C9DC5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

interface ComparableLines {
  readonly hashes: Uint32Array,
  readonly normalized: readonly Uint8Array[] | undefined,
}

function createComparableLines({
  input,
  options,
}: {
  input: DiffInput,
  options: DiffComparisonOptions,
}): ComparableLines {
  const count = input.lines.starts.length;
  const hashes = new Uint32Array(count);
  const normalized = requiresByteNormalization({ options }) ? new Array<Uint8Array>(count) : undefined;

  for (let lineIndex = 0; lineIndex < count; lineIndex++) {
    const bytes = getLineBytes({
      input,
      lineIndex,
      stripTrailingCarriageReturn: options.stripTrailingCarriageReturn,
    });
    if (normalized === undefined) {
      hashes[lineIndex] = hashBytes({ bytes });
      continue;
    }
    const value = normalizeLineBytes({ bytes, options });
    normalized[lineIndex] = value;
    hashes[lineIndex] = hashBytes({ bytes: value });
  }

  return { hashes, normalized };
}

export function createLineComparator({
  left,
  right,
  options,
}: {
  left: DiffInput,
  right: DiffInput,
  options: DiffComparisonOptions,
}): ({ leftIndex, rightIndex }: { leftIndex: number, rightIndex: number }) => boolean {
  const leftComparable = createComparableLines({ input: left, options });
  const rightComparable = createComparableLines({ input: right, options });

  return ({ leftIndex, rightIndex }): boolean => {
    if (left.lines.hasLineFeed[leftIndex] !== right.lines.hasLineFeed[rightIndex]) {
      return false;
    }
    if (leftComparable.hashes[leftIndex] !== rightComparable.hashes[rightIndex]) {
      return false;
    }
    if (leftComparable.normalized !== undefined && rightComparable.normalized !== undefined) {
      const leftNormalized = leftComparable.normalized[leftIndex];
      const rightNormalized = rightComparable.normalized[rightIndex];
      if (leftNormalized === undefined || rightNormalized === undefined) return false;
      return areBytesIdentical({ left: leftNormalized, right: rightNormalized });
    }
    return areBytesIdentical({
      left: getLineBytes({ input: left, lineIndex: leftIndex, stripTrailingCarriageReturn: options.stripTrailingCarriageReturn }),
      right: getLineBytes({ input: right, lineIndex: rightIndex, stripTrailingCarriageReturn: options.stripTrailingCarriageReturn }),
    });
  };
}

export function decodeLine({
  input,
  lineIndex,
  stripTrailingCarriageReturn,
}: {
  input: DiffInput,
  lineIndex: number,
  stripTrailingCarriageReturn: boolean,
}): string {
  return new TextDecoder().decode(getLineBytes({ input, lineIndex, stripTrailingCarriageReturn }));
}

export function isBlankLine({
  input,
  lineIndex,
  stripTrailingCarriageReturn,
}: {
  input: DiffInput,
  lineIndex: number,
  stripTrailingCarriageReturn: boolean,
}): boolean {
  return /^[\t\v\f\r ]*$/u.test(decodeLine({ input, lineIndex, stripTrailingCarriageReturn }));
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  BINARY_PROBE_BYTE_COUNT,
  normalizeLineBytes,
};
