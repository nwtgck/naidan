import {
  decodeRequiredHomeRecordReference,
  encodeHomeRecordReference,
  type HomeRecordReference,
} from '@/00-storage/service/hizofs/00-format/v1/binary/record-reference';
import { readU16Be, readU64Be, writeU16Be, writeU64Be } from '@/00-storage/service/hizofs/00-format/v1/binary/scalars';
import { decodeFilenameComponent, encodeFilenameComponent } from '@/00-storage/service/hizofs/00-format/v1/encoding/utf8';
import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';
import { compareUnsignedBytes } from '@/00-storage/service/hizofs/00-format/v1/ordering/unsigned-bytes';
import {
  createInodeNumber,
  createSubvolumeId,
  type InodeNumber,
  type SubvolumeId,
} from '@/00-storage/service/hizofs/00-format/v1/scalars';
import {
  COMMON_PAGE_HEADER_SIZE,
  decodeCommonPageHeader,
  encodeCommonPageHeader,
} from './common-page';

const FIXED_SIZES = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes;
const KINDS = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;
const TAGS = HIZOFS_V1_FORMAT_CONSTANTS.tags;

export type SubvolumeAccess = 'read' | 'read_write';

export type NestedSubvolumeLeafEntry = Readonly<{
  access: SubvolumeAccess;
  entryName: string;
  inodeTableRootHomeRef: HomeRecordReference;
  parentDirectoryInodeNumber: InodeNumber;
  parentSubvolumeId: SubvolumeId;
  rootDirectoryInodeNumber: InodeNumber;
  subvolumeId: SubvolumeId;
}>;

export type NestedSubvolumeLeafPage = Readonly<{
  entries: readonly NestedSubvolumeLeafEntry[];
  level: 0;
  type: 'leaf';
}>;

export type InodeKind = 'file' | 'directory' | 'symlink';

export type DirectoryLeafEntry = Readonly<
  | { inodeKind: InodeKind; inodeNumber: InodeNumber; name: string; targetType: 'inode' }
  | { name: string; subvolumeId: SubvolumeId; targetType: 'subvolume' }
>;

export type DirectoryBranchEntry = Readonly<{
  childPageHomeRef: HomeRecordReference;
  upperBoundName: string;
}>;

export type DirectoryPage = Readonly<
  | { entries: readonly DirectoryLeafEntry[]; level: 0; type: 'leaf' }
  | { entries: readonly DirectoryBranchEntry[]; level: number; type: 'branch' }
>;

function accessToTag({ access }: { access: SubvolumeAccess }): number {
  switch (access) {
  case 'read': return TAGS.subvolumeAccess.read;
  case 'read_write': return TAGS.subvolumeAccess.readWrite;
  default: return access satisfies never;
  }
}

function tagToAccess({ value }: { value: number }): SubvolumeAccess {
  if (value === TAGS.subvolumeAccess.read) return 'read';
  if (value === TAGS.subvolumeAccess.readWrite) return 'read_write';
  throw new TypeError('nested Subvolume access tag is unknown');
}

function inodeKindToTag({ kind }: { kind: InodeKind }): number {
  switch (kind) {
  case 'file': return TAGS.inodeKind.file;
  case 'directory': return TAGS.inodeKind.directory;
  case 'symlink': return TAGS.inodeKind.symlink;
  default: return kind satisfies never;
  }
}

function tagToInodeKind({ value }: { value: number }): InodeKind {
  if (value === TAGS.inodeKind.file) return 'file';
  if (value === TAGS.inodeKind.directory) return 'directory';
  if (value === TAGS.inodeKind.symlink) return 'symlink';
  throw new TypeError('directory target inode kind is unknown');
}

function assertHomeReferenceKind({ expected, label, reference }: {
  expected: number;
  label: string;
  reference: HomeRecordReference;
}): void {
  if (reference.recordKind !== expected) throw new TypeError(`${label} has the wrong record kind`);
}

