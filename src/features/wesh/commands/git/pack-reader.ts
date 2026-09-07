import { bytesToHex } from './bytes';
import type { GitFiles } from './files';
import { fileSize, pathExists, readFileRange } from './files';
import type { GitObject, GitObjectType } from './object-format';
import { readOffsetVariableWidth } from './offset-varint';
import { objectIdFor } from './object-format';
import { readPackIndex } from './pack-index';
import { findPackIndexEntry } from './pack-index';
import type { GitPackIndex } from './pack-index';
import type { GitRepository } from './repository';
import { joinPath } from './repository';
import { inflateZlib } from './zlib';

interface PackContext {
  files: GitFiles,
  repository: GitRepository,
  packPath: string,
  packIndex: GitPackIndex,
  entriesByOffset: GitPackIndex['entries'],
  packDataEnd: number,
}

export interface GitPackReadCache {
  repositoryCommonDirPath: string | undefined,
  indexFileNames: Promise<readonly string[]> | undefined,
  contextsByIndexFileName: Map<string, Promise<PackContext>>,
}

export function createGitPackReadCache(): GitPackReadCache {
  return {
    repositoryCommonDirPath: undefined,
    indexFileNames: undefined,
    contextsByIndexFileName: new Map(),
  };
}

function readPackObjectHeader({ bytes }: { bytes: Uint8Array }): {
  typeCode: number,
  size: number,
  dataOffset: number,
} {
  if (bytes.byteLength === 0) throw new Error('truncated pack object header');
  let byte = bytes[0]!;
  const typeCode = (byte >>> 4) & 0x7;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = 1;
  while ((byte & 0x80) !== 0) {
    if (offset >= bytes.byteLength) throw new Error('truncated pack object size');
    byte = bytes[offset]!;
    offset += 1;
    size += (byte & 0x7f) * (2 ** shift);
    if (!Number.isSafeInteger(size)) throw new Error('pack object size exceeds JavaScript safe integer range');
    shift += 7;
  }
  return { typeCode, size, dataOffset: offset };
}

function typeFromPackCode({ typeCode }: { typeCode: number }): GitObjectType {
  switch (typeCode) {
  case 1:
    return 'commit';
  case 2:
    return 'tree';
  case 3:
    return 'blob';
  case 4:
    return 'tag';
  default:
    throw new Error(`unsupported non-delta pack object type ${typeCode}`);
  }
}

function readOffsetDeltaBase({ bytes, offset, objectOffset }: {
  bytes: Uint8Array,
  offset: number,
  objectOffset: number,
}): { baseOffset: number, dataOffset: number } {
  const encodedDistance = readOffsetVariableWidth({
    bytes,
    offset,
    label: 'OFS_DELTA base offset',
  });
  const baseOffset = objectOffset - encodedDistance.value;
  if (baseOffset < 12) throw new Error('invalid OFS_DELTA base offset');
  return { baseOffset, dataOffset: encodedDistance.offset };
}

function readDeltaVarint({ bytes, offset }: { bytes: Uint8Array, offset: number }): {
  value: number,
  offset: number,
} {
  let value = 0;
  let shift = 0;
  while (true) {
    if (offset >= bytes.byteLength) throw new Error('truncated delta varint');
    const byte = bytes[offset]!;
    offset += 1;
    value += (byte & 0x7f) * (2 ** shift);
    if (!Number.isSafeInteger(value)) throw new Error('delta size exceeds JavaScript safe integer range');
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
}

export function applyGitDelta({ base, delta }: {
  base: Uint8Array,
  delta: Uint8Array,
}): Uint8Array {
  let offset = 0;
  const baseSizeResult = readDeltaVarint({ bytes: delta, offset });
  offset = baseSizeResult.offset;
  if (baseSizeResult.value !== base.byteLength) throw new Error('delta base size mismatch');
  const resultSizeResult = readDeltaVarint({ bytes: delta, offset });
  offset = resultSizeResult.offset;
  const output = new Uint8Array(resultSizeResult.value);
  let outputOffset = 0;

  while (offset < delta.byteLength) {
    const opcode = delta[offset]!;
    offset += 1;
    if ((opcode & 0x80) === 0) {
      const insertLength = opcode & 0x7f;
      if (insertLength === 0) throw new Error('invalid zero delta opcode');
      if (offset + insertLength > delta.byteLength || outputOffset + insertLength > output.byteLength) {
        throw new Error('delta insert exceeds bounds');
      }
      output.set(delta.subarray(offset, offset + insertLength), outputOffset);
      offset += insertLength;
      outputOffset += insertLength;
      continue;
    }

    let copyOffset = 0;
    let copySize = 0;
    let offsetShift = 0;
    for (const mask of [0x01, 0x02, 0x04, 0x08]) {
      if ((opcode & mask) !== 0) {
        if (offset >= delta.byteLength) throw new Error('truncated delta copy offset');
        copyOffset += delta[offset]! * (2 ** offsetShift);
        offset += 1;
      }
      offsetShift += 8;
    }
    let sizeShift = 0;
    for (const mask of [0x10, 0x20, 0x40]) {
      if ((opcode & mask) !== 0) {
        if (offset >= delta.byteLength) throw new Error('truncated delta copy size');
        copySize += delta[offset]! * (2 ** sizeShift);
        offset += 1;
      }
      sizeShift += 8;
    }
    if (copySize === 0) copySize = 0x10000;
    if (copyOffset + copySize > base.byteLength || outputOffset + copySize > output.byteLength) {
      throw new Error('delta copy exceeds bounds');
    }
    output.set(base.subarray(copyOffset, copyOffset + copySize), outputOffset);
    outputOffset += copySize;
  }

  if (outputOffset !== output.byteLength) throw new Error('delta result size mismatch');
  return output;
}

function packObjectRange({ context, objectOffset }: {
  context: PackContext,
  objectOffset: number,
}): { objectId: string, endOffset: number } {
  let low = 0;
  let high = context.entriesByOffset.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const offset = context.entriesByOffset[middle]!.offset;
    if (offset < objectOffset) low = middle + 1;
    else high = middle;
  }
  const entry = context.entriesByOffset[low];
  if (entry?.offset !== objectOffset) throw new Error(`pack index does not contain object offset ${objectOffset}`);
  return {
    objectId: entry.objectId,
    endOffset: context.entriesByOffset[low + 1]?.offset ?? context.packDataEnd,
  };
}

