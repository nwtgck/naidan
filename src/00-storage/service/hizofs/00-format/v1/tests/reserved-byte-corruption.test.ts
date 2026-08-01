import { describe, expect, it } from 'vitest';
import {
  createSegmentFooterHeader,
  decodeSegmentFooterHeader,
  decodeSegmentFooterIndexEntry,
  encodeSegmentFooterHeader,
  encodeSegmentFooterIndexEntry,
} from '@/00-storage/service/hizofs/00-format/v1/binary/segment-footer';
import { decodeSegmentHeader, encodeSegmentHeader } from '@/00-storage/service/hizofs/00-format/v1/binary/segment-header';
import { createSuperblockHeader, decodeSuperblockHeader, encodeSuperblockHeader } from '@/00-storage/service/hizofs/00-format/v1/binary/superblock';
import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';
import { parseFileSystemId, parseSegmentId } from '@/00-storage/service/hizofs/00-format/v1/identifiers';
import {
  createCommitSequence,
  createPublicationSequence,
  createUInt64,
} from '@/00-storage/service/hizofs/00-format/v1/scalars';

function segmentId(): ReturnType<typeof parseSegmentId> {
  return parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => index + 1) });
}

function expectEveryReservedByteRejected({ bytes, decode, offsets }: {
  bytes: Uint8Array;
  decode: ({ bytes }: { bytes: Uint8Array }) => unknown;
  offsets: readonly number[];
}): void {
  for (const offset of offsets) {
    const damaged = Uint8Array.from(bytes);
    damaged[offset] = 1;
    expect(() => decode({ bytes: damaged }), `reserved byte ${offset}`).toThrow('reserved');
  }
}

describe('reserved-byte corruption fixtures', () => {
  it('rejects every Segment Header reserved byte', () => {
    const bytes = encodeSegmentHeader({
      header: {
        authenticationTag: new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.crypto.tagBytes),
        physicalSegmentId: segmentId(),
        segmentClass: 'metadata',
      },
    });
    expectEveryReservedByteRejected({
      bytes,
      decode: decodeSegmentHeader,
      offsets: [13, 14, 15, ...Array.from({ length: 16 }, (_, index) => index + 32)],
    });
  });

  it('rejects every Segment Footer Header reserved byte', () => {
    const bytes = encodeSegmentFooterHeader({
      header: createSegmentFooterHeader({
        entryCount: 1,
        nonce: new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.crypto.nonceBytes),
        physicalSegmentId: segmentId(),
        segmentClass: 'metadata',
        segmentDataLength: createUInt64({ value: 64n }),
      }),
    });
    expectEveryReservedByteRejected({
      bytes,
      decode: decodeSegmentFooterHeader,
      offsets: [13, 14, 15, 60, 61, 62, 63],
    });
  });

  it('rejects every Segment Footer Index Entry reserved byte', () => {
    const bytes = encodeSegmentFooterIndexEntry({
      entry: {
        flags: 0,
        frameLength: 80,
        homeOffset: createUInt64({ value: 64n }),
        homeSegmentId: segmentId(),
        physicalOffset: createUInt64({ value: 64n }),
        plaintextLength: 0,
        recordCodecVersion: 1,
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
      },
    });
    expectEveryReservedByteRejected({ bytes, decode: decodeSegmentFooterIndexEntry, offsets: [44, 45, 46, 47] });
  });

  it('rejects every Superblock Header reserved byte', () => {
    const bytes = encodeSuperblockHeader({
      header: createSuperblockHeader({
        activeCommitSequence: createCommitSequence({ value: 1n }),
        copy: 0,
        fileSystemId: parseFileSystemId({ value: '0123456789_ABCDEFGHIJ' }),
        flags: 0,
        nonce: new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.crypto.nonceBytes),
        publicationSequence: createPublicationSequence({ value: 1n }),
      }),
    });
    expectEveryReservedByteRejected({
      bytes,
      decode: decodeSuperblockHeader,
      offsets: [14, 15, ...Array.from({ length: 10 }, (_, index) => index + 70)],
    });
  });
});
