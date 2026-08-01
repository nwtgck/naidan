import {
  decodeRequiredHomeRecordReference,
  encodeHomeRecordReference,
  type HomeRecordReference,
} from '@/00-storage/service/hizofs/00-format/v1/binary/record-reference';
import {
  readI64Be,
  readU16Be,
  readU64Be,
  writeI64Be,
  writeU16Be,
  writeU64Be,
} from '@/00-storage/service/hizofs/00-format/v1/binary/scalars';
import { decodeSymlinkTarget, encodeFilenameComponent, encodeSymlinkTarget } from '@/00-storage/service/hizofs/00-format/v1/encoding/utf8';
import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';
import { compareUnsignedBytes } from '@/00-storage/service/hizofs/00-format/v1/ordering/unsigned-bytes';
import {
  createFileOffset,
  createInodeNumber,
  createInodeRevision,
  createTimestampMilliseconds,
  type FileOffset,
  type InodeNumber,
  type InodeRevision,
  type TimestampMilliseconds,
} from '@/00-storage/service/hizofs/00-format/v1/scalars';
import {
  COMMON_PAGE_HEADER_SIZE,
  decodeCommonPageHeader,
  encodeCommonPageHeader,
} from './common-page';
import {
  decodeDirectoryEntry,
  encodeDirectoryEntry,
  type DirectoryLeafEntry,
} from './variable-pages';

const FIXED_SIZES = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes;
const LIMITS = HIZOFS_V1_FORMAT_CONSTANTS.limits;
const KINDS = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;
const TAGS = HIZOFS_V1_FORMAT_CONSTANTS.tags;

export type InodeTimestamps = Readonly<{
  createdAt: TimestampMilliseconds | null;
  modifiedAt: TimestampMilliseconds | null;
}>;

export type FileInodeEntry = Readonly<{
  content:
    | Readonly<{ bytes: Uint8Array; type: 'inline' }>
    | Readonly<{ extentTreeRootHomeRef: HomeRecordReference; type: 'tree' }>;
  fileSize: FileOffset;
  inodeKind: 'file';
  inodeNumber: InodeNumber;
  inodeRevision: InodeRevision;
  timestamps: InodeTimestamps;
}>;

export type DirectoryInodeEntry = Readonly<{
  content:
    | Readonly<{ entries: readonly DirectoryLeafEntry[]; type: 'inline' }>
    | Readonly<{ directoryTreeRootHomeRef: HomeRecordReference; type: 'tree' }>;
  inodeKind: 'directory';
  inodeNumber: InodeNumber;
  inodeRevision: InodeRevision;
  timestamps: InodeTimestamps;
}>;

export type SymlinkInodeEntry = Readonly<{
  inodeKind: 'symlink';
  inodeNumber: InodeNumber;
  inodeRevision: InodeRevision;
  target: string;
  timestamps: InodeTimestamps;
}>;

export type InodeLeafEntry = FileInodeEntry | DirectoryInodeEntry | SymlinkInodeEntry;

export type InodeLeafPage = Readonly<{
  entries: readonly InodeLeafEntry[];
  level: 0;
  type: 'leaf';
}>;

function assertReferenceKind({ expected, label, reference }: {
  expected: number;
  label: string;
  reference: HomeRecordReference;
}): void {
  if (reference.recordKind !== expected) throw new TypeError(`${label} has the wrong record kind`);
}

function encodeTimestamps({ timestamps }: { timestamps: InodeTimestamps }): Readonly<{
  bytes: Uint8Array;
  presence: number;
}> {
  const values: TimestampMilliseconds[] = [];
  let presence = 0;
  if (timestamps.createdAt !== null) {
    presence |= 1;
    values.push(createTimestampMilliseconds({ value: timestamps.createdAt }));
  }
  if (timestamps.modifiedAt !== null) {
    presence |= 2;
    values.push(createTimestampMilliseconds({ value: timestamps.modifiedAt }));
  }
  const bytes = new Uint8Array(values.length * 8);
  values.forEach((value, index) => writeI64Be({ bytes, offset: index * 8, value }));
  return { bytes, presence };
}

