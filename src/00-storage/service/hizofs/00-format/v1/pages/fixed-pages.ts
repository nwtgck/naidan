import {
  decodeRequiredHomeRecordReference,
  decodeRequiredPhysicalRecordReference,
  encodePhysicalRecordReference,
  writeHomeRecordReference,
  type HomeRecordReference,
  type PhysicalRecordReference,
} from '@/00-storage/service/hizofs/00-format/v1/binary/record-reference';
import { readU32Be, readU64Be, writeU32Be, writeU64Be } from '@/00-storage/service/hizofs/00-format/v1/binary/scalars';
import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';
import { parseSegmentId, type SegmentId } from '@/00-storage/service/hizofs/00-format/v1/identifiers';
import { compareUnsignedBytes } from '@/00-storage/service/hizofs/00-format/v1/ordering/unsigned-bytes';
import {
  createFileOffset,
  createInodeNumber,
  createSubvolumeId,
  UINT64_MAXIMUM,
  type FileOffset,
  type InodeNumber,
  type SubvolumeId,
  type UInt64,
} from '@/00-storage/service/hizofs/00-format/v1/scalars';
import {
  COMMON_PAGE_HEADER_SIZE,
  decodeCommonPageHeader,
  encodeCommonPageHeader,
  type PageFamily,
} from './common-page';

const FIXED_SIZES = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes;
const RECORD_KINDS = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;

export type UInt64BranchEntry<T extends UInt64 = UInt64> = Readonly<{
  childPageHomeRef: HomeRecordReference;
  upperBound: T;
}>;

export type FileExtentLeafEntry = Readonly<{
  byteLength: number;
  dataOffset: number;
  fileDataHomeRef: HomeRecordReference;
  fileOffset: FileOffset;
}>;

export type RelocationKey = Readonly<{
  homeOffset: UInt64;
  homeSegmentId: SegmentId;
}>;

export type RelocationLeafEntry = RelocationKey & Readonly<{
  currentPhysicalRecordRef: PhysicalRecordReference;
}>;

export type RelocationBranchEntry = Readonly<{
  childPagePhysicalRef: PhysicalRecordReference;
  upperBound: RelocationKey;
}>;

export type UInt64BranchPage<T extends UInt64 = UInt64> = Readonly<{
  entries: readonly UInt64BranchEntry<T>[];
  level: number;
}>;

export type NestedSubvolumeBranchPage = UInt64BranchPage<SubvolumeId>;
export type InodeBranchPage = UInt64BranchPage<InodeNumber>;

export type FileExtentPage = Readonly<
  | { entries: readonly FileExtentLeafEntry[]; level: 0; type: 'leaf' }
  | { entries: readonly UInt64BranchEntry<FileOffset>[]; level: number; type: 'branch' }
>;

export type RelocationIndexPage = Readonly<
  | { entries: readonly RelocationLeafEntry[]; level: 0; type: 'leaf' }
  | { entries: readonly RelocationBranchEntry[]; level: number; type: 'branch' }
>;

function assertReferenceKind({ expected, label, reference }: {
  expected: number;
  label: string;
  reference: HomeRecordReference | PhysicalRecordReference;
}): void {
  if (reference.recordKind !== expected) throw new TypeError(`${label} has the wrong record kind`);
}

function assertStrictUInt64Order({ current, previous }: { current: UInt64; previous: UInt64 | undefined }): void {
  if (previous !== undefined && current <= previous) throw new TypeError('page keys must be strictly ascending');
}