async function readPackObjectAtOffset({ context, objectOffset, depth, readExternalObject }: {
  context: PackContext,
  objectOffset: number,
  depth: number,
  readExternalObject({ objectId }: { objectId: string }): Promise<GitObject>,
}): Promise<GitObject> {
  if (depth > 128) throw new Error('pack delta chain is too deep');
  const range = packObjectRange({ context, objectOffset });
  const endOffset = range.endOffset;
  if (endOffset <= objectOffset) throw new Error('invalid pack object offsets');
  const raw = await readFileRange({
    files: context.files,
    path: context.packPath,
    position: objectOffset,
    length: endOffset - objectOffset,
  });
  if (raw.byteLength !== endOffset - objectOffset) throw new Error('truncated pack object');
  const header = readPackObjectHeader({ bytes: raw });
  let dataOffset = header.dataOffset;
  let baseByOffset: number | undefined;
  let baseByObjectId: string | undefined;
  switch (header.typeCode) {
  case 6: {
    const base = readOffsetDeltaBase({ bytes: raw, offset: dataOffset, objectOffset });
    baseByOffset = base.baseOffset;
    dataOffset = base.dataOffset;
    break;
  }
  case 7:
    if (dataOffset + 20 > raw.byteLength) throw new Error('truncated REF_DELTA base object id');
    baseByObjectId = bytesToHex({ bytes: raw.subarray(dataOffset, dataOffset + 20) });
    dataOffset += 20;
    break;
  default:
    break;
  }

  const inflated = await inflateZlib({ bytes: raw.subarray(dataOffset) });
  if (inflated.byteLength !== header.size) throw new Error('pack object size mismatch');

  let object: GitObject;
  switch (header.typeCode) {
  case 1:
  case 2:
  case 3:
  case 4:
    object = { type: typeFromPackCode({ typeCode: header.typeCode }), body: inflated };
    break;
  case 6: {
    if (baseByOffset === undefined) throw new Error('missing OFS_DELTA base offset');
    const base = await readPackObjectAtOffset({
      context,
      objectOffset: baseByOffset,
      depth: depth + 1,
      readExternalObject,
    });
    object = { type: base.type, body: applyGitDelta({ base: base.body, delta: inflated }) };
    break;
  }
  case 7: {
    if (baseByObjectId === undefined) throw new Error('missing REF_DELTA base object id');
    const localBaseEntry = findPackIndexEntry({ packIndex: context.packIndex, objectId: baseByObjectId });
    const base = localBaseEntry === undefined
      ? await readExternalObject({ objectId: baseByObjectId })
      : await readPackObjectAtOffset({
        context,
        objectOffset: localBaseEntry.offset,
        depth: depth + 1,
        readExternalObject,
      });
    object = { type: base.type, body: applyGitDelta({ base: base.body, delta: inflated }) };
    break;
  }
  default:
    throw new Error(`unsupported pack object type ${header.typeCode}`);
  }

  if (objectIdFor(object) !== range.objectId) {
    throw new Error(`packed object id mismatch at offset ${objectOffset}`);
  }
  return object;
}