function decodeTimestamps({ bytes, offset, presence }: {
  bytes: Uint8Array;
  offset: number;
  presence: number;
}): Readonly<{ nextOffset: number; timestamps: InodeTimestamps }> {
  if ((presence & ~3) !== 0) throw new TypeError('inode timestamp presence contains unknown bits');
  let nextOffset = offset;
  const readTimestamp = (): TimestampMilliseconds => {
    if (nextOffset + 8 > bytes.byteLength) throw new RangeError('inode timestamp exceeds entry boundary');
    const value = createTimestampMilliseconds({ value: readI64Be({ bytes, offset: nextOffset }) });
    nextOffset += 8;
    return value;
  };
  const createdAt = (presence & 1) === 0 ? null : readTimestamp();
  const modifiedAt = (presence & 2) === 0 ? null : readTimestamp();
  return { nextOffset, timestamps: { createdAt, modifiedAt } };
}

function inodeKindTag({ entry }: { entry: InodeLeafEntry }): number {
  switch (entry.inodeKind) {
  case 'file': return TAGS.inodeKind.file;
  case 'directory': return TAGS.inodeKind.directory;
  case 'symlink': return TAGS.inodeKind.symlink;
  default: return entry satisfies never;
  }
}

function encodeKindBody({ entry }: { entry: InodeLeafEntry }): Uint8Array {
  switch (entry.inodeKind) {
  case 'file': {
    const prefix = new Uint8Array(FIXED_SIZES.fileInodeBodyPrefix);
    writeU64Be({ bytes: prefix, offset: 0, value: entry.fileSize });
    switch (entry.content.type) {
    case 'inline': {
      if (entry.content.bytes.byteLength > LIMITS.inlineFileBytes || BigInt(entry.content.bytes.byteLength) !== entry.fileSize) {
        throw new RangeError('inline file bytes must equal fileSize and remain within the inline bound');
      }
      prefix[8] = TAGS.inodeContent.inline;
      const body = new Uint8Array(prefix.byteLength + 2 + entry.content.bytes.byteLength);
      body.set(prefix);
      writeU16Be({ bytes: body, offset: prefix.byteLength, value: entry.content.bytes.byteLength });
      body.set(entry.content.bytes, prefix.byteLength + 2);
      return body;
    }
    case 'tree': {
      assertReferenceKind({ expected: KINDS.file_extent_page, label: 'file extent root reference', reference: entry.content.extentTreeRootHomeRef });
      prefix[8] = TAGS.inodeContent.tree;
      const body = new Uint8Array(prefix.byteLength + FIXED_SIZES.recordReference);
      body.set(prefix);
      body.set(encodeHomeRecordReference({ reference: entry.content.extentTreeRootHomeRef }), prefix.byteLength);
      return body;
    }
    default: {
      const exhaustive: never = entry.content;
      throw new Error(`Unhandled file content: ${((exhaustive satisfies never) as { readonly type: string }).type}`);
    }
    }
  }
  case 'directory': {
    const prefix = new Uint8Array(FIXED_SIZES.directoryInodeBodyPrefix);
    switch (entry.content.type) {
    case 'inline': {
      let previousNameBytes: Uint8Array | undefined;
      const encodedEntries = entry.content.entries.map((directoryEntry) => {
        const nameBytes = encodeFilenameComponent({ value: directoryEntry.name });
        if (previousNameBytes !== undefined && compareUnsignedBytes({ left: previousNameBytes, right: nameBytes }) >= 0) {
          throw new TypeError('inline directory names must be strictly ascending by UTF-8 bytes');
        }
        previousNameBytes = nameBytes;
        return encodeDirectoryEntry({ entry: directoryEntry });
      });
      const encodedLength = encodedEntries.reduce((total, value) => total + value.byteLength, 0);
      if (encodedLength > LIMITS.inlineDirectoryEncodedBytes) throw new RangeError('inline directory entries exceed the inline bound');
      if (encodedEntries.length > 0xffff) throw new RangeError('inline directory entry count exceeds u16');
      prefix[0] = TAGS.inodeContent.inline;
      writeU16Be({ bytes: prefix, offset: 1, value: encodedEntries.length });
      const body = new Uint8Array(prefix.byteLength + encodedLength);
      body.set(prefix);
      let offset = prefix.byteLength;
      for (const encoded of encodedEntries) {
        body.set(encoded, offset);
        offset += encoded.byteLength;
      }
      return body;
    }
    case 'tree': {
      assertReferenceKind({ expected: KINDS.directory_page, label: 'directory tree root reference', reference: entry.content.directoryTreeRootHomeRef });
      prefix[0] = TAGS.inodeContent.tree;
      const body = new Uint8Array(prefix.byteLength + FIXED_SIZES.recordReference);
      body.set(prefix);
      body.set(encodeHomeRecordReference({ reference: entry.content.directoryTreeRootHomeRef }), prefix.byteLength);
      return body;
    }
    default: {
      const exhaustive: never = entry.content;
      throw new Error(`Unhandled directory content: ${((exhaustive satisfies never) as { readonly type: string }).type}`);
    }
    }
  }
  case 'symlink': {
    const target = encodeSymlinkTarget({ value: entry.target });
    const body = new Uint8Array(FIXED_SIZES.symlinkInodeBodyPrefix + target.byteLength);
    writeU16Be({ bytes: body, offset: 0, value: target.byteLength });
    body.set(target, FIXED_SIZES.symlinkInodeBodyPrefix);
    return body;
  }
  default: {
    const exhaustive: never = entry;
    throw new Error(`Unhandled inode kind: ${((exhaustive satisfies never) as { readonly inodeKind: string }).inodeKind}`);
  }
  }
}