function concatenate({ chunks, totalLength }: { chunks: readonly Uint8Array[]; totalLength: number }): Uint8Array {
  if (totalLength > HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataPlaintextBytes) {
    throw new RangeError('page exceeds the V1 metadata plaintext maximum');
  }
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function validateNestedSubvolumeEntry({ entry }: { entry: NestedSubvolumeLeafEntry }): Uint8Array {
  if (entry.subvolumeId < 2n) throw new RangeError('nested Subvolume ID must be at least 2');
  if (entry.rootDirectoryInodeNumber < 1n || entry.parentDirectoryInodeNumber < 1n) {
    throw new RangeError('directory Inode Numbers must be at least 1');
  }
  if (entry.parentSubvolumeId < 1n) throw new RangeError('parent Subvolume ID must be at least 1');
  if (entry.parentSubvolumeId === entry.subvolumeId) throw new TypeError('nested Subvolume must not mount into itself');
  assertHomeReferenceKind({
    expected: KINDS.inode_table_page,
    label: 'nested Subvolume Inode Table reference',
    reference: entry.inodeTableRootHomeRef,
  });
  return encodeFilenameComponent({ value: entry.entryName });
}

export function encodeNestedSubvolumeLeafPage({ entries, isRoot }: {
  entries: readonly NestedSubvolumeLeafEntry[];
  isRoot: boolean;
}): Uint8Array {
  const header = encodeCommonPageHeader({
    family: 'nestedSubvolume',
    header: { itemCount: entries.length, level: 0 },
    isRoot,
  });
  const chunks: Uint8Array[] = [header];
  let totalLength = header.byteLength;
  let previousId: SubvolumeId | undefined;
  for (const entry of entries) {
    if (previousId !== undefined && entry.subvolumeId <= previousId) {
      throw new TypeError('nested Subvolume IDs must be strictly ascending');
    }
    const nameBytes = validateNestedSubvolumeEntry({ entry });
    const entryLength = FIXED_SIZES.nestedSubvolumeLeafPrefix + nameBytes.byteLength;
    const bytes = new Uint8Array(entryLength);
    writeU16Be({ bytes, offset: 0, value: entryLength });
    bytes[2] = accessToTag({ access: entry.access });
    writeU64Be({ bytes, offset: 4, value: entry.subvolumeId });
    writeU64Be({ bytes, offset: 12, value: entry.rootDirectoryInodeNumber });
    bytes.set(encodeHomeRecordReference({ reference: entry.inodeTableRootHomeRef }), 20);
    writeU64Be({ bytes, offset: 52, value: entry.parentSubvolumeId });
    writeU64Be({ bytes, offset: 60, value: entry.parentDirectoryInodeNumber });
    writeU16Be({ bytes, offset: 68, value: nameBytes.byteLength });
    bytes.set(nameBytes, 70);
    chunks.push(bytes);
    totalLength += bytes.byteLength;
    previousId = entry.subvolumeId;
  }
  return concatenate({ chunks, totalLength });
}

export function decodeNestedSubvolumeLeafPage({ bytes, isRoot }: {
  bytes: Uint8Array;
  isRoot: boolean;
}): NestedSubvolumeLeafPage {
  const header = decodeCommonPageHeader({ bytes, family: 'nestedSubvolume', isRoot });
  if (header.level !== 0) throw new TypeError('nested Subvolume leaf page must have level 0');
  const entries: NestedSubvolumeLeafEntry[] = [];
  let offset = COMMON_PAGE_HEADER_SIZE;
  let previousId: SubvolumeId | undefined;
  for (let index = 0; index < header.itemCount; index += 1) {
    if (offset + FIXED_SIZES.nestedSubvolumeLeafPrefix > bytes.byteLength) {
      throw new RangeError('nested Subvolume entry prefix exceeds page boundary');
    }
    const entryLength = readU16Be({ bytes, offset });
    const nameLength = readU16Be({ bytes, offset: offset + 68 });
    if (entryLength !== FIXED_SIZES.nestedSubvolumeLeafPrefix + nameLength || offset + entryLength > bytes.byteLength) {
      throw new RangeError('nested Subvolume entry length is invalid');
    }
    if (bytes[offset + 3] !== 0) throw new TypeError('nested Subvolume reserved byte must be zero');
    const entry: NestedSubvolumeLeafEntry = {
      access: tagToAccess({ value: bytes[offset + 2] ?? 0 }),
      subvolumeId: createSubvolumeId({ value: readU64Be({ bytes, offset: offset + 4 }) }),
      rootDirectoryInodeNumber: createInodeNumber({ value: readU64Be({ bytes, offset: offset + 12 }) }),
      inodeTableRootHomeRef: decodeRequiredHomeRecordReference({ bytes: bytes.subarray(offset + 20, offset + 52) }),
      parentSubvolumeId: createSubvolumeId({ value: readU64Be({ bytes, offset: offset + 52 }) }),
      parentDirectoryInodeNumber: createInodeNumber({ value: readU64Be({ bytes, offset: offset + 60 }) }),
      entryName: decodeFilenameComponent({ bytes: bytes.subarray(offset + 70, offset + entryLength) }),
    };
    if (previousId !== undefined && entry.subvolumeId <= previousId) {
      throw new TypeError('nested Subvolume IDs must be strictly ascending');
    }
    validateNestedSubvolumeEntry({ entry });
    entries.push(entry);
    previousId = entry.subvolumeId;
    offset += entryLength;
  }
  if (offset !== bytes.byteLength) throw new RangeError('nested Subvolume page contains trailing bytes');
  return { entries, level: 0, type: 'leaf' };
}

export function encodeDirectoryEntry({ entry }: { entry: DirectoryLeafEntry }): Uint8Array {
  const nameBytes = encodeFilenameComponent({ value: entry.name });
  const entryLength = FIXED_SIZES.directoryEntryPrefix + nameBytes.byteLength;
  const bytes = new Uint8Array(entryLength);
  writeU16Be({ bytes, offset: 0, value: entryLength });
  writeU16Be({ bytes, offset: 4, value: nameBytes.byteLength });
  switch (entry.targetType) {
  case 'inode':
    if (entry.inodeNumber < 1n) throw new RangeError('directory target Inode Number must be at least 1');
    bytes[2] = TAGS.directoryTarget.inode;
    bytes[3] = inodeKindToTag({ kind: entry.inodeKind });
    writeU64Be({ bytes, offset: 6, value: entry.inodeNumber });
    break;
  case 'subvolume':
    if (entry.subvolumeId < 2n) throw new RangeError('directory target Subvolume ID must be at least 2');
    bytes[2] = TAGS.directoryTarget.subvolume;
    bytes[3] = 0;
    writeU64Be({ bytes, offset: 6, value: entry.subvolumeId });
    break;
  default: {
    const exhaustive: never = entry;
    throw new Error(`Unhandled directory target: ${((exhaustive satisfies never) as { readonly targetType: string }).targetType}`);
  }
  }
  bytes.set(nameBytes, FIXED_SIZES.directoryEntryPrefix);
  return bytes;
}


export function assertDirectoryLeafEntryFitsMetadataPage({ entry }: { entry: DirectoryLeafEntry }): void {
  const encoded = encodeDirectoryEntry({ entry });
  if (COMMON_PAGE_HEADER_SIZE + encoded.byteLength > HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataPlaintextBytes) {
    throw new RangeError('page exceeds the V1 metadata plaintext maximum');
  }
}

export function decodeDirectoryEntry({ bytes }: { bytes: Uint8Array }): DirectoryLeafEntry {
  if (bytes.byteLength < FIXED_SIZES.directoryEntryPrefix) throw new RangeError('directory entry is shorter than its prefix');
  const entryLength = readU16Be({ bytes, offset: 0 });
  const nameLength = readU16Be({ bytes, offset: 4 });
  if (entryLength !== bytes.byteLength || entryLength !== FIXED_SIZES.directoryEntryPrefix + nameLength) {
    throw new RangeError('directory entry length is invalid');
  }
  const name = decodeFilenameComponent({ bytes: bytes.subarray(FIXED_SIZES.directoryEntryPrefix) });
  const targetId = readU64Be({ bytes, offset: 6 });
  const targetType = bytes[2];
  if (targetType === TAGS.directoryTarget.inode) {
    if (targetId < 1n) throw new RangeError('directory target Inode Number must be at least 1');
    return {
      inodeKind: tagToInodeKind({ value: bytes[3] ?? 0 }),
      inodeNumber: createInodeNumber({ value: targetId }),
      name,
      targetType: 'inode',
    };
  }
  if (targetType === TAGS.directoryTarget.subvolume) {
    if (bytes[3] !== 0) throw new TypeError('subvolume directory target reserved byte must be zero');
    if (targetId < 2n) throw new RangeError('directory target Subvolume ID must be at least 2');
    return { name, subvolumeId: createSubvolumeId({ value: targetId }), targetType: 'subvolume' };
  }
  throw new TypeError('directory target type is unknown');
}


export function encodedDirectoryBranchEntryByteLength({ entry }: { entry: DirectoryBranchEntry }): number {
  assertHomeReferenceKind({
    expected: KINDS.directory_page,
    label: 'directory branch child reference',
    reference: entry.childPageHomeRef,
  });
  return FIXED_SIZES.directoryBranchChildPrefix + encodeFilenameComponent({ value: entry.upperBoundName }).byteLength;
}

export function encodeDirectoryPage({ isRoot, page }: { isRoot: boolean; page: DirectoryPage }): Uint8Array {
  switch (page.type) {
  case 'leaf': {
    const header = encodeCommonPageHeader({ family: 'directory', header: { itemCount: page.entries.length, level: 0 }, isRoot });
    const chunks: Uint8Array[] = [header];
    let totalLength = header.byteLength;
    let previousNameBytes: Uint8Array | undefined;
    for (const entry of page.entries) {
      const encoded = encodeDirectoryEntry({ entry });
      const nameBytes = encoded.subarray(FIXED_SIZES.directoryEntryPrefix);
      if (previousNameBytes !== undefined && compareUnsignedBytes({ left: previousNameBytes, right: nameBytes }) >= 0) {
        throw new TypeError('directory names must be strictly ascending by UTF-8 bytes');
      }
      chunks.push(encoded);
      totalLength += encoded.byteLength;
      previousNameBytes = nameBytes;
    }
    return concatenate({ chunks, totalLength });
  }
  case 'branch': {
    if (page.level < 1) throw new RangeError('directory branch page level must be at least 1');
    const header = encodeCommonPageHeader({ family: 'directory', header: { itemCount: page.entries.length, level: page.level }, isRoot });
    const chunks: Uint8Array[] = [header];
    let totalLength = header.byteLength;
    let previousNameBytes: Uint8Array | undefined;
    for (const entry of page.entries) {
      assertHomeReferenceKind({ expected: KINDS.directory_page, label: 'directory branch child reference', reference: entry.childPageHomeRef });
      const nameBytes = encodeFilenameComponent({ value: entry.upperBoundName });
      if (previousNameBytes !== undefined && compareUnsignedBytes({ left: previousNameBytes, right: nameBytes }) >= 0) {
        throw new TypeError('directory branch bounds must be strictly ascending by UTF-8 bytes');
      }
      const childLength = FIXED_SIZES.directoryBranchChildPrefix + nameBytes.byteLength;
      const encoded = new Uint8Array(childLength);
      writeU16Be({ bytes: encoded, offset: 0, value: childLength });
      writeU16Be({ bytes: encoded, offset: 2, value: nameBytes.byteLength });
      encoded.set(encodeHomeRecordReference({ reference: entry.childPageHomeRef }), 4);
      encoded.set(nameBytes, FIXED_SIZES.directoryBranchChildPrefix);
      chunks.push(encoded);
      totalLength += encoded.byteLength;
      previousNameBytes = nameBytes;
    }
    return concatenate({ chunks, totalLength });
  }
  default: {
    const exhaustive: never = page;
    throw new Error(`Unhandled directory page type: ${((exhaustive satisfies never) as { readonly type: string }).type}`);
  }
  }
}

export function decodeDirectoryPage({ bytes, isRoot }: { bytes: Uint8Array; isRoot: boolean }): DirectoryPage {
  const header = decodeCommonPageHeader({ bytes, family: 'directory', isRoot });
  const leaf = header.level === 0;
  const leafEntries: DirectoryLeafEntry[] = [];
  const branchEntries: DirectoryBranchEntry[] = [];
  let offset = COMMON_PAGE_HEADER_SIZE;
  let previousNameBytes: Uint8Array | undefined;
  for (let index = 0; index < header.itemCount; index += 1) {
    const minimum = leaf ? FIXED_SIZES.directoryEntryPrefix : FIXED_SIZES.directoryBranchChildPrefix;
    if (offset + minimum > bytes.byteLength) throw new RangeError('directory item prefix exceeds page boundary');
    const itemLength = readU16Be({ bytes, offset });
    const nameLength = readU16Be({ bytes, offset: offset + (leaf ? 4 : 2) });
    if (itemLength !== minimum + nameLength || offset + itemLength > bytes.byteLength) {
      throw new RangeError('directory item length is invalid');
    }
    const nameOffset = offset + minimum;
    const nameBytes = bytes.subarray(nameOffset, offset + itemLength);
    if (previousNameBytes !== undefined && compareUnsignedBytes({ left: previousNameBytes, right: nameBytes }) >= 0) {
      throw new TypeError('directory keys must be strictly ascending by UTF-8 bytes');
    }
    if (leaf) {
      leafEntries.push(decodeDirectoryEntry({ bytes: bytes.subarray(offset, offset + itemLength) }));
    } else {
      const childPageHomeRef = decodeRequiredHomeRecordReference({ bytes: bytes.subarray(offset + 4, offset + 36) });
      assertHomeReferenceKind({ expected: KINDS.directory_page, label: 'directory branch child reference', reference: childPageHomeRef });
      branchEntries.push({ childPageHomeRef, upperBoundName: decodeFilenameComponent({ bytes: nameBytes }) });
    }
    previousNameBytes = nameBytes;
    offset += itemLength;
  }
  if (offset !== bytes.byteLength) throw new RangeError('directory page contains trailing bytes');
  return leaf
    ? { entries: leafEntries, level: 0, type: 'leaf' }
    : { entries: branchEntries, level: header.level, type: 'branch' };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
