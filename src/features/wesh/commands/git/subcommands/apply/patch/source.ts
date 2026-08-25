import type { WeshCommandContext } from '@/features/wesh/types';
import { readAllFileBytes } from '@/features/wesh/utils/fs';
import type {
  PatchLine,
  PatchLineSource,
  PatchWhitespaceMode,
} from './types';

const INDEX_CHUNK_SIZE = 64 * 1024;
const COPY_CHUNK_SIZE = 64 * 1024;
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const LINE_CACHE_ENTRY_LIMIT = 64;
const LINE_CACHE_BYTE_LIMIT = 1024 * 1024;

class ChunkedFloat64Index {
  private readonly chunks: Float64Array[] = [];
  private lengthValue = 0;

  push({ value }: { value: number }): void {
    const chunkIndex = Math.floor(this.lengthValue / INDEX_CHUNK_SIZE);
    const indexInChunk = this.lengthValue % INDEX_CHUNK_SIZE;
    let chunk = this.chunks[chunkIndex];
    if (chunk === undefined) {
      chunk = new Float64Array(INDEX_CHUNK_SIZE);
      this.chunks.push(chunk);
    }
    chunk[indexInChunk] = value;
    this.lengthValue += 1;
  }

  get({ index }: { index: number }): number {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.lengthValue) {
      throw new Error(`line index is out of range: ${index}`);
    }
    const chunk = this.chunks[Math.floor(index / INDEX_CHUNK_SIZE)];
    if (chunk === undefined) throw new Error(`missing line offset chunk for index ${index}`);
    return chunk[index % INDEX_CHUNK_SIZE]!;
  }

  get length(): number {
    return this.lengthValue;
  }
}

class ChunkedUint32Index {
  private readonly chunks: Uint32Array[] = [];
  private lengthValue = 0;

  push({ value }: { value: number }): void {
    const chunkIndex = Math.floor(this.lengthValue / INDEX_CHUNK_SIZE);
    const indexInChunk = this.lengthValue % INDEX_CHUNK_SIZE;
    let chunk = this.chunks[chunkIndex];
    if (chunk === undefined) {
      chunk = new Uint32Array(INDEX_CHUNK_SIZE);
      this.chunks.push(chunk);
    }
    chunk[indexInChunk] = value;
    this.lengthValue += 1;
  }

  get({ index }: { index: number }): number {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.lengthValue) {
      throw new Error(`line hash index is out of range: ${index}`);
    }
    const chunk = this.chunks[Math.floor(index / INDEX_CHUNK_SIZE)];
    if (chunk === undefined) throw new Error(`missing line hash chunk for index ${index}`);
    return chunk[index % INDEX_CHUNK_SIZE]!;
  }
}

class ChunkedUint8Index {
  private readonly chunks: Uint8Array[] = [];
  private lengthValue = 0;

  push({ value }: { value: number }): void {
    const chunkIndex = Math.floor(this.lengthValue / INDEX_CHUNK_SIZE);
    const indexInChunk = this.lengthValue % INDEX_CHUNK_SIZE;
    let chunk = this.chunks[chunkIndex];
    if (chunk === undefined) {
      chunk = new Uint8Array(INDEX_CHUNK_SIZE);
      this.chunks.push(chunk);
    }
    chunk[indexInChunk] = value;
    this.lengthValue += 1;
  }

  get({ index }: { index: number }): number {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.lengthValue) {
      throw new Error(`line terminator index is out of range: ${index}`);
    }
    const chunk = this.chunks[Math.floor(index / INDEX_CHUNK_SIZE)];
    if (chunk === undefined) throw new Error(`missing line terminator chunk for index ${index}`);
    return chunk[index % INDEX_CHUNK_SIZE]!;
  }
}

function updateHash({ hash, value }: { hash: number, value: number }): number {
  return Math.imul(hash ^ value, FNV_PRIME) >>> 0;
}

function isHorizontalBlank({ value }: { value: number }): boolean {
  return value === 0x20 || value === 0x09;
}

function hashBytes({
  bytes,
  whitespaceMode,
}: {
  bytes: Uint8Array,
  whitespaceMode: PatchWhitespaceMode,
}): number {
  let hash = FNV_OFFSET_BASIS;
  let inBlankRun = false;

  for (const value of bytes) {
    switch (whitespaceMode) {
    case 'exact':
      hash = updateHash({ hash, value });
      break;
    case 'ignore-changes':
      if (isHorizontalBlank({ value })) {
        inBlankRun = true;
      } else {
        if (inBlankRun) hash = updateHash({ hash, value: 0x20 });
        inBlankRun = false;
        hash = updateHash({ hash, value });
      }
      break;
    default: {
      const _ex: never = whitespaceMode;
      throw new Error(`Unhandled whitespace mode: ${_ex}`);
    }
    }
  }

  return hash;
}

