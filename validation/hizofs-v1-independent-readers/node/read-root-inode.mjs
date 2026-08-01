import { Buffer } from "node:buffer";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { TextDecoder } from "node:util";

import { decodeRequiredRecordReference } from "./binary-fixtures.mjs";
import { loadPortableFixture, unlockPortableFixture } from "./read-empty-container.mjs";
import { readActiveCommitAuthority, readAuthenticatedHomeRecord } from "./read-active-commit.mjs";
import { openPortableSuperblocks } from "./read-superblocks.mjs";

const COMMON_PAGE_HEADER_BYTES = 4;
const INODE_ENTRY_PREFIX_BYTES = 20;
const DIRECTORY_BODY_PREFIX_BYTES = 3;
const DIRECTORY_ENTRY_PREFIX_BYTES = 14;
const FILE_BODY_PREFIX_BYTES = 9;
const MAXIMUM_INODE_LEAF_ENTRIES = 2_849;
const MAXIMUM_INLINE_DIRECTORY_BYTES = 4_096;
const MAXIMUM_INLINE_FILE_BYTES = 4_096;
const MAXIMUM_FILENAME_BYTES = 255;
const MAXIMUM_SYMLINK_BYTES = 4_096;
const TIMESTAMP_MINIMUM = -8_640_000_000_000_000n;
const TIMESTAMP_MAXIMUM = 8_640_000_000_000_000n;
const INODE_TABLE_KIND = 16;
const DIRECTORY_PAGE_KIND = 32;
const FILE_EXTENT_PAGE_KIND = 33;
const INODE_KIND = Object.freeze({ directory: 2, file: 1, symlink: 3 });
const CONTENT_KIND = Object.freeze({ inline: 1, tree: 2 });
const DIRECTORY_TARGET_KIND = Object.freeze({ inode: 1, subvolume: 2 });
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function decodeInodeKindTag({ value }) {
  switch (value) {
  case INODE_KIND.file: return "file";
  case INODE_KIND.directory: return "directory";
  case INODE_KIND.symlink: return "symlink";
  default: throw new TypeError("inode kind is unknown");
  }
}

function decodeStrictText({ bytes, label, maximumBytes, minimumBytes }) {
  if (bytes.length < minimumBytes || bytes.length > maximumBytes) {
    throw new RangeError(`${label} length is outside the V1 bound`);
  }
  let value;
  try { value = UTF8_DECODER.decode(bytes); } catch (cause) {
    throw new TypeError(`${label} is not well-formed UTF-8`, { cause });
  }
  if (Buffer.from(value, "utf8").length !== bytes.length) throw new TypeError(`${label} is not canonical UTF-8`);
  return value;
}

function decodeFilename({ bytes }) {
  const value = decodeStrictText({ bytes, label: "filename component", maximumBytes: MAXIMUM_FILENAME_BYTES, minimumBytes: 1 });
  if (value === "." || value === ".." || value.includes("/") || value.includes("\0")) {
    throw new TypeError("filename component is invalid");
  }
  return value;
}

function decodeTimestamps({ bytes, offset, presence }) {
  if ((presence & ~3) !== 0) throw new TypeError("inode timestamp presence contains unknown bits");
  let nextOffset = offset;
  const read = () => {
    if (nextOffset + 8 > bytes.length) throw new RangeError("inode timestamp exceeds entry boundary");
    const value = bytes.readBigInt64BE(nextOffset);
    nextOffset += 8;
    if (value < TIMESTAMP_MINIMUM || value > TIMESTAMP_MAXIMUM) throw new RangeError("inode timestamp is outside the V1 range");
    return value;
  };
  return Object.freeze({
    createdAt: (presence & 1) === 0 ? null : read(),
    modifiedAt: (presence & 2) === 0 ? null : read(),
    nextOffset,
  });
}

function decodeDirectoryEntry({ bytes }) {
  if (bytes.length < DIRECTORY_ENTRY_PREFIX_BYTES) throw new RangeError("directory entry is shorter than its prefix");
  const entryLength = bytes.readUInt16BE(0);
  const nameLength = bytes.readUInt16BE(4);
  if (entryLength !== bytes.length || entryLength !== DIRECTORY_ENTRY_PREFIX_BYTES + nameLength) {
    throw new RangeError("directory entry length is invalid");
  }
  const targetKind = bytes[2];
  const inodeKind = bytes[3];
  const targetId = bytes.readBigUInt64BE(6);
  const name = decodeFilename({ bytes: bytes.subarray(DIRECTORY_ENTRY_PREFIX_BYTES) });
  if (targetKind === DIRECTORY_TARGET_KIND.inode) {
    if (targetId < 1n) throw new TypeError("directory inode target is invalid");
    return Object.freeze({ inodeKind: decodeInodeKindTag({ value: inodeKind }), inodeNumber: targetId, name, targetType: "inode" });
  }
  if (targetKind === DIRECTORY_TARGET_KIND.subvolume) {
    if (inodeKind !== 0 || targetId < 2n) throw new TypeError("directory Subvolume target is invalid");
    return Object.freeze({ name, subvolumeId: targetId, targetType: "subvolume" });
  }
  throw new TypeError("directory target kind is unknown");
}