async function createPackContext({ files, repository, indexFileName }: {
  files: GitFiles,
  repository: GitRepository,
  indexFileName: string,
}): Promise<PackContext> {
  const packIndex = await readPackIndex({ files, repository, indexFileName });
  const packFileName = `${indexFileName.slice(0, -4)}.pack`;
  const packPath = joinPath({ base: repository.commonDirPath, child: `objects/pack/${packFileName}` });
  if (!await pathExists({ files, path: packPath })) throw new Error(`missing pack file for ${indexFileName}`);
  const packSize = await fileSize({ files, path: packPath });
  if (packSize < 32) throw new Error('pack file is too small');
  const header = await readFileRange({ files, path: packPath, position: 0, length: 12 });
  if (header.byteLength !== 12 || String.fromCharCode(...header.subarray(0, 4)) !== 'PACK') throw new Error('invalid pack signature');
  const version = ((header[4]! << 24) | (header[5]! << 16) | (header[6]! << 8) | header[7]!) >>> 0;
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const objectCount = ((header[8]! << 24) | (header[9]! << 16) | (header[10]! << 8) | header[11]!) >>> 0;
  if (objectCount !== packIndex.entries.length) throw new Error('pack/index object count mismatch');
  const trailer = await readFileRange({ files, path: packPath, position: packSize - 20, length: 20 });
  if (bytesToHex({ bytes: trailer }) !== packIndex.packChecksum) throw new Error('pack checksum does not match index');
  const packDataEnd = packSize - 20;
  const entriesByOffset = [...packIndex.entries].sort((left, right) => left.offset - right.offset);
  for (let index = 0; index < entriesByOffset.length; index += 1) {
    const entry = entriesByOffset[index]!;
    if (entry.offset < 12 || entry.offset >= packDataEnd) {
      throw new Error(`pack object offset is outside object data: ${entry.offset}`);
    }
    if (index > 0 && entriesByOffset[index - 1]!.offset === entry.offset) {
      throw new Error(`duplicate pack object offset ${entry.offset}`);
    }
  }
  return {
    files,
    repository,
    packPath,
    packIndex,
    entriesByOffset,
    packDataEnd,
  };
}

function assertPackReadCacheRepository({ cache, repository }: {
  cache: GitPackReadCache,
  repository: GitRepository,
}): void {
  if (cache.repositoryCommonDirPath === undefined) {
    cache.repositoryCommonDirPath = repository.commonDirPath;
    return;
  }
  if (cache.repositoryCommonDirPath !== repository.commonDirPath) {
    throw new Error('pack read cache cannot be shared across repositories');
  }
}

async function listPackIndexFileNames({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<readonly string[]> {
  const packDirectory = joinPath({ base: repository.commonDirPath, child: 'objects/pack' });
  if (!await pathExists({ files, path: packDirectory })) return [];
  const names: string[] = [];
  for await (const directoryEntry of files.readDir({ path: packDirectory })) {
    if (directoryEntry.type === 'file' && directoryEntry.name.endsWith('.idx')) names.push(directoryEntry.name);
  }
  return names;
}

async function cachedPackIndexFileNames({ files, repository, cache }: {
  files: GitFiles,
  repository: GitRepository,
  cache: GitPackReadCache | undefined,
}): Promise<readonly string[]> {
  if (cache === undefined) return listPackIndexFileNames({ files, repository });
  assertPackReadCacheRepository({ cache, repository });
  cache.indexFileNames ??= listPackIndexFileNames({ files, repository });
  return cache.indexFileNames;
}

async function cachedPackContext({ files, repository, indexFileName, cache }: {
  files: GitFiles,
  repository: GitRepository,
  indexFileName: string,
  cache: GitPackReadCache | undefined,
}): Promise<PackContext> {
  if (cache === undefined) return createPackContext({ files, repository, indexFileName });
  assertPackReadCacheRepository({ cache, repository });
  let pending = cache.contextsByIndexFileName.get(indexFileName);
  if (pending === undefined) {
    pending = createPackContext({ files, repository, indexFileName });
    cache.contextsByIndexFileName.set(indexFileName, pending);
  }
  return pending;
}

export async function readPackedObject({ files, repository, objectId, readExternalObject, cache }: {
  files: GitFiles,
  repository: GitRepository,
  objectId: string,
  readExternalObject({ objectId }: { objectId: string }): Promise<GitObject>,
  cache?: GitPackReadCache,
}): Promise<GitObject | undefined> {
  for (const indexFileName of await cachedPackIndexFileNames({ files, repository, cache })) {
    const context = await cachedPackContext({ files, repository, indexFileName, cache });
    const packEntry = findPackIndexEntry({ packIndex: context.packIndex, objectId });
    if (packEntry === undefined) continue;
    return readPackObjectAtOffset({
      context,
      objectOffset: packEntry.offset,
      depth: 0,
      readExternalObject,
    });
  }
  return undefined;
}

export const TEST_ONLY = {
  readPackObjectHeader,
  readOffsetDeltaBase,
};
