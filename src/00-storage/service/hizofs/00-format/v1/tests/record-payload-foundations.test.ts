import { describe, expect, it } from 'vitest';
import {
  createHomeRecordReference,
  createPhysicalRecordReference,
} from '@/00-storage/service/hizofs/00-format/v1/binary/record-reference';
import { decodeCommonPageHeader, encodeCommonPageHeader } from '@/00-storage/service/hizofs/00-format/v1/pages/common-page';
import {
  decodeFileExtentPage,
  decodeInodeBranchPage,
  decodeNestedSubvolumeBranchPage,
  decodeRelocationIndexPage,
  encodeFileExtentPage,
  encodeInodeBranchPage,
  encodeNestedSubvolumeBranchPage,
  encodeRelocationIndexPage,
} from '@/00-storage/service/hizofs/00-format/v1/pages/fixed-pages';
import { decodeFileDataPayload, encodeFileDataPayload } from '@/00-storage/service/hizofs/00-format/v1/records/file-data';
import {
  createFileSystemCommitPayload,
  decodeFileSystemCommitPayload,
  encodeFileSystemCommitPayload,
} from '@/00-storage/service/hizofs/00-format/v1/records/file-system-commit';
import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';
import { parseMutationId, parseSegmentId } from '@/00-storage/service/hizofs/00-format/v1/identifiers';
import {
  createCommitSequence,
  createFileOffset,
  createInodeNumber,
  createSubvolumeId,
  createUInt64,
} from '@/00-storage/service/hizofs/00-format/v1/scalars';

const KINDS = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;

const segmentId = ({ seed }: { seed: number }) => parseSegmentId({
  bytes: Uint8Array.from({ length: 16 }, (_, index) => (seed + index) & 0xff),
});

const homeRef = ({ kind, offset = 64n, seed = 1 }: {
  kind: number;
  offset?: bigint;
  seed?: number;
}) => createHomeRecordReference({ fields: {
  byteOffset: createUInt64({ value: offset }),
  frameLength: 96,
  recordKind: kind,
  segmentId: segmentId({ seed }),
} });

const physicalRef = ({ kind, offset = 64n, seed = 1 }: {
  kind: number;
  offset?: bigint;
  seed?: number;
}) => createPhysicalRecordReference({ fields: {
  byteOffset: createUInt64({ value: offset }),
  frameLength: 96,
  recordKind: kind,
  segmentId: segmentId({ seed }),
} });