function encodeInodeEntry({ entry }: { entry: InodeLeafEntry }): Uint8Array {
  if (entry.inodeNumber < 1n) throw new RangeError('Inode Number must be at least 1');
  if (entry.inodeRevision < 1n) throw new RangeError('inode revision must be at least 1');
  const timestamps = encodeTimestamps({ timestamps: entry.timestamps });
  const kindBody = encodeKindBody({ entry });
  const entryLength = FIXED_SIZES.inodeLeafEntryPrefix + timestamps.bytes.byteLength + kindBody.byteLength;
  if (entryLength > 0xffff) throw new RangeError('inode entry exceeds u16 length');
  const bytes = new Uint8Array(entryLength);
  writeU16Be({ bytes, offset: 0, value: entryLength });
  bytes[2] = inodeKindTag({ entry });
  bytes[3] = timestamps.presence;
  writeU64Be({ bytes, offset: 4, value: entry.inodeNumber });
  writeU64Be({ bytes, offset: 12, value: entry.inodeRevision });
  bytes.set(timestamps.bytes, FIXED_SIZES.inodeLeafEntryPrefix);
  bytes.set(kindBody, FIXED_SIZES.inodeLeafEntryPrefix + timestamps.bytes.byteLength);
  return bytes;
}

function decodeFileBody({ bytes, offset }: { bytes: Uint8Array; offset: number }): FileInodeEntry['content'] & Readonly<{ fileSize: FileOffset }> {
  if (offset + FIXED_SIZES.fileInodeBodyPrefix > bytes.byteLength) throw new RangeError('file inode body prefix exceeds entry boundary');
  const fileSize = createFileOffset({ value: readU64Be({ bytes, offset }) });
  const contentType = bytes[offset + 8];
  if (contentType === TAGS.inodeContent.inline) {
    if (offset + 11 > bytes.byteLength) throw new RangeError('inline file length exceeds entry boundary');
    const length = readU16Be({ bytes, offset: offset + 9 });
    if (offset + 11 + length !== bytes.byteLength) throw new RangeError('inline file entry length is invalid');
    if (length > LIMITS.inlineFileBytes || BigInt(length) !== fileSize) throw new RangeError('inline file length does not match fileSize');
    return { bytes: Uint8Array.from(bytes.subarray(offset + 11)), fileSize, type: 'inline' };
  }
  if (contentType === TAGS.inodeContent.tree) {
    if (offset + 9 + FIXED_SIZES.recordReference !== bytes.byteLength) throw new RangeError('extent-backed file entry length is invalid');
    const extentTreeRootHomeRef = decodeRequiredHomeRecordReference({ bytes: bytes.subarray(offset + 9) });
    assertReferenceKind({ expected: KINDS.file_extent_page, label: 'file extent root reference', reference: extentTreeRootHomeRef });
    return { extentTreeRootHomeRef, fileSize, type: 'tree' };
  }
  throw new TypeError('file inode content type is unknown');
}

