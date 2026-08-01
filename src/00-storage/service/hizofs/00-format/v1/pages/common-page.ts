import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';
import { readU16Be, writeU16Be } from '@/00-storage/service/hizofs/00-format/v1/binary/scalars';

const HEADER_SIZE = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.commonPageHeader;

export type PageFamily = 'nestedSubvolume' | 'inode' | 'directory' | 'fileExtent' | 'relocation';

export type CommonPageHeader = Readonly<{
  itemCount: number;
  level: number;
}>;

const MAXIMUM_COUNTS = HIZOFS_V1_FORMAT_CONSTANTS.pageItemMaximumCounts;

function maximumItemCount({ family, level }: { family: PageFamily; level: number }): number {
  const leaf = level === 0;
  switch (family) {
  case 'nestedSubvolume': return leaf ? MAXIMUM_COUNTS.nestedSubvolumeLeaf : MAXIMUM_COUNTS.nestedSubvolumeBranch;
  case 'inode': return leaf ? MAXIMUM_COUNTS.inodeLeaf : MAXIMUM_COUNTS.inodeBranch;
  case 'directory': return leaf ? MAXIMUM_COUNTS.directoryLeaf : MAXIMUM_COUNTS.directoryBranch;
  case 'fileExtent': return leaf ? MAXIMUM_COUNTS.fileExtentLeaf : MAXIMUM_COUNTS.fileExtentBranch;
  case 'relocation': return leaf ? MAXIMUM_COUNTS.relocationLeaf : MAXIMUM_COUNTS.relocationBranch;
  default: return family satisfies never;
  }
}

function validateHeader({ family, header, isRoot }: {
  family: PageFamily;
  header: CommonPageHeader;
  isRoot: boolean;
}): void {
  if (!Number.isInteger(header.level) || header.level < 0 || header.level > 0xff) {
    throw new RangeError('page level must be an unsigned byte');
  }
  if (!Number.isInteger(header.itemCount) || header.itemCount < 0 || header.itemCount > 0xffff) {
    throw new RangeError('page item count must be an unsigned 16-bit integer');
  }
  if (header.itemCount === 0 && (!isRoot || header.level !== 0)) {
    throw new TypeError('only an empty root leaf may contain zero items');
  }
  if (header.itemCount > maximumItemCount({ family, level: header.level })) {
    throw new RangeError('page item count exceeds the allocation-safe V1 maximum');
  }
}

export function encodeCommonPageHeader({ family, header, isRoot }: {
  family: PageFamily;
  header: CommonPageHeader;
  isRoot: boolean;
}): Uint8Array {
  validateHeader({ family, header, isRoot });
  const bytes = new Uint8Array(HEADER_SIZE);
  bytes[0] = header.level;
  writeU16Be({ bytes, offset: 2, value: header.itemCount });
  return bytes;
}

export function decodeCommonPageHeader({ bytes, family, isRoot }: {
  bytes: Uint8Array;
  family: PageFamily;
  isRoot: boolean;
}): CommonPageHeader {
  if (bytes.byteLength < HEADER_SIZE) throw new RangeError('page is shorter than the common header');
  if (bytes.byteLength > HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataPlaintextBytes) {
    throw new RangeError('page exceeds the V1 metadata plaintext maximum');
  }
  if (bytes[1] !== 0) throw new TypeError('page flags must be zero');
  const level = bytes[0];
  if (level === undefined) throw new Error('page level offset invariant failed');
  const header = { itemCount: readU16Be({ bytes, offset: 2 }), level };
  validateHeader({ family, header, isRoot });
  return header;
}

export const COMMON_PAGE_HEADER_SIZE = HEADER_SIZE;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
