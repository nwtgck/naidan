import { describe, expect, it } from 'vitest';
import { createHomeRecordReference } from '@/00-storage/service/hizofs/00-format/v1/binary/record-reference';
import {
  assertDirectoryLeafEntryFitsMetadataPage,
  decodeDirectoryPage,
  decodeNestedSubvolumeLeafPage,
  encodeDirectoryEntry,
  encodeDirectoryPage,
  encodedDirectoryLeafEntryByteLength,
  encodeNestedSubvolumeLeafPage,
} from '@/00-storage/service/hizofs/00-format/v1/pages/variable-pages';
import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';
import { parseSegmentId } from '@/00-storage/service/hizofs/00-format/v1/identifiers';
import {
  createInodeNumber,
  createSubvolumeId,
  createUInt64,
} from '@/00-storage/service/hizofs/00-format/v1/scalars';

const KINDS = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;
const segmentId = ({ seed }: { seed: number }) => parseSegmentId({
  bytes: Uint8Array.from({ length: 16 }, (_, index) => (seed + index) & 0xff),
});
const homeRef = ({ kind, offset = 64n, seed = 1 }: { kind: number; offset?: bigint; seed?: number }) =>
  createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: offset }),
    frameLength: 96,
    recordKind: kind,
    segmentId: segmentId({ seed }),
  } });