function decodeDirectoryBody({ bytes, offset }: { bytes: Uint8Array; offset: number }): DirectoryInodeEntry['content'] {
  if (offset + FIXED_SIZES.directoryInodeBodyPrefix > bytes.byteLength) throw new RangeError('directory inode body prefix exceeds entry boundary');
  const contentType = bytes[offset];
  const count = readU16Be({ bytes, offset: offset + 1 });
  if (contentType === TAGS.inodeContent.tree) {
    if (count !== 0) throw new TypeError('tree directory must have zero inline entry count');
    if (offset + 3 + FIXED_SIZES.recordReference !== bytes.byteLength) throw new RangeError('tree directory entry length is invalid');
    const directoryTreeRootHomeRef = decodeRequiredHomeRecordReference({ bytes: bytes.subarray(offset + 3) });
    assertReferenceKind({ expected: KINDS.directory_page, label: 'directory tree root reference', reference: directoryTreeRootHomeRef });
    return { directoryTreeRootHomeRef, type: 'tree' };
  }
  if (contentType !== TAGS.inodeContent.inline) throw new TypeError('directory inode content type is unknown');
  const entries: DirectoryLeafEntry[] = [];
  let entryOffset = offset + 3;
  const start = entryOffset;
  let previousNameBytes: Uint8Array | undefined;
  for (let index = 0; index < count; index += 1) {
    if (entryOffset + FIXED_SIZES.directoryEntryPrefix > bytes.byteLength) throw new RangeError('inline directory entry prefix exceeds inode boundary');
    const length = readU16Be({ bytes, offset: entryOffset });
    if (length < FIXED_SIZES.directoryEntryPrefix || entryOffset + length > bytes.byteLength) throw new RangeError('inline directory entry length is invalid');
    const entry = decodeDirectoryEntry({ bytes: bytes.subarray(entryOffset, entryOffset + length) });
    const nameBytes = encodeFilenameComponent({ value: entry.name });
    if (previousNameBytes !== undefined && compareUnsignedBytes({ left: previousNameBytes, right: nameBytes }) >= 0) {
      throw new TypeError('inline directory names must be strictly ascending by UTF-8 bytes');
    }
    entries.push(entry);
    previousNameBytes = nameBytes;
    entryOffset += length;
  }
  if (entryOffset !== bytes.byteLength) throw new RangeError('inline directory body contains trailing bytes');
  if (entryOffset - start > LIMITS.inlineDirectoryEncodedBytes) throw new RangeError('inline directory entries exceed the inline bound');
  return { entries, type: 'inline' };
}

