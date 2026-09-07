import { bytesToHex } from './bytes';
import type { GitFiles } from './files';
import { readFileBytes } from './files';
import type { GitRepository } from './repository';
import { joinPath } from './repository';
import { sha1Bytes } from './sha1';

export interface GitPackIndexEntry {
  objectId: string,
  offset: number,
}

export interface GitPackIndex {
  entries: GitPackIndexEntry[],
  packChecksum: string,
}

function packIndexLowerBound({ entries, objectId }: {
  entries: readonly GitPackIndexEntry[],
  objectId: string,
}): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (entries[middle]!.objectId < objectId) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function findPackIndexEntry({ packIndex, objectId }: {
  packIndex: GitPackIndex,
  objectId: string,
}): GitPackIndexEntry | undefined {
  const index = packIndexLowerBound({ entries: packIndex.entries, objectId });
  const entry = packIndex.entries[index];
  return entry?.objectId === objectId ? entry : undefined;
}

export function findPackIndexObjectIdsByPrefix({ packIndex, prefix, limit }: {
  packIndex: GitPackIndex,
  prefix: string,
  limit: number,
}): string[] {
  const matches: string[] = [];
  const start = packIndexLowerBound({ entries: packIndex.entries, objectId: prefix });
  for (let index = start; index < packIndex.entries.length && matches.length < limit; index += 1) {
    const objectId = packIndex.entries[index]!.objectId;
    if (!objectId.startsWith(prefix)) break;
    matches.push(objectId);
  }
  return matches;
}

function readUint32({ bytes, offset }: { bytes: Uint8Array, offset: number }): number {
  if (offset + 4 > bytes.byteLength) throw new Error('truncated pack index');
  return ((bytes[offset]! << 24)
    | (bytes[offset + 1]! << 16)
    | (bytes[offset + 2]! << 8)
    | bytes[offset + 3]!) >>> 0;
}

function readUint64({ bytes, offset }: { bytes: Uint8Array, offset: number }): number {
  if (offset + 8 > bytes.byteLength) throw new Error('truncated pack index large-offset table');
  let value = 0n;
  for (let index = 0; index < 8; index += 1) value = (value << 8n) | BigInt(bytes[offset + index]!);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('pack offset exceeds JavaScript safe integer range');
  return Number(value);
}

function verifyPackIndexChecksum({ bytes }: { bytes: Uint8Array }): void {
  if (bytes.byteLength < 40) throw new Error('pack index is too small');
  const indexChecksumOffset = bytes.byteLength - 20;
  const expectedIndexChecksum = bytesToHex({ bytes: bytes.subarray(indexChecksumOffset) });
  const actualIndexChecksum = bytesToHex({ bytes: sha1Bytes({ bytes: bytes.subarray(0, indexChecksumOffset) }) });
  if (actualIndexChecksum !== expectedIndexChecksum) throw new Error('pack index checksum mismatch');
}

function packIndexTrailer({ bytes }: { bytes: Uint8Array }): { packChecksum: string } {
  const packChecksumOffset = bytes.byteLength - 40;
  const indexChecksumOffset = bytes.byteLength - 20;
  return { packChecksum: bytesToHex({ bytes: bytes.subarray(packChecksumOffset, indexChecksumOffset) }) };
}

function parsePackIndexV1({ bytes }: { bytes: Uint8Array }): GitPackIndex {
  const fanoutLength = 256 * 4;
  const trailerLength = 40;
  if (bytes.byteLength < fanoutLength + trailerLength) throw new Error('pack index is too small');
  const objectCount = readUint32({ bytes, offset: 255 * 4 });
  const entryLength = 24;
  const expectedSize = fanoutLength + objectCount * entryLength + trailerLength;
  if (expectedSize !== bytes.byteLength) throw new Error('unexpected pack index size');

  const entries: GitPackIndexEntry[] = [];
  let previousObjectId: string | undefined;
  for (let index = 0; index < objectCount; index += 1) {
    const entryOffset = fanoutLength + index * entryLength;
    const offset = readUint32({ bytes, offset: entryOffset });
    const objectId = bytesToHex({ bytes: bytes.subarray(entryOffset + 4, entryOffset + 24) });
    if (previousObjectId !== undefined && previousObjectId >= objectId) throw new Error('pack index object ids are not strictly sorted');
    previousObjectId = objectId;
    entries.push({ objectId, offset });
  }

  verifyPackIndexChecksum({ bytes });
  return { entries, ...packIndexTrailer({ bytes }) };
}