function encodeUInt64BranchPage<T extends UInt64>({ entries, family, isRoot, level, recordKind }: {
  entries: readonly UInt64BranchEntry<T>[];
  family: PageFamily;
  isRoot: boolean;
  level: number;
  recordKind: number;
}): Uint8Array {
  if (level < 1) throw new RangeError('branch page level must be at least 1');
  const header = encodeCommonPageHeader({ family, header: { itemCount: entries.length, level }, isRoot });
  const bytes = new Uint8Array(header.byteLength + entries.length * FIXED_SIZES.inodeBranchChild);
  bytes.set(header);
  let previous: UInt64 | undefined;
  entries.forEach((entry, index) => {
    assertStrictUInt64Order({ current: entry.upperBound, previous });
    assertReferenceKind({ expected: recordKind, label: 'branch child reference', reference: entry.childPageHomeRef });
    const offset = COMMON_PAGE_HEADER_SIZE + index * FIXED_SIZES.inodeBranchChild;
    writeU64Be({ bytes, offset, value: entry.upperBound });
    writeHomeRecordReference({ bytes, offset: offset + 8, reference: entry.childPageHomeRef });
    previous = entry.upperBound;
  });
  return bytes;
}

function decodeUInt64BranchPage({ bytes, family, isRoot, recordKind }: {
  bytes: Uint8Array;
  family: PageFamily;
  isRoot: boolean;
  recordKind: number;
}): UInt64BranchPage {
  const header = decodeCommonPageHeader({ bytes, family, isRoot });
  if (header.level < 1) throw new TypeError('branch page must have level at least 1');
  const expectedLength = COMMON_PAGE_HEADER_SIZE + header.itemCount * FIXED_SIZES.inodeBranchChild;
  if (bytes.byteLength !== expectedLength) throw new RangeError('branch page length does not match item count');
  const entries: UInt64BranchEntry[] = [];
  let previous: UInt64 | undefined;
  for (let index = 0; index < header.itemCount; index += 1) {
    const offset = COMMON_PAGE_HEADER_SIZE + index * FIXED_SIZES.inodeBranchChild;
    const upperBound = readU64Be({ bytes, offset });
    assertStrictUInt64Order({ current: upperBound, previous });
    const childPageHomeRef = decodeRequiredHomeRecordReference({ bytes: bytes.subarray(offset + 8, offset + 40) });
    assertReferenceKind({ expected: recordKind, label: 'branch child reference', reference: childPageHomeRef });
    entries.push({ childPageHomeRef, upperBound });
    previous = upperBound;
  }
  return { entries, level: header.level };
}

export function encodeNestedSubvolumeBranchPage({ page, isRoot }: {
  isRoot: boolean;
  page: NestedSubvolumeBranchPage;
}): Uint8Array {
  return encodeUInt64BranchPage({
    entries: page.entries,
    family: 'nestedSubvolume',
    isRoot,
    level: page.level,
    recordKind: RECORD_KINDS.nested_subvolume_table_page,
  });
}

export function decodeNestedSubvolumeBranchPage({ bytes, isRoot }: {
  bytes: Uint8Array;
  isRoot: boolean;
}): NestedSubvolumeBranchPage {
  const page = decodeUInt64BranchPage({
    bytes,
    family: 'nestedSubvolume',
    isRoot,
    recordKind: RECORD_KINDS.nested_subvolume_table_page,
  });
  return {
    entries: page.entries.map((entry) => ({
      childPageHomeRef: entry.childPageHomeRef,
      upperBound: createSubvolumeId({ value: entry.upperBound }),
    })),
    level: page.level,
  };
}

export function encodeInodeBranchPage({ page, isRoot }: { isRoot: boolean; page: InodeBranchPage }): Uint8Array {
  return encodeUInt64BranchPage({
    entries: page.entries,
    family: 'inode',
    isRoot,
    level: page.level,
    recordKind: RECORD_KINDS.inode_table_page,
  });
}

export function decodeInodeBranchPage({ bytes, isRoot }: { bytes: Uint8Array; isRoot: boolean }): InodeBranchPage {
  const page = decodeUInt64BranchPage({ bytes, family: 'inode', isRoot, recordKind: RECORD_KINDS.inode_table_page });
  return {
    entries: page.entries.map((entry) => ({
      childPageHomeRef: entry.childPageHomeRef,
      upperBound: createInodeNumber({ value: entry.upperBound }),
    })),
    level: page.level,
  };
}

