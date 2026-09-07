import { bytesToHex, compareBytes, concatBytes, writeHexBytes } from './bytes';
import type { GitFiles } from './files';
import { pathExists, readFileBytes, replaceFileViaLock } from './files';
import { readOffsetVariableWidth, writeOffsetVariableWidth } from './offset-varint';
import type { GitRepository } from './repository';
import { joinPath } from './repository';
import { sha1Bytes } from './sha1';
import { assertSafeGitRepositoryPath, assertSafeGitRepositoryPathBytes, decodeGitPathBytes } from './path-safety';

export interface GitIndexEntry {
  path: string,
  objectId: string,
  mode: number,
  size: number,
  stage: 0 | 1 | 2 | 3,
}

export interface GitRawIndexEntry {
  pathBytes: Uint8Array,
  objectId: string,
  mode: number,
  size: number,
  stage: 0 | 1 | 2 | 3,
}

type GitIndexVersion = 2 | 3 | 4;

interface ParsedIndex {
  version: GitIndexVersion,
  entries: GitRawIndexEntry[],
  extensions: string[],
}

const DROPPABLE_OPTIONAL_INDEX_EXTENSIONS = new Set(["TREE", "UNTR", "FSMN", "EOIE", "IEOT"]);

const textEncoder = new TextEncoder();

function readUint16({ bytes, offset }: { bytes: Uint8Array, offset: number }): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUint32({ bytes, offset }: { bytes: Uint8Array, offset: number }): number {
  return (
    (bytes[offset]! << 24)
    | (bytes[offset + 1]! << 16)
    | (bytes[offset + 2]! << 8)
    | bytes[offset + 3]!
  ) >>> 0;
}

function writeUint32({ bytes, offset, value }: { bytes: Uint8Array, offset: number, value: number }): void {
  bytes[offset] = value >>> 24;
  bytes[offset + 1] = value >>> 16;
  bytes[offset + 2] = value >>> 8;
  bytes[offset + 3] = value;
}

function writeUint16({ bytes, offset, value }: { bytes: Uint8Array, offset: number, value: number }): void {
  bytes[offset] = value >>> 8;
  bytes[offset + 1] = value;
}


function findNul({ bytes, offset, limit, label }: {
  bytes: Uint8Array,
  offset: number,
  limit: number,
  label: string,
}): number {
  let nulOffset = offset;
  while (nulOffset < limit && bytes[nulOffset] !== 0) nulOffset += 1;
  if (nulOffset >= limit) throw new Error(`${label} is not terminated`);
  return nulOffset;
}

function validateExtendedFlags({ extendedFlags }: { extendedFlags: number }): void {
  if ((extendedFlags & 0x8000) !== 0 || (extendedFlags & 0x1fff) !== 0) {
    throw new Error('index extended flags contain reserved bits');
  }
  if ((extendedFlags & 0x4000) !== 0) {
    throw new Error('skip-worktree index entries are not supported yet');
  }
  if ((extendedFlags & 0x2000) !== 0) {
    throw new Error('intent-to-add index entries are not supported yet');
  }
}

function parseExtensions({ bytes, offset, contentEnd }: {
  bytes: Uint8Array,
  offset: number,
  contentEnd: number,
}): string[] {
  const extensions: string[] = [];
  while (offset < contentEnd) {
    if (offset + 8 > contentEnd) throw new Error('truncated index extension header');
    const signatureBytes = bytes.subarray(offset, offset + 4);
    const signature = String.fromCharCode(...signatureBytes);
    const size = readUint32({ bytes, offset: offset + 4 });
    const extensionEnd = offset + 8 + size;
    if (extensionEnd > contentEnd) throw new Error(`truncated index extension ${signature}`);
    const firstByte = signatureBytes[0]!;
    if (firstByte < 0x41 || firstByte > 0x5a) {
      throw new Error(`unsupported required index extension ${signature}`);
    }
    extensions.push(signature);
    offset = extensionEnd;
  }
  return extensions;
}

function assertWritableIndexExtensions({ extensions }: { extensions: readonly string[] }): void {
  for (const signature of extensions) {
    if (DROPPABLE_OPTIONAL_INDEX_EXTENSIONS.has(signature)) continue;
    if (signature === "REUC") {
      throw new Error("index resolve-undo extension REUC is not supported for mutation yet");
    }
    throw new Error(`optional index extension ${signature} cannot be preserved safely during mutation`);
  }
}