describe('variable page codecs', () => {
  it('round-trips nested Subvolume leaves and preserves mount metadata', () => {
    const entries = [
      {
        access: 'read_write' as const,
        entryName: 'alpha',
        inodeTableRootHomeRef: homeRef({ kind: KINDS.inode_table_page, seed: 2 }),
        parentDirectoryInodeNumber: createInodeNumber({ value: 1n }),
        parentSubvolumeId: createSubvolumeId({ value: 1n }),
        rootDirectoryInodeNumber: createInodeNumber({ value: 7n }),
        subvolumeId: createSubvolumeId({ value: 2n }),
      },
      {
        access: 'read' as const,
        entryName: 'βeta',
        inodeTableRootHomeRef: homeRef({ kind: KINDS.inode_table_page, offset: 160n, seed: 3 }),
        parentDirectoryInodeNumber: createInodeNumber({ value: 8n }),
        parentSubvolumeId: createSubvolumeId({ value: 2n }),
        rootDirectoryInodeNumber: createInodeNumber({ value: 9n }),
        subvolumeId: createSubvolumeId({ value: 3n }),
      },
    ];
    const encoded = encodeNestedSubvolumeLeafPage({ entries, isRoot: true });
    expect(decodeNestedSubvolumeLeafPage({ bytes: encoded, isRoot: true }).entries).toEqual(entries);
  });

  it('rejects nested Subvolume ordering, self-mount, and corrupt entry lengths', () => {
    const base = {
      access: 'read_write' as const,
      entryName: 'alpha',
      inodeTableRootHomeRef: homeRef({ kind: KINDS.inode_table_page }),
      parentDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      parentSubvolumeId: createSubvolumeId({ value: 1n }),
      rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      subvolumeId: createSubvolumeId({ value: 2n }),
    };
    expect(() => encodeNestedSubvolumeLeafPage({ entries: [base, base], isRoot: true })).toThrow('strictly ascending');
    expect(() => encodeNestedSubvolumeLeafPage({
      entries: [{ ...base, parentSubvolumeId: createSubvolumeId({ value: 2n }) }],
      isRoot: true,
    })).toThrow('mount into itself');
    const bytes = encodeNestedSubvolumeLeafPage({ entries: [base], isRoot: true });
    bytes[5] = 1;
    expect(() => decodeNestedSubvolumeLeafPage({ bytes, isRoot: true })).toThrow('entry length');
  });

  it('validates one directory leaf entry without materializing a complete page', () => {
    const entry = {
      inodeKind: 'file' as const,
      inodeNumber: createInodeNumber({ value: 4n }),
      name: 'entry',
      targetType: 'inode' as const,
    };
    expect(() => assertDirectoryLeafEntryFitsMetadataPage({ entry })).not.toThrow();
    expect(() => assertDirectoryLeafEntryFitsMetadataPage({
      entry: { ...entry, inodeNumber: createInodeNumber({ value: 0n }) },
    })).toThrow('at least 1');
  });

  it('measures directory leaf entries exactly without materializing the complete entry', () => {
    const entries = [
      { inodeKind: 'file' as const, inodeNumber: createInodeNumber({ value: 4n }), name: 'entry', targetType: 'inode' as const },
      { inodeKind: 'directory' as const, inodeNumber: createInodeNumber({ value: 5n }), name: '日本語', targetType: 'inode' as const },
      { name: 'subvolume', subvolumeId: createSubvolumeId({ value: 2n }), targetType: 'subvolume' as const },
    ];
    for (const entry of entries) {
      expect(encodedDirectoryLeafEntryByteLength({ entry })).toBe(encodeDirectoryEntry({ entry }).byteLength);
    }
    expect(() => encodedDirectoryLeafEntryByteLength({ entry: {
      inodeKind: 'file' as const,
      inodeNumber: createInodeNumber({ value: 0n }),
      name: 'invalid',
      targetType: 'inode' as const,
    } })).toThrow('at least 1');
  });

  it('round-trips directory inode and Subvolume targets in UTF-8 order', () => {
    const page = {
      entries: [
        { inodeKind: 'file' as const, inodeNumber: createInodeNumber({ value: 4n }), name: 'a', targetType: 'inode' as const },
        { inodeKind: 'directory' as const, inodeNumber: createInodeNumber({ value: 5n }), name: 'b', targetType: 'inode' as const },
        { name: 'é', subvolumeId: createSubvolumeId({ value: 2n }), targetType: 'subvolume' as const },
      ],
      level: 0 as const,
      type: 'leaf' as const,
    };
    expect(decodeDirectoryPage({ bytes: encodeDirectoryPage({ isRoot: true, page }), isRoot: true })).toEqual(page);
  });

  it('round-trips directory branch bounds and rejects duplicates and wrong kinds', () => {
    const page = {
      entries: [
        { childPageHomeRef: homeRef({ kind: KINDS.directory_page, seed: 4 }), upperBoundName: 'm' },
        { childPageHomeRef: homeRef({ kind: KINDS.directory_page, offset: 160n, seed: 5 }), upperBoundName: 'z' },
      ],
      level: 2,
      type: 'branch' as const,
    };
    expect(decodeDirectoryPage({ bytes: encodeDirectoryPage({ isRoot: true, page }), isRoot: true })).toEqual(page);
    expect(() => encodeDirectoryPage({
      isRoot: true,
      page: { ...page, entries: [page.entries[0]!, page.entries[0]!] },
    })).toThrow('strictly ascending');
    expect(() => encodeDirectoryPage({
      isRoot: true,
      page: {
        ...page,
        entries: [{ childPageHomeRef: homeRef({ kind: KINDS.inode_table_page }), upperBoundName: 'm' }],
      },
    })).toThrow('wrong record kind');
  });

  it('rejects malformed directory target tags and trailing bytes', () => {
    const page = {
      entries: [{ inodeKind: 'file' as const, inodeNumber: createInodeNumber({ value: 4n }), name: 'a', targetType: 'inode' as const }],
      level: 0 as const,
      type: 'leaf' as const,
    };
    const encoded = encodeDirectoryPage({ isRoot: true, page });
    const unknownTarget = Uint8Array.from(encoded);
    unknownTarget[6] = 99;
    expect(() => decodeDirectoryPage({ bytes: unknownTarget, isRoot: true })).toThrow('target type');
    const trailing = new Uint8Array(encoded.byteLength + 1);
    trailing.set(encoded);
    expect(() => decodeDirectoryPage({ bytes: trailing, isRoot: true })).toThrow('trailing bytes');
  });
});

export const TEST_ONLY = {};