export function assertFileExtentLeafEntryValid({ entry }: { entry: FileExtentLeafEntry }): void {
  if (!Number.isInteger(entry.byteLength) || entry.byteLength < 1 || entry.byteLength > HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes) {
    throw new RangeError('extent byte length is outside the File Data plaintext bound');
  }
  if (!Number.isInteger(entry.dataOffset) || entry.dataOffset < 0 || entry.dataOffset > 0xffff_ffff) {
    throw new RangeError('extent data offset is outside u32');
  }
  if (entry.dataOffset + entry.byteLength > HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes) {
    throw new RangeError('extent data range exceeds the maximum File Data payload');
  }
  if (entry.fileOffset + BigInt(entry.byteLength) > UINT64_MAXIMUM) {
    throw new RangeError('extent file range exceeds u64');
  }
  assertReferenceKind({ expected: RECORD_KINDS.file_data, label: 'extent File Data reference', reference: entry.fileDataHomeRef });
}

function validateExtentEntries({ entries }: { entries: readonly FileExtentLeafEntry[] }): void {
  let previousEnd: bigint | undefined;
  for (const entry of entries) {
    assertFileExtentLeafEntryValid({ entry });
    if (previousEnd !== undefined && entry.fileOffset < previousEnd) throw new TypeError('extent entries overlap or are not strictly ordered');
    previousEnd = entry.fileOffset + BigInt(entry.byteLength);
  }
}


export function assertFileExtentBranchEntryValid({ entry }: {
  entry: UInt64BranchEntry<FileOffset>;
}): void {
  assertReferenceKind({
    expected: RECORD_KINDS.file_extent_page,
    label: 'branch child reference',
    reference: entry.childPageHomeRef,
  });
}

export function encodeFileExtentPage({ isRoot, page }: { isRoot: boolean; page: FileExtentPage }): Uint8Array {
  switch (page.type) {
  case 'branch':
    return encodeUInt64BranchPage({
      entries: page.entries,
      family: 'fileExtent',
      isRoot,
      level: page.level,
      recordKind: RECORD_KINDS.file_extent_page,
    });
  case 'leaf': {
    validateExtentEntries({ entries: page.entries });
    const header = encodeCommonPageHeader({
      family: 'fileExtent',
      header: { itemCount: page.entries.length, level: 0 },
      isRoot,
    });
    const bytes = new Uint8Array(header.byteLength + page.entries.length * FIXED_SIZES.fileExtentLeafEntry);
    bytes.set(header);
    page.entries.forEach((entry, index) => {
      const offset = COMMON_PAGE_HEADER_SIZE + index * FIXED_SIZES.fileExtentLeafEntry;
      writeU64Be({ bytes, offset, value: entry.fileOffset });
      writeU32Be({ bytes, offset: offset + 8, value: entry.byteLength });
      writeU32Be({ bytes, offset: offset + 12, value: entry.dataOffset });
      writeHomeRecordReference({ bytes, offset: offset + 16, reference: entry.fileDataHomeRef });
    });
    return bytes;
  }
  default: {
    const exhaustive: never = page;
    throw new Error(`Unhandled File Extent page type: ${((exhaustive satisfies never) as { readonly type: string }).type}`);
  }
  }
}