function decodeDirectoryBody({ bytes, offset }) {
  if (offset + DIRECTORY_BODY_PREFIX_BYTES > bytes.length) throw new RangeError("directory inode body prefix exceeds entry boundary");
  const contentKind = bytes[offset];
  const count = bytes.readUInt16BE(offset + 1);
  if (contentKind === CONTENT_KIND.tree) {
    if (count !== 0 || offset + DIRECTORY_BODY_PREFIX_BYTES + 32 !== bytes.length) throw new RangeError("tree directory entry length is invalid");
    const reference = decodeRequiredRecordReference({ bytes: bytes.subarray(offset + DIRECTORY_BODY_PREFIX_BYTES) });
    if (reference.recordKind !== DIRECTORY_PAGE_KIND) throw new TypeError("directory tree root reference has the wrong kind");
    return Object.freeze({ contentKind: "tree", entries: undefined, reference });
  }
  if (contentKind !== CONTENT_KIND.inline) throw new TypeError("directory content kind is unknown");
  const entries = [];
  let entryOffset = offset + DIRECTORY_BODY_PREFIX_BYTES;
  const inlineStart = entryOffset;
  let previousNameBytes;
  for (let index = 0; index < count; index += 1) {
    if (entryOffset + DIRECTORY_ENTRY_PREFIX_BYTES > bytes.length) throw new RangeError("inline directory entry prefix exceeds inode boundary");
    const length = bytes.readUInt16BE(entryOffset);
    if (length < DIRECTORY_ENTRY_PREFIX_BYTES || entryOffset + length > bytes.length) throw new RangeError("inline directory entry length is invalid");
    const entryBytes = bytes.subarray(entryOffset, entryOffset + length);
    const nameBytes = entryBytes.subarray(DIRECTORY_ENTRY_PREFIX_BYTES);
    if (previousNameBytes !== undefined && Buffer.compare(previousNameBytes, nameBytes) >= 0) throw new TypeError("inline directory names must be strictly ascending");
    entries.push(decodeDirectoryEntry({ bytes: entryBytes }));
    previousNameBytes = Buffer.from(nameBytes);
    entryOffset += length;
  }
  if (entryOffset !== bytes.length || entryOffset - inlineStart > MAXIMUM_INLINE_DIRECTORY_BYTES) throw new RangeError("inline directory body is not canonical");
  return Object.freeze({ contentKind: "inline", entries: Object.freeze(entries), reference: undefined });
}

function decodeInodeEntry({ bytes }) {
  if (bytes.length < INODE_ENTRY_PREFIX_BYTES || bytes.readUInt16BE(0) !== bytes.length) throw new RangeError("inode entry length is invalid");
  const kind = bytes[2];
  const inodeNumber = bytes.readBigUInt64BE(4);
  const inodeRevision = bytes.readBigUInt64BE(12);
  if (inodeNumber < 1n || inodeRevision < 1n) throw new RangeError("inode number and revision must be at least 1");
  const timestamps = decodeTimestamps({ bytes, offset: INODE_ENTRY_PREFIX_BYTES, presence: bytes[3] });
  if (kind === INODE_KIND.directory) {
    return Object.freeze({ inodeKind: "directory", inodeNumber, inodeRevision, timestamps, ...decodeDirectoryBody({ bytes, offset: timestamps.nextOffset }) });
  }
  if (kind === INODE_KIND.file) {
    const offset = timestamps.nextOffset;
    if (offset + FILE_BODY_PREFIX_BYTES > bytes.length) throw new RangeError("file inode body prefix exceeds entry boundary");
    const fileSize = bytes.readBigUInt64BE(offset);
    const contentKind = bytes[offset + 8];
    if (contentKind === CONTENT_KIND.inline) {
      if (offset + 11 > bytes.length) throw new RangeError("inline file length exceeds entry boundary");
      const length = bytes.readUInt16BE(offset + 9);
      if (length > MAXIMUM_INLINE_FILE_BYTES || BigInt(length) !== fileSize || offset + 11 + length !== bytes.length) throw new RangeError("inline file body is not canonical");
      return Object.freeze({
        contentKind: "inline",
        fileSize,
        inodeKind: "file",
        inodeNumber,
        inodeRevision,
        inlineBytes: Buffer.from(bytes.subarray(offset + 11)),
        timestamps,
      });
    }
    if (contentKind === CONTENT_KIND.tree) {
      if (offset + FILE_BODY_PREFIX_BYTES + 32 !== bytes.length) throw new RangeError("extent-backed file entry length is invalid");
      const reference = decodeRequiredRecordReference({ bytes: bytes.subarray(offset + FILE_BODY_PREFIX_BYTES) });
      if (reference.recordKind !== FILE_EXTENT_PAGE_KIND) throw new TypeError("file extent root reference has the wrong kind");
      return Object.freeze({ contentKind: "tree", fileSize, inodeKind: "file", inodeNumber, inodeRevision, timestamps });
    }
    throw new TypeError("file content kind is unknown");
  }
  if (kind === INODE_KIND.symlink) {
    const offset = timestamps.nextOffset;
    if (offset + 2 > bytes.length) throw new RangeError("symlink target length exceeds entry boundary");
    const length = bytes.readUInt16BE(offset);
    if (offset + 2 + length !== bytes.length) throw new RangeError("symlink inode entry length is invalid");
    const target = decodeStrictText({ bytes: bytes.subarray(offset + 2), label: "symlink target", maximumBytes: MAXIMUM_SYMLINK_BYTES, minimumBytes: 1 });
    if (target.includes("\0")) throw new TypeError("symlink target contains NUL");
    return Object.freeze({ inodeKind: "symlink", inodeNumber, inodeRevision, target, timestamps });
  }
  throw new TypeError("inode kind is unknown");
}