function parsePackIndexV2({ bytes }: { bytes: Uint8Array }): GitPackIndex {
  if (bytes.byteLength < 8 + 256 * 4 + 40) throw new Error('pack index is too small');
  const version = readUint32({ bytes, offset: 4 });
  if (version !== 2) throw new Error(`unsupported pack index version ${version}`);
  const objectCount = readUint32({ bytes, offset: 8 + 255 * 4 });
  const oidTableOffset = 8 + 256 * 4;
  const crcTableOffset = oidTableOffset + objectCount * 20;
  const offsetTableOffset = crcTableOffset + objectCount * 4;
  const largeOffsetTableOffset = offsetTableOffset + objectCount * 4;
  const trailerLength = 40;
  if (largeOffsetTableOffset > bytes.byteLength - trailerLength) throw new Error('truncated pack index tables');

  const rawOffsets: number[] = [];
  let largestLargeOffsetIndex = -1;
  for (let index = 0; index < objectCount; index += 1) {
    const rawOffset = readUint32({ bytes, offset: offsetTableOffset + index * 4 });
    rawOffsets.push(rawOffset);
    if ((rawOffset & 0x80000000) !== 0) {
      largestLargeOffsetIndex = Math.max(largestLargeOffsetIndex, rawOffset & 0x7fffffff);
    }
  }
  const largeOffsetCount = largestLargeOffsetIndex + 1;
  const expectedSize = largeOffsetTableOffset + largeOffsetCount * 8 + trailerLength;
  if (expectedSize !== bytes.byteLength) throw new Error('unexpected pack index size');

  const entries: GitPackIndexEntry[] = [];
  let previousObjectId: string | undefined;
  for (let index = 0; index < objectCount; index += 1) {
    const objectId = bytesToHex({ bytes: bytes.subarray(oidTableOffset + index * 20, oidTableOffset + (index + 1) * 20) });
    if (previousObjectId !== undefined && previousObjectId >= objectId) throw new Error('pack index object ids are not strictly sorted');
    previousObjectId = objectId;
    const rawOffset = rawOffsets[index]!;
    const offset = (rawOffset & 0x80000000) === 0
      ? rawOffset
      : readUint64({ bytes, offset: largeOffsetTableOffset + (rawOffset & 0x7fffffff) * 8 });
    entries.push({ objectId, offset });
  }

  verifyPackIndexChecksum({ bytes });
  return { entries, ...packIndexTrailer({ bytes }) };
}

export function parsePackIndex({ bytes }: { bytes: Uint8Array }): GitPackIndex {
  const hasVersionedHeader = bytes.byteLength >= 4
    && bytes[0] === 0xff
    && bytes[1] === 0x74
    && bytes[2] === 0x4f
    && bytes[3] === 0x63;
  return hasVersionedHeader ? parsePackIndexV2({ bytes }) : parsePackIndexV1({ bytes });
}

export async function readPackIndex({ files, repository, indexFileName }: {
  files: GitFiles,
  repository: GitRepository,
  indexFileName: string,
}): Promise<GitPackIndex> {
  return parsePackIndex({
    bytes: await readFileBytes({
      files,
      path: joinPath({ base: repository.commonDirPath, child: `objects/pack/${indexFileName}` }),
    }),
  });
}

export const TEST_ONLY = {
  readUint32,
};