export function decodeFileExtentPage({ bytes, isRoot }: { bytes: Uint8Array; isRoot: boolean }): FileExtentPage {
  const header = decodeCommonPageHeader({ bytes, family: 'fileExtent', isRoot });
  if (header.level !== 0) {
    const branch = decodeUInt64BranchPage({
      bytes,
      family: 'fileExtent',
      isRoot,
      recordKind: RECORD_KINDS.file_extent_page,
    });
    return {
      entries: branch.entries.map((entry) => ({
        childPageHomeRef: entry.childPageHomeRef,
        upperBound: createFileOffset({ value: entry.upperBound }),
      })),
      level: branch.level,
      type: 'branch',
    };
  }
  const expectedLength = COMMON_PAGE_HEADER_SIZE + header.itemCount * FIXED_SIZES.fileExtentLeafEntry;
  if (bytes.byteLength !== expectedLength) throw new RangeError('extent page length does not match item count');
  const entries: FileExtentLeafEntry[] = [];
  for (let index = 0; index < header.itemCount; index += 1) {
    const offset = COMMON_PAGE_HEADER_SIZE + index * FIXED_SIZES.fileExtentLeafEntry;
    entries.push({
      fileOffset: createFileOffset({ value: readU64Be({ bytes, offset }) }),
      byteLength: readU32Be({ bytes, offset: offset + 8 }),
      dataOffset: readU32Be({ bytes, offset: offset + 12 }),
      fileDataHomeRef: decodeRequiredHomeRecordReference({ bytes: bytes.subarray(offset + 16, offset + 48) }),
    });
  }
  validateExtentEntries({ entries });
  return { entries, level: 0, type: 'leaf' };
}

function compareRelocationKeys({ left, right }: { left: RelocationKey; right: RelocationKey }): number {
  const segmentOrder = compareUnsignedBytes({ left: left.homeSegmentId, right: right.homeSegmentId });
  if (segmentOrder !== 0) return segmentOrder;
  if (left.homeOffset === right.homeOffset) return 0;
  return left.homeOffset < right.homeOffset ? -1 : 1;
}

function validateRelocationKeyOrder({ current, previous }: {
  current: RelocationKey;
  previous: RelocationKey | undefined;
}): void {
  parseSegmentId({ bytes: current.homeSegmentId });
  if (current.homeOffset < 64n || current.homeOffset % 8n !== 0n) {
    throw new RangeError('relocation home offset must be aligned and after the Segment Header');
  }
  if (previous !== undefined && compareRelocationKeys({ left: previous, right: current }) >= 0) {
    throw new TypeError('relocation keys must be strictly ascending');
  }
}

export function encodeRelocationIndexPage({ isRoot, page }: { isRoot: boolean; page: RelocationIndexPage }): Uint8Array {
  switch (page.type) {
  case 'leaf':
    return encodeRelocationLeafPage({
      entries: page.entries,
      header: encodeCommonPageHeader({
        family: 'relocation',
        header: { itemCount: page.entries.length, level: 0 },
        isRoot,
      }),
    });
  case 'branch': {
    if (page.level < 1) throw new RangeError('relocation branch page level must be at least 1');
    const header = encodeCommonPageHeader({
      family: 'relocation',
      header: { itemCount: page.entries.length, level: page.level },
      isRoot,
    });
    const bytes = new Uint8Array(header.byteLength + page.entries.length * FIXED_SIZES.relocationBranchChild);
    bytes.set(header);
    let previous: RelocationKey | undefined;
    page.entries.forEach((entry, index) => {
      validateRelocationKeyOrder({ current: entry.upperBound, previous });
      assertReferenceKind({
        expected: RECORD_KINDS.relocation_index_page,
        label: 'relocation branch child reference',
        reference: entry.childPagePhysicalRef,
      });
      const offset = COMMON_PAGE_HEADER_SIZE + index * FIXED_SIZES.relocationBranchChild;
      bytes.set(entry.upperBound.homeSegmentId, offset);
      writeU64Be({ bytes, offset: offset + 16, value: entry.upperBound.homeOffset });
      bytes.set(encodePhysicalRecordReference({ reference: entry.childPagePhysicalRef }), offset + 24);
      previous = entry.upperBound;
    });
    return bytes;
  }
  default: {
    const exhaustive: never = page;
    throw new Error(`Unhandled Relocation Index page type: ${((exhaustive satisfies never) as { readonly type: string }).type}`);
  }
  }
}