function bytesEqual({ left, right }: { left: Uint8Array, right: Uint8Array }): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function bytesEqualIgnoringWhitespaceChanges({
  left,
  right,
}: {
  left: Uint8Array,
  right: Uint8Array,
}): boolean {
  let leftEnd = left.byteLength;
  while (leftEnd > 0 && isHorizontalBlank({ value: left[leftEnd - 1]! })) leftEnd -= 1;
  let rightEnd = right.byteLength;
  while (rightEnd > 0 && isHorizontalBlank({ value: right[rightEnd - 1]! })) rightEnd -= 1;

  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < leftEnd && rightIndex < rightEnd) {
    const leftBlank = isHorizontalBlank({ value: left[leftIndex]! });
    const rightBlank = isHorizontalBlank({ value: right[rightIndex]! });
    if (leftBlank || rightBlank) {
      if (!leftBlank || !rightBlank) return false;
      while (leftIndex < leftEnd && isHorizontalBlank({ value: left[leftIndex]! })) leftIndex += 1;
      while (rightIndex < rightEnd && isHorizontalBlank({ value: right[rightIndex]! })) rightIndex += 1;
      continue;
    }

    if (left[leftIndex] !== right[rightIndex]) return false;
    leftIndex += 1;
    rightIndex += 1;
  }

  return leftIndex === leftEnd && rightIndex === rightEnd;
}

interface LineIndexData {
  starts: ChunkedFloat64Index,
  exactHashes: ChunkedUint32Index,
  whitespaceHashes: ChunkedUint32Index,
  terminators: ChunkedUint8Index,
  lineCount: number,
}

async function buildLineIndex({ blob }: { blob: Blob }): Promise<LineIndexData> {
  const starts = new ChunkedFloat64Index();
  const exactHashes = new ChunkedUint32Index();
  const whitespaceHashes = new ChunkedUint32Index();
  const terminators = new ChunkedUint8Index();
  starts.push({ value: 0 });

  let exactHash = FNV_OFFSET_BASIS;
  let whitespaceHash = FNV_OFFSET_BASIS;
  let whitespaceRun = false;
  let currentLineStart = 0;
  let lineCount = 0;

  for (let chunkStart = 0; chunkStart < blob.size; chunkStart += COPY_CHUNK_SIZE) {
    const chunkEnd = Math.min(blob.size, chunkStart + COPY_CHUNK_SIZE);
    const value = new Uint8Array(await blob.slice(chunkStart, chunkEnd).arrayBuffer());

    for (let index = 0; index < value.byteLength; index++) {
      const byte = value[index]!;
      if (byte === 0x0a) {
        exactHashes.push({ value: exactHash });
        whitespaceHashes.push({ value: whitespaceHash });
        terminators.push({ value: 1 });
        lineCount += 1;
        currentLineStart = chunkStart + index + 1;
        starts.push({ value: currentLineStart });
        exactHash = FNV_OFFSET_BASIS;
        whitespaceHash = FNV_OFFSET_BASIS;
        whitespaceRun = false;
        continue;
      }

      exactHash = updateHash({ hash: exactHash, value: byte });
      if (isHorizontalBlank({ value: byte })) {
        whitespaceRun = true;
      } else {
        if (whitespaceRun) whitespaceHash = updateHash({ hash: whitespaceHash, value: 0x20 });
        whitespaceRun = false;
        whitespaceHash = updateHash({ hash: whitespaceHash, value: byte });
      }
    }
  }

  if (currentLineStart < blob.size) {
    exactHashes.push({ value: exactHash });
    whitespaceHashes.push({ value: whitespaceHash });
    terminators.push({ value: 0 });
    lineCount += 1;
    starts.push({ value: blob.size });
  } else if (starts.get({ index: starts.length - 1 }) !== blob.size) {
    starts.push({ value: blob.size });
  }

  return {
    starts,
    exactHashes,
    whitespaceHashes,
    terminators,
    lineCount,
  };
}

class BlobPatchLineSource implements PatchLineSource {
  readonly byteLength: number;
  readonly lineCount: number;
  private readonly blob: Blob;
  private readonly starts: ChunkedFloat64Index;
  private readonly exactHashes: ChunkedUint32Index;
  private readonly whitespaceHashes: ChunkedUint32Index;
  private readonly terminators: ChunkedUint8Index;
  private readonly patchHashCache = new WeakMap<PatchLine, { exact: number, whitespace: number }>();
  private readonly lineCache = new Map<number, Uint8Array>();
  private lineCacheBytes = 0;

  constructor({
    blob,
    index,
  }: {
    blob: Blob,
    index: LineIndexData,
  }) {
    this.blob = blob;
    this.byteLength = blob.size;
    this.lineCount = index.lineCount;
    this.starts = index.starts;
    this.exactHashes = index.exactHashes;
    this.whitespaceHashes = index.whitespaceHashes;
    this.terminators = index.terminators;
  }

  boundaryOffset({ lineIndex }: { lineIndex: number }): number {
    if (!Number.isSafeInteger(lineIndex) || lineIndex < 0 || lineIndex > this.lineCount) {
      throw new Error(`line boundary is out of range: ${lineIndex}`);
    }
    return this.starts.get({ index: lineIndex });
  }