function parseIndexState({ bytes }: { bytes: Uint8Array }): ParsedIndex {
  if (bytes.byteLength < 32) throw new Error('index file is too small');
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'DIRC') throw new Error('index signature is invalid');
  const rawVersion = readUint32({ bytes, offset: 4 });
  if (rawVersion !== 2 && rawVersion !== 3 && rawVersion !== 4) {
    throw new Error(`unsupported index version ${rawVersion}`);
  }
  const version: GitIndexVersion = rawVersion;
  const entryCount = readUint32({ bytes, offset: 8 });
  const contentEnd = bytes.byteLength - 20;
  const expectedChecksum = bytes.subarray(contentEnd);
  const actualChecksum = sha1Bytes({ bytes: bytes.subarray(0, contentEnd) });
  if (bytesToHex({ bytes: expectedChecksum }) !== bytesToHex({ bytes: actualChecksum })) {
    throw new Error('index checksum mismatch');
  }

  const entries: GitRawIndexEntry[] = [];
  let offset = 12;
  let previousPathBytes: Uint8Array = new Uint8Array();
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    const entryStart = offset;
    if (offset + 62 > contentEnd) throw new Error('truncated index entry');
    const mode = readUint32({ bytes, offset: offset + 24 });
    const size = readUint32({ bytes, offset: offset + 36 });
    const objectId = bytesToHex({ bytes: bytes.subarray(offset + 40, offset + 60) });
    const flags = readUint16({ bytes, offset: offset + 60 });
    if ((flags & 0x8000) !== 0) throw new Error('assume-valid index entries are not supported yet');
    const hasExtendedFlags = (flags & 0x4000) !== 0;
    const stage = ((flags >>> 12) & 0x3) as 0 | 1 | 2 | 3;
    offset += 62;
    if (hasExtendedFlags) {
      if (version === 2) throw new Error('version 2 index entry has extended flags');
      if (offset + 2 > contentEnd) throw new Error('truncated index extended flags');
      validateExtendedFlags({ extendedFlags: readUint16({ bytes, offset }) });
      offset += 2;
    }

    let pathBytes: Uint8Array;
    if (version === 4) {
      const removeCount = readOffsetVariableWidth({
        bytes,
        offset,
        label: 'index v4 pathname prefix length',
      });
      offset = removeCount.offset;
      if (removeCount.value > previousPathBytes.byteLength) {
        throw new Error('index v4 pathname removes more bytes than the previous pathname contains');
      }
      const nulOffset = findNul({ bytes, offset, limit: contentEnd, label: 'index pathname' });
      const retainedPrefix = previousPathBytes.subarray(0, previousPathBytes.byteLength - removeCount.value);
      pathBytes = concatBytes({ chunks: [retainedPrefix, bytes.subarray(offset, nulOffset)] });
      offset = nulOffset + 1;
    } else {
      const nulOffset = findNul({ bytes, offset, limit: contentEnd, label: 'index pathname' });
      pathBytes = bytes.slice(offset, nulOffset);
      const entryLength = nulOffset + 1 - entryStart;
      offset = entryStart + Math.ceil(entryLength / 8) * 8;
      if (offset > contentEnd) throw new Error('truncated index entry padding');
    }

    if (pathBytes.byteLength === 0) throw new Error('index pathname is empty');
    assertSafeGitRepositoryPathBytes({ bytes: pathBytes, source: 'index' });
    previousPathBytes = pathBytes;
    entries.push({ pathBytes, objectId, mode, size, stage });
  }

  const extensions = parseExtensions({ bytes, offset, contentEnd });
  return { version, entries, extensions };
}

function commonPrefixLength({ left, right }: { left: Uint8Array, right: Uint8Array }): number {
  const limit = Math.min(left.byteLength, right.byteLength);
  let length = 0;
  while (length < limit && left[length] === right[length]) length += 1;
  return length;
}

interface PreparedIndexEntry {
  entry: GitIndexEntry,
  pathBytes: Uint8Array,
  byteLength: number,
  prefixLength: number,
  encodedRemoveCount: Uint8Array | undefined,
}

function prepareIndexEntry({ entry, version, previousPathBytes, pathBytes }: {
  entry: GitIndexEntry,
  version: GitIndexVersion,
  previousPathBytes: Uint8Array,
  pathBytes: Uint8Array,
}): PreparedIndexEntry {
  assertSafeGitRepositoryPath({ path: entry.path, source: 'index' });
  if (pathBytes.byteLength === 0 || pathBytes.includes(0)) throw new Error(`invalid index path: ${entry.path}`);
  if (version === 4) {
    const prefixLength = commonPrefixLength({ left: previousPathBytes, right: pathBytes });
    const encodedRemoveCount = writeOffsetVariableWidth({
      value: previousPathBytes.byteLength - prefixLength,
      label: 'index v4 pathname prefix length',
    });
    return {
      entry,
      pathBytes,
      byteLength: 62 + encodedRemoveCount.byteLength + (pathBytes.byteLength - prefixLength) + 1,
      prefixLength,
      encodedRemoveCount,
    };
  }

  const rawLength = 62 + pathBytes.byteLength + 1;
  return {
    entry,
    pathBytes,
    byteLength: Math.ceil(rawLength / 8) * 8,
    prefixLength: 0,
    encodedRemoveCount: undefined,
  };
}