function encodeRelocationLeafPage({ entries, header }: {
  entries: readonly RelocationLeafEntry[];
  header: Uint8Array;
}): Uint8Array {
  const bytes = new Uint8Array(header.byteLength + entries.length * FIXED_SIZES.relocationLeafEntry);
  bytes.set(header);
  let previous: RelocationKey | undefined;
  entries.forEach((entry, index) => {
    validateRelocationKeyOrder({ current: entry, previous });
    if (entry.currentPhysicalRecordRef.recordKind === RECORD_KINDS.relocation_index_page) {
      throw new TypeError('Relocation Index must not map a physical-only relocation page');
    }
    const offset = COMMON_PAGE_HEADER_SIZE + index * FIXED_SIZES.relocationLeafEntry;
    bytes.set(entry.homeSegmentId, offset);
    writeU64Be({ bytes, offset: offset + 16, value: entry.homeOffset });
    bytes.set(encodePhysicalRecordReference({ reference: entry.currentPhysicalRecordRef }), offset + 24);
    previous = entry;
  });
  return bytes;
}

export function encodeRelocationLeafIndexPage({ entries, isRoot }: {
  entries: readonly RelocationLeafEntry[];
  isRoot: boolean;
}): Uint8Array {
  return encodeRelocationLeafPage({
    entries,
    header: encodeCommonPageHeader({ family: 'relocation', header: { itemCount: entries.length, level: 0 }, isRoot }),
  });
}

export function decodeRelocationIndexPage({ bytes, isRoot }: { bytes: Uint8Array; isRoot: boolean }): RelocationIndexPage {
  const header = decodeCommonPageHeader({ bytes, family: 'relocation', isRoot });
  const expectedLength = COMMON_PAGE_HEADER_SIZE + header.itemCount * FIXED_SIZES.relocationLeafEntry;
  if (bytes.byteLength !== expectedLength) throw new RangeError('relocation page length does not match item count');
  let previous: RelocationKey | undefined;
  if (header.level === 0) {
    const entries: RelocationLeafEntry[] = [];
    for (let index = 0; index < header.itemCount; index += 1) {
      const offset = COMMON_PAGE_HEADER_SIZE + index * FIXED_SIZES.relocationLeafEntry;
      const entry: RelocationLeafEntry = {
        homeSegmentId: parseSegmentId({ bytes: bytes.subarray(offset, offset + 16) }),
        homeOffset: readU64Be({ bytes, offset: offset + 16 }),
        currentPhysicalRecordRef: decodeRequiredPhysicalRecordReference({ bytes: bytes.subarray(offset + 24, offset + 56) }),
      };
      validateRelocationKeyOrder({ current: entry, previous });
      if (entry.currentPhysicalRecordRef.recordKind === RECORD_KINDS.relocation_index_page) {
        throw new TypeError('Relocation Index must not map a physical-only relocation page');
      }
      entries.push(entry);
      previous = entry;
    }
    return { entries, level: 0, type: 'leaf' };
  }
  const entries: RelocationBranchEntry[] = [];
  for (let index = 0; index < header.itemCount; index += 1) {
    const offset = COMMON_PAGE_HEADER_SIZE + index * FIXED_SIZES.relocationBranchChild;
    const upperBound: RelocationKey = {
      homeSegmentId: parseSegmentId({ bytes: bytes.subarray(offset, offset + 16) }),
      homeOffset: readU64Be({ bytes, offset: offset + 16 }),
    };
    validateRelocationKeyOrder({ current: upperBound, previous });
    const childPagePhysicalRef = decodeRequiredPhysicalRecordReference({ bytes: bytes.subarray(offset + 24, offset + 56) });
    assertReferenceKind({ expected: RECORD_KINDS.relocation_index_page, label: 'relocation branch child reference', reference: childPagePhysicalRef });
    entries.push({ childPagePhysicalRef, upperBound });
    previous = upperBound;
  }
  return { entries, level: header.level, type: 'branch' };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