function decodeInodeEntry({ bytes }: { bytes: Uint8Array }): InodeLeafEntry {
  if (bytes.byteLength < FIXED_SIZES.inodeLeafEntryPrefix) throw new RangeError('inode entry is shorter than its prefix');
  if (readU16Be({ bytes, offset: 0 }) !== bytes.byteLength) throw new RangeError('inode entry length is invalid');
  const inodeNumber = createInodeNumber({ value: readU64Be({ bytes, offset: 4 }) });
  const inodeRevision = createInodeRevision({ value: readU64Be({ bytes, offset: 12 }) });
  if (inodeNumber < 1n || inodeRevision < 1n) throw new RangeError('inode number and revision must be at least 1');
  const decodedTimestamps = decodeTimestamps({ bytes, offset: FIXED_SIZES.inodeLeafEntryPrefix, presence: bytes[3] ?? 0 });
  const kind = bytes[2];
  if (kind === TAGS.inodeKind.file) {
    const file = decodeFileBody({ bytes, offset: decodedTimestamps.nextOffset });
    const { fileSize, ...content } = file;
    return { content, fileSize, inodeKind: 'file', inodeNumber, inodeRevision, timestamps: decodedTimestamps.timestamps };
  }
  if (kind === TAGS.inodeKind.directory) {
    return {
      content: decodeDirectoryBody({ bytes, offset: decodedTimestamps.nextOffset }),
      inodeKind: 'directory',
      inodeNumber,
      inodeRevision,
      timestamps: decodedTimestamps.timestamps,
    };
  }
  if (kind === TAGS.inodeKind.symlink) {
    const offset = decodedTimestamps.nextOffset;
    if (offset + 2 > bytes.byteLength) throw new RangeError('symlink target length exceeds entry boundary');
    const length = readU16Be({ bytes, offset });
    if (offset + 2 + length !== bytes.byteLength) throw new RangeError('symlink inode entry length is invalid');
    return {
      inodeKind: 'symlink',
      inodeNumber,
      inodeRevision,
      target: decodeSymlinkTarget({ bytes: bytes.subarray(offset + 2) }),
      timestamps: decodedTimestamps.timestamps,
    };
  }
  throw new TypeError('inode kind is unknown');
}

export function encodeInodeLeafPage({ entries, isRoot }: { entries: readonly InodeLeafEntry[]; isRoot: boolean }): Uint8Array {
  const header = encodeCommonPageHeader({ family: 'inode', header: { itemCount: entries.length, level: 0 }, isRoot });
  const encodedEntries: Uint8Array[] = [];
  let totalLength = header.byteLength;
  let previous: InodeNumber | undefined;
  for (const entry of entries) {
    if (previous !== undefined && entry.inodeNumber <= previous) throw new TypeError('Inode Numbers must be strictly ascending');
    const encoded = encodeInodeEntry({ entry });
    encodedEntries.push(encoded);
    totalLength += encoded.byteLength;
    previous = entry.inodeNumber;
  }
  if (totalLength > LIMITS.metadataPlaintextBytes) throw new RangeError('Inode Table page exceeds the metadata plaintext maximum');
  const bytes = new Uint8Array(totalLength);
  bytes.set(header);
  let offset = header.byteLength;
  for (const encoded of encodedEntries) {
    bytes.set(encoded, offset);
    offset += encoded.byteLength;
  }
  return bytes;
}

export function decodeInodeLeafPage({ bytes, isRoot }: { bytes: Uint8Array; isRoot: boolean }): InodeLeafPage {
  const header = decodeCommonPageHeader({ bytes, family: 'inode', isRoot });
  if (header.level !== 0) throw new TypeError('Inode Table leaf page must have level 0');
  const entries: InodeLeafEntry[] = [];
  let offset = COMMON_PAGE_HEADER_SIZE;
  let previous: InodeNumber | undefined;
  for (let index = 0; index < header.itemCount; index += 1) {
    if (offset + FIXED_SIZES.inodeLeafEntryPrefix > bytes.byteLength) throw new RangeError('inode entry prefix exceeds page boundary');
    const length = readU16Be({ bytes, offset });
    if (length < FIXED_SIZES.inodeLeafEntryPrefix || offset + length > bytes.byteLength) throw new RangeError('inode entry length is invalid');
    const entry = decodeInodeEntry({ bytes: bytes.subarray(offset, offset + length) });
    if (previous !== undefined && entry.inodeNumber <= previous) throw new TypeError('Inode Numbers must be strictly ascending');
    entries.push(entry);
    previous = entry.inodeNumber;
    offset += length;
  }
  if (offset !== bytes.byteLength) throw new RangeError('Inode Table page contains trailing bytes');
  return { entries, level: 0, type: 'leaf' };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
