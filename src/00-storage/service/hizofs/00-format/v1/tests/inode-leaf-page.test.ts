import { describe, expect, it } from 'vitest';
import { createHomeRecordReference } from '@/00-storage/service/hizofs/00-format/v1/binary/record-reference';
import { decodeInodeLeafPage, encodeInodeLeafPage } from '@/00-storage/service/hizofs/00-format/v1/pages/inode-leaf-page';
import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';
import { parseSegmentId } from '@/00-storage/service/hizofs/00-format/v1/identifiers';
import { createFileOffset, createInodeNumber, createInodeRevision, createSubvolumeId, createTimestampMilliseconds, createUInt64 } from '@/00-storage/service/hizofs/00-format/v1/scalars';
import knownAnswerVectors from '@/00-storage/service/hizofs/00-format/v1/test-fixtures/known-answer-vectors-v1.json';

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
const noTimestamps = { createdAt: null, modifiedAt: null } as const;

const toHex = ({ bytes }: { bytes: Uint8Array }): string => [...bytes]
  .map(byte => byte.toString(16).padStart(2, '0'))
  .join('');

describe('Inode Table leaf codec', () => {
  it('round-trips every inode representation and optional timestamps', () => {
    const entries = [
      {
        content: { bytes: Uint8Array.of(1, 2, 3), type: 'inline' as const },
        fileSize: createFileOffset({ value: 3n }),
        inodeKind: 'file' as const,
        inodeNumber: createInodeNumber({ value: 1n }),
        inodeRevision: createInodeRevision({ value: 2n }),
        timestamps: {
          createdAt: createTimestampMilliseconds({ value: -10n }),
          modifiedAt: createTimestampMilliseconds({ value: 20n }),
        },
      },
      {
        content: { extentTreeRootHomeRef: homeRef({ kind: KINDS.file_extent_page, seed: 2 }), type: 'tree' as const },
        fileSize: createFileOffset({ value: 9000n }),
        inodeKind: 'file' as const,
        inodeNumber: createInodeNumber({ value: 2n }),
        inodeRevision: createInodeRevision({ value: 1n }),
        timestamps: noTimestamps,
      },
      {
        content: {
          entries: [
            { inodeKind: 'file' as const, inodeNumber: createInodeNumber({ value: 1n }), name: 'a', targetType: 'inode' as const },
            { name: 'b', subvolumeId: createSubvolumeId({ value: 2n }), targetType: 'subvolume' as const },
          ],
          type: 'inline' as const,
        },
        inodeKind: 'directory' as const,
        inodeNumber: createInodeNumber({ value: 3n }),
        inodeRevision: createInodeRevision({ value: 4n }),
        timestamps: noTimestamps,
      },
      {
        content: { directoryTreeRootHomeRef: homeRef({ kind: KINDS.directory_page, seed: 3 }), type: 'tree' as const },
        inodeKind: 'directory' as const,
        inodeNumber: createInodeNumber({ value: 4n }),
        inodeRevision: createInodeRevision({ value: 1n }),
        timestamps: noTimestamps,
      },
      {
        inodeKind: 'symlink' as const,
        inodeNumber: createInodeNumber({ value: 5n }),
        inodeRevision: createInodeRevision({ value: 1n }),
        target: '../target/α',
        timestamps: { createdAt: null, modifiedAt: createTimestampMilliseconds({ value: 30n }) },
      },
    ];
    const bytes = encodeInodeLeafPage({ entries, isRoot: true });
    expect(decodeInodeLeafPage({ bytes, isRoot: true }).entries).toEqual(entries);
  });

  it('matches the independent inline namespace known-answer bytes', () => {
    const bytes = encodeInodeLeafPage({
      entries: [
        {
          content: {
            entries: [
              { inodeKind: 'file' as const, inodeNumber: createInodeNumber({ value: 2n }), name: 'hello.txt', targetType: 'inode' as const },
              { inodeKind: 'directory' as const, inodeNumber: createInodeNumber({ value: 3n }), name: 'sub', targetType: 'inode' as const },
              { inodeKind: 'symlink' as const, inodeNumber: createInodeNumber({ value: 4n }), name: 'sym', targetType: 'inode' as const },
            ],
            type: 'inline' as const,
          },
          inodeKind: 'directory' as const,
          inodeNumber: createInodeNumber({ value: 1n }),
          inodeRevision: createInodeRevision({ value: 1n }),
          timestamps: noTimestamps,
        },
        {
          content: { bytes: Uint8Array.of(0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x0a), type: 'inline' as const },
          fileSize: createFileOffset({ value: 6n }),
          inodeKind: 'file' as const,
          inodeNumber: createInodeNumber({ value: 2n }),
          inodeRevision: createInodeRevision({ value: 3n }),
          timestamps: {
            createdAt: createTimestampMilliseconds({ value: -10n }),
            modifiedAt: createTimestampMilliseconds({ value: 20n }),
          },
        },
        {
          content: { entries: [], type: 'inline' as const },
          inodeKind: 'directory' as const,
          inodeNumber: createInodeNumber({ value: 3n }),
          inodeRevision: createInodeRevision({ value: 1n }),
          timestamps: noTimestamps,
        },
        {
          inodeKind: 'symlink' as const,
          inodeNumber: createInodeNumber({ value: 4n }),
          inodeRevision: createInodeRevision({ value: 2n }),
          target: '../hello.txt',
          timestamps: { createdAt: null, modifiedAt: createTimestampMilliseconds({ value: 30n }) },
        },
      ],
      isRoot: true,
    });
    expect(toHex({ bytes })).toBe(knownAnswerVectors.expected.inodeLeafPageHex);
  });

  it('rejects invalid inline state, wrong references, and unordered keys', () => {
    const file = {
      content: { bytes: Uint8Array.of(1), type: 'inline' as const },
      fileSize: createFileOffset({ value: 2n }),
      inodeKind: 'file' as const,
      inodeNumber: createInodeNumber({ value: 1n }),
      inodeRevision: createInodeRevision({ value: 1n }),
      timestamps: noTimestamps,
    };
    expect(() => encodeInodeLeafPage({ entries: [file], isRoot: true })).toThrow('equal fileSize');

    const treeFile = {
      ...file,
      content: { extentTreeRootHomeRef: homeRef({ kind: KINDS.directory_page }), type: 'tree' as const },
      fileSize: createFileOffset({ value: 2n }),
    };
    expect(() => encodeInodeLeafPage({ entries: [treeFile], isRoot: true })).toThrow('wrong record kind');

    const valid = { ...file, content: { bytes: Uint8Array.of(1, 2), type: 'inline' as const } };
    expect(() => encodeInodeLeafPage({ entries: [valid, valid], isRoot: true })).toThrow('strictly ascending');
  });

  it('rejects unordered inline directory entries and malformed timestamp bits', () => {
    const directory = {
      content: {
        entries: [
          { inodeKind: 'file' as const, inodeNumber: createInodeNumber({ value: 1n }), name: 'z', targetType: 'inode' as const },
          { inodeKind: 'file' as const, inodeNumber: createInodeNumber({ value: 2n }), name: 'a', targetType: 'inode' as const },
        ],
        type: 'inline' as const,
      },
      inodeKind: 'directory' as const,
      inodeNumber: createInodeNumber({ value: 1n }),
      inodeRevision: createInodeRevision({ value: 1n }),
      timestamps: noTimestamps,
    };
    expect(() => encodeInodeLeafPage({ entries: [directory], isRoot: true })).toThrow('strictly ascending');

    const symlink = {
      inodeKind: 'symlink' as const,
      inodeNumber: createInodeNumber({ value: 1n }),
      inodeRevision: createInodeRevision({ value: 1n }),
      target: 'target',
      timestamps: noTimestamps,
    };
    const bytes = encodeInodeLeafPage({ entries: [symlink], isRoot: true });
    bytes[7] = 4;
    expect(() => decodeInodeLeafPage({ bytes, isRoot: true })).toThrow('unknown bits');
  });

  it('rejects entry length corruption and trailing bytes', () => {
    const symlink = {
      inodeKind: 'symlink' as const,
      inodeNumber: createInodeNumber({ value: 1n }),
      inodeRevision: createInodeRevision({ value: 1n }),
      target: 'target',
      timestamps: noTimestamps,
    };
    const bytes = encodeInodeLeafPage({ entries: [symlink], isRoot: true });
    bytes[5] = 1;
    expect(() => decodeInodeLeafPage({ bytes, isRoot: true })).toThrow('entry length');

    const trailing = new Uint8Array(bytes.byteLength + 1);
    trailing.set(encodeInodeLeafPage({ entries: [symlink], isRoot: true }));
    expect(() => decodeInodeLeafPage({ bytes: trailing, isRoot: true })).toThrow('trailing bytes');
  });
});

export const TEST_ONLY = {};