describe('record payload foundations', () => {
  it('validates common page bounds before item allocation', () => {
    const header = encodeCommonPageHeader({
      family: 'directory',
      header: { itemCount: 0, level: 0 },
      isRoot: true,
    });
    expect(decodeCommonPageHeader({ bytes: header, family: 'directory', isRoot: true })).toEqual({
      itemCount: 0,
      level: 0,
    });
    expect(() => encodeCommonPageHeader({
      family: 'directory',
      header: { itemCount: 0, level: 0 },
      isRoot: false,
    })).toThrow('empty root leaf');
    expect(() => encodeCommonPageHeader({
      family: 'fileExtent',
      header: {
        itemCount: HIZOFS_V1_FORMAT_CONSTANTS.pageItemMaximumCounts.fileExtentLeaf + 1,
        level: 0,
      },
      isRoot: true,
    })).toThrow('allocation-safe');
  });

  it('round-trips a File System Commit and validates reference kinds', () => {
    const payload = createFileSystemCommitPayload({ payload: {
      commitSequence: createCommitSequence({ value: 5n }),
      mutationId: parseMutationId({ bytes: new Uint8Array(16).fill(7) }),
      nestedSubvolumeTableRootHomeRef: homeRef({ kind: KINDS.nested_subvolume_table_page, offset: 160n }),
      nextInodeNumber: createInodeNumber({ value: 9n }),
      nextSubvolumeId: createSubvolumeId({ value: 4n }),
      rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      rootInodeTableRootHomeRef: homeRef({ kind: KINDS.inode_table_page }),
    } });
    expect(decodeFileSystemCommitPayload({ bytes: encodeFileSystemCommitPayload({ payload }) })).toEqual(payload);
    expect(() => encodeFileSystemCommitPayload({ payload: {
      ...payload,
      rootInodeTableRootHomeRef: homeRef({ kind: KINDS.directory_page }),
    } })).toThrow('wrong record kind');
    expect(() => encodeFileSystemCommitPayload({ payload: {
      ...payload,
      mutationId: new Uint8Array(16) as never,
    } })).toThrow('all-zero');
  });

  it('copies File Data bytes and enforces the exact payload bound', () => {
    const input = Uint8Array.of(1, 2, 3);
    const encoded = encodeFileDataPayload({ payload: { bytes: input } });
    input[0] = 9;
    expect(encoded).toEqual(Uint8Array.of(1, 2, 3));
    expect(decodeFileDataPayload({ bytes: encoded }).bytes).toEqual(encoded);
    expect(() => encodeFileDataPayload({ payload: { bytes: new Uint8Array() } })).toThrow('1..1,048,576');
  });

  it('round-trips fixed UInt64 branch pages and rejects unordered bounds', () => {
    const nested = {
      entries: [
        { childPageHomeRef: homeRef({ kind: KINDS.nested_subvolume_table_page, seed: 2 }), upperBound: createSubvolumeId({ value: 3n }) },
        { childPageHomeRef: homeRef({ kind: KINDS.nested_subvolume_table_page, offset: 160n, seed: 3 }), upperBound: createSubvolumeId({ value: 9n }) },
      ],
      level: 1,
    };
    expect(decodeNestedSubvolumeBranchPage({
      bytes: encodeNestedSubvolumeBranchPage({ isRoot: true, page: nested }),
      isRoot: true,
    })).toEqual(nested);

    const inode = {
      entries: [{ childPageHomeRef: homeRef({ kind: KINDS.inode_table_page }), upperBound: createInodeNumber({ value: 8n }) }],
      level: 2,
    };
    expect(decodeInodeBranchPage({ bytes: encodeInodeBranchPage({ isRoot: true, page: inode }), isRoot: true })).toEqual(inode);
    expect(() => encodeInodeBranchPage({
      isRoot: true,
      page: { entries: [inode.entries[0]!, inode.entries[0]!], level: 1 },
    })).toThrow('strictly ascending');
  });

  it('round-trips sparse extent pages and rejects overlap and wrong kinds', () => {
    const leaf = {
      entries: [
        {
          byteLength: 4,
          dataOffset: 0,
          fileDataHomeRef: homeRef({ kind: KINDS.file_data, seed: 4 }),
          fileOffset: createFileOffset({ value: 0n }),
        },
        {
          byteLength: 8,
          dataOffset: 16,
          fileDataHomeRef: homeRef({ kind: KINDS.file_data, offset: 160n, seed: 5 }),
          fileOffset: createFileOffset({ value: 20n }),
        },
      ],
      level: 0 as const,
      type: 'leaf' as const,
    };
    expect(decodeFileExtentPage({ bytes: encodeFileExtentPage({ isRoot: true, page: leaf }), isRoot: true })).toEqual(leaf);
    expect(() => encodeFileExtentPage({
      isRoot: true,
      page: {
        ...leaf,
        entries: [leaf.entries[0]!, { ...leaf.entries[1]!, fileOffset: createFileOffset({ value: 2n }) }],
      },
    })).toThrow('overlap');
    expect(() => encodeFileExtentPage({
      isRoot: true,
      page: {
        ...leaf,
        entries: [{ ...leaf.entries[0]!, fileDataHomeRef: homeRef({ kind: KINDS.directory_page }) }],
      },
    })).toThrow('wrong record kind');
  });

  it('round-trips chain-free relocation leaf and branch pages', () => {
    const leaf = {
      entries: [
        {
          currentPhysicalRecordRef: physicalRef({ kind: KINDS.file_data, seed: 8 }),
          homeOffset: createUInt64({ value: 64n }),
          homeSegmentId: segmentId({ seed: 6 }),
        },
        {
          currentPhysicalRecordRef: physicalRef({ kind: KINDS.directory_page, offset: 160n, seed: 9 }),
          homeOffset: createUInt64({ value: 64n }),
          homeSegmentId: segmentId({ seed: 7 }),
        },
      ],
      level: 0 as const,
      type: 'leaf' as const,
    };
    expect(decodeRelocationIndexPage({
      bytes: encodeRelocationIndexPage({ isRoot: true, page: leaf }),
      isRoot: true,
    })).toEqual(leaf);

    const branch = {
      entries: [{
        childPagePhysicalRef: physicalRef({ kind: KINDS.relocation_index_page, seed: 10 }),
        upperBound: { homeOffset: createUInt64({ value: 64n }), homeSegmentId: segmentId({ seed: 7 }) },
      }],
      level: 1,
      type: 'branch' as const,
    };
    expect(decodeRelocationIndexPage({
      bytes: encodeRelocationIndexPage({ isRoot: true, page: branch }),
      isRoot: true,
    })).toEqual(branch);
    expect(() => encodeRelocationIndexPage({
      isRoot: true,
      page: {
        ...leaf,
        entries: [{
          ...leaf.entries[0]!,
          currentPhysicalRecordRef: physicalRef({ kind: KINDS.relocation_index_page }),
        }],
      },
    })).toThrow('physical-only relocation page');
  });
});

export const TEST_ONLY = {};