export function decodeRootInodeLeafPage({ bytes }) {
  if (!Buffer.isBuffer(bytes) || bytes.length < COMMON_PAGE_HEADER_BYTES || bytes.length > 65_536) throw new RangeError("Inode Table page length is outside the V1 bound");
  const level = bytes[0];
  const flags = bytes[1];
  const itemCount = bytes.readUInt16BE(2);
  if (level !== 0 || flags !== 0 || itemCount > MAXIMUM_INODE_LEAF_ENTRIES) throw new TypeError("root Inode Table leaf header is invalid");
  const entries = [];
  let offset = COMMON_PAGE_HEADER_BYTES;
  let previous;
  for (let index = 0; index < itemCount; index += 1) {
    if (offset + INODE_ENTRY_PREFIX_BYTES > bytes.length) throw new RangeError("inode entry prefix exceeds page boundary");
    const length = bytes.readUInt16BE(offset);
    if (length < INODE_ENTRY_PREFIX_BYTES || offset + length > bytes.length) throw new RangeError("inode entry length is invalid");
    const entry = decodeInodeEntry({ bytes: bytes.subarray(offset, offset + length) });
    if (previous !== undefined && entry.inodeNumber <= previous) throw new TypeError("Inode Numbers must be strictly ascending");
    entries.push(entry);
    previous = entry.inodeNumber;
    offset += length;
  }
  if (offset !== bytes.length) throw new RangeError("Inode Table page contains trailing bytes");
  return Object.freeze({ entries: Object.freeze(entries), itemCount, level });
}

export function readRootInode({ fixture, rootKey, selected }) {
  const active = readActiveCommitAuthority({ fixture, rootKey, selected });
  const reference = active.commit.rootInodeTableRootHomeRef;
  const opened = readAuthenticatedHomeRecord({ expectedKind: INODE_TABLE_KIND, fixture, reference, rootKey });
  const page = decodeRootInodeLeafPage({ bytes: opened.plaintext });
  const root = page.entries.find(entry => entry.inodeNumber === active.commit.rootDirectoryInodeNumber);
  if (root === undefined) throw new TypeError("root directory Inode is absent from the root Inode Table leaf");
  if (root.inodeKind !== "directory") throw new TypeError("root directory Inode has the wrong kind");
  return Object.freeze({
    rootDirectoryContent: root.contentKind,
    rootDirectoryCreatedAt: root.timestamps.createdAt?.toString() ?? null,
    rootDirectoryEntryCount: root.entries?.length ?? null,
    rootDirectoryInodeNumber: root.inodeNumber.toString(),
    rootDirectoryInodeRevision: root.inodeRevision.toString(),
    rootDirectoryModifiedAt: root.timestamps.modifiedAt?.toString() ?? null,
    rootInodeTableEntryCount: page.itemCount,
    rootInodeTableFrameLength: reference.frameLength,
    rootInodeTableLevel: page.level,
    segmentBytes: opened.segmentBytes,
  });
}

export async function verifyPortableRootInode({ fixturePath, passphrase }) {
  const fixture = await loadPortableFixture({ fixturePath });
  const unlocked = unlockPortableFixture({ fixture, passphrase: passphrase ?? fixture.passphrase });
  try {
    const superblocks = openPortableSuperblocks({ fixture, rootKey: unlocked.rootKey, unlockSequence: unlocked.summary.unlockSequence });
    return readRootInode({ fixture, rootKey: unlocked.rootKey, selected: superblocks.selected });
  } finally {
    unlocked.rootKey.fill(0);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixturePath = process.argv[2] ?? fileURLToPath(new URL("../../../src/00-storage/service/hizofs/authenticated-store/tests/test-fixtures/empty-container-portable-v1.json", import.meta.url));
  process.stdout.write(`${JSON.stringify(await verifyPortableRootInode({ fixturePath, passphrase: process.argv[3] }))}\n`);
}