  private getPatchHashes({ patchLine }: { patchLine: PatchLine }): { exact: number, whitespace: number } {
    const cached = this.patchHashCache.get(patchLine);
    if (cached !== undefined) return cached;
    const hashes = {
      exact: hashBytes({ bytes: patchLine.content, whitespaceMode: 'exact' }),
      whitespace: hashBytes({ bytes: patchLine.content, whitespaceMode: 'ignore-changes' }),
    };
    this.patchHashCache.set(patchLine, hashes);
    return hashes;
  }

  private async readLineBytes({ lineIndex }: { lineIndex: number }): Promise<Uint8Array> {
    const cached = this.lineCache.get(lineIndex);
    if (cached !== undefined) {
      this.lineCache.delete(lineIndex);
      this.lineCache.set(lineIndex, cached);
      return cached;
    }

    const start = this.boundaryOffset({ lineIndex });
    const boundaryEnd = this.boundaryOffset({ lineIndex: lineIndex + 1 });
    const terminatorLength = this.terminators.get({ index: lineIndex }) === 1 ? 1 : 0;
    const contentEnd = boundaryEnd - terminatorLength;
    const bytes = new Uint8Array(await this.blob.slice(start, contentEnd).arrayBuffer());

    if (bytes.byteLength <= LINE_CACHE_BYTE_LIMIT) {
      this.lineCache.set(lineIndex, bytes);
      this.lineCacheBytes += bytes.byteLength;
      while (
        this.lineCache.size > LINE_CACHE_ENTRY_LIMIT
        || this.lineCacheBytes > LINE_CACHE_BYTE_LIMIT
      ) {
        const first = this.lineCache.entries().next().value as [number, Uint8Array] | undefined;
        if (first === undefined) break;
        this.lineCache.delete(first[0]);
        this.lineCacheBytes -= first[1].byteLength;
      }
    }

    return bytes;
  }

  async lineMatches({
    lineIndex,
    patchLine,
    whitespaceMode,
  }: {
    lineIndex: number,
    patchLine: PatchLine,
    whitespaceMode: PatchWhitespaceMode,
  }): Promise<boolean> {
    if (lineIndex < 0 || lineIndex >= this.lineCount) return false;
    const sourceTerminator = this.terminators.get({ index: lineIndex }) === 1 ? 'lf' : 'none';
    if (sourceTerminator !== patchLine.terminator) return false;

    const patchHashes = this.getPatchHashes({ patchLine });
    switch (whitespaceMode) {
    case 'exact':
      if (this.exactHashes.get({ index: lineIndex }) !== patchHashes.exact) return false;
      return bytesEqual({ left: await this.readLineBytes({ lineIndex }), right: patchLine.content });
    case 'ignore-changes':
      if (this.whitespaceHashes.get({ index: lineIndex }) !== patchHashes.whitespace) return false;
      return bytesEqualIgnoringWhitespaceChanges({
        left: await this.readLineBytes({ lineIndex }),
        right: patchLine.content,
      });
    default: {
      const _ex: never = whitespaceMode;
      throw new Error(`Unhandled whitespace mode: ${_ex}`);
    }
    }
  }

  async forEachChunk({
    start,
    end,
    consume,
  }: {
    start: number,
    end: number,
    consume({ chunk }: { chunk: Uint8Array }): Promise<void>,
  }): Promise<void> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > this.byteLength) {
      throw new Error(`invalid source byte range: ${start}..${end}`);
    }
    if (start === end) return;

    for (let chunkStart = start; chunkStart < end; chunkStart += COPY_CHUNK_SIZE) {
      const chunkEnd = Math.min(end, chunkStart + COPY_CHUNK_SIZE);
      await consume({
        chunk: new Uint8Array(await this.blob.slice(chunkStart, chunkEnd).arrayBuffer()),
      });
    }
  }
}

export async function createPatchLineSourceFromBlob({ blob }: { blob: Blob }): Promise<PatchLineSource> {
  return new BlobPatchLineSource({
    blob,
    index: await buildLineIndex({ blob }),
  });
}

export async function createPatchLineSourceFromBytes({ bytes }: { bytes: Uint8Array }): Promise<PatchLineSource> {
  const ownedBytes = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);
  return createPatchLineSourceFromBlob({ blob: new Blob([ownedBytes.buffer]) });
}

export async function createPatchLineSourceFromPath({
  context,
  path,
}: {
  context: WeshCommandContext,
  path: string,
}): Promise<PatchLineSource> {
  const blobResult = await context.files.tryReadBlobEfficiently({ path });
  switch (blobResult.kind) {
  case 'blob':
    return createPatchLineSourceFromBlob({ blob: blobResult.blob });
  case 'fallback_required':
    return createPatchLineSourceFromBytes({
      bytes: await readAllFileBytes({ files: context.files, path }),
    });
  default: {
    const _ex: never = blobResult;
    throw new Error(`Unhandled blob result: ${JSON.stringify(_ex)}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