function writePreparedIndexEntry({ bytes, offset, prepared, version }: {
  bytes: Uint8Array,
  offset: number,
  prepared: PreparedIndexEntry,
  version: GitIndexVersion,
}): void {
  const { entry, pathBytes, prefixLength, encodedRemoveCount } = prepared;
  writeUint32({ bytes, offset: offset + 24, value: entry.mode });
  writeUint32({ bytes, offset: offset + 36, value: entry.size >>> 0 });
  writeHexBytes({ hex: entry.objectId, bytes, offset: offset + 40, byteLength: 20 });
  const nameLengthBits = Math.min(pathBytes.byteLength, 0x0fff);
  writeUint16({ bytes, offset: offset + 60, value: nameLengthBits | (entry.stage << 12) });

  if (version === 4) {
    if (encodedRemoveCount === undefined) throw new Error('missing prepared index v4 pathname prefix length');
    let pathOffset = offset + 62;
    bytes.set(encodedRemoveCount, pathOffset);
    pathOffset += encodedRemoveCount.byteLength;
    bytes.set(pathBytes.subarray(prefixLength), pathOffset);
    return;
  }
  bytes.set(pathBytes, offset + 62);
}

function decodeIndexEntry({ entry }: { entry: GitRawIndexEntry }): GitIndexEntry {
  const path = decodeGitPathBytes({ bytes: entry.pathBytes, source: 'index' });
  assertSafeGitRepositoryPath({ path, source: 'index' });
  return {
    path,
    objectId: entry.objectId,
    mode: entry.mode,
    size: entry.size,
    stage: entry.stage,
  };
}

export function parseIndexFileRaw({ bytes }: { bytes: Uint8Array }): GitRawIndexEntry[] {
  return parseIndexState({ bytes }).entries;
}

export function parseIndexFile({ bytes }: { bytes: Uint8Array }): GitIndexEntry[] {
  return parseIndexFileRaw({ bytes }).map(entry => decodeIndexEntry({ entry }));
}

export function serializeIndexFile({ entries, version }: {
  entries: readonly GitIndexEntry[],
  version: GitIndexVersion,
}): Uint8Array {
  const sortedEntries = [...entries]
    .map(entry => ({ entry, pathBytes: textEncoder.encode(entry.path) }))
    .sort((left, right) => compareBytes({ left: left.pathBytes, right: right.pathBytes }) || left.entry.stage - right.entry.stage);
  const preparedEntries: PreparedIndexEntry[] = [];
  let contentLength = 12;
  let previousPathBytes: Uint8Array = new Uint8Array();
  for (const { entry, pathBytes } of sortedEntries) {
    const prepared = prepareIndexEntry({ entry, version, previousPathBytes, pathBytes });
    preparedEntries.push(prepared);
    contentLength += prepared.byteLength;
    previousPathBytes = pathBytes;
  }

  const result = new Uint8Array(contentLength + 20);
  result.set(textEncoder.encode('DIRC'), 0);
  writeUint32({ bytes: result, offset: 4, value: version });
  writeUint32({ bytes: result, offset: 8, value: sortedEntries.length });
  let offset = 12;
  for (const prepared of preparedEntries) {
    writePreparedIndexEntry({ bytes: result, offset, prepared, version });
    offset += prepared.byteLength;
  }
  result.set(sha1Bytes({ bytes: result.subarray(0, contentLength) }), contentLength);
  return result;
}

export async function readIndexRaw({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<GitRawIndexEntry[]> {
  const indexPath = joinPath({ base: repository.gitDirPath, child: 'index' });
  if (!await pathExists({ files, path: indexPath })) return [];
  return parseIndexFileRaw({ bytes: await readFileBytes({ files, path: indexPath }) });
}

export async function readIndex({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<GitIndexEntry[]> {
  return (await readIndexRaw({ files, repository })).map(entry => decodeIndexEntry({ entry }));
}

export function collectUnmergedPaths({ entries }: {
  entries: readonly GitIndexEntry[],
}): Set<string> {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (entry.stage !== 0) paths.add(entry.path);
  }
  return paths;
}

export async function writeIndex({ files, repository, entries }: {
  files: GitFiles,
  repository: GitRepository,
  entries: readonly GitIndexEntry[],
}): Promise<void> {
  const indexPath = joinPath({ base: repository.gitDirPath, child: 'index' });
  let version: GitIndexVersion = 2;
  if (await pathExists({ files, path: indexPath })) {
    const state = parseIndexState({ bytes: await readFileBytes({ files, path: indexPath }) });
    assertWritableIndexExtensions({ extensions: state.extensions });
    version = state.version;
  }
  await replaceFileViaLock({
    files,
    path: indexPath,
    bytes: serializeIndexFile({ entries, version }),
  });
}

export const TEST_ONLY = {
  assertWritableIndexExtensions,
};
