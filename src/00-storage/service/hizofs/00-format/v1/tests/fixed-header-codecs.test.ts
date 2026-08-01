import { describe, expect, it } from 'vitest';
import { createRecordFrameHeader, decodeRecordFrameHeader, encodeRecordFrameHeader } from '@/00-storage/service/hizofs/00-format/v1/binary/record-frame-header';
import {
  calculateSegmentFooterTotalLength,
  createSegmentFooterHeader,
  decodeSegmentFooterHeader,
  decodeSegmentFooterIndexEntry,
  decodeSegmentFooterTrailer,
  encodeSegmentFooterHeader,
  encodeSegmentFooterIndexEntry,
  encodeSegmentFooterTrailer,
} from '@/00-storage/service/hizofs/00-format/v1/binary/segment-footer';
import { decodeSegmentHeader, encodeSegmentHeader, segmentHeaderAuthenticatedPrefix } from '@/00-storage/service/hizofs/00-format/v1/binary/segment-header';
import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';
import { parseSegmentId } from '@/00-storage/service/hizofs/00-format/v1/identifiers';
import { createUInt64 } from '@/00-storage/service/hizofs/00-format/v1/scalars';

function segmentId() {
  return parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => index + 1) });
}

describe('HizoFS V1 fixed headers', () => {
  it('roundtrips the exact Segment Header layout and rejects structural corruption', () => {
    const header = {
      authenticationTag: Uint8Array.from({ length: 16 }, (_, index) => 0xa0 + index),
      physicalSegmentId: segmentId(),
      segmentClass: 'metadata' as const,
    };
    const bytes = encodeSegmentHeader({ header });
    expect(bytes.byteLength).toBe(64);
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('HZSEGMNT');
    expect(bytes[12]).toBe(1);
    expect(segmentHeaderAuthenticatedPrefix({ bytes })).toEqual(bytes.subarray(0, 48));
    expect(decodeSegmentHeader({ bytes })).toEqual(header);
    for (const offset of [0, 8, 10, 12, 13, 14, 32, 47]) {
      const damaged = Uint8Array.from(bytes);
      damaged[offset] ^= 1;
      expect(() => decodeSegmentHeader({ bytes: damaged })).toThrow();
    }
  });

  it('roundtrips a metadata Record Frame Header and derives exact lengths', () => {
    const header = createRecordFrameHeader({
      flags: 0,
      homeOffset: createUInt64({ value: 64n }),
      homeSegmentId: segmentId(),
      nonce: Uint8Array.from({ length: 12 }, (_, index) => index + 20),
      plaintextLength: 1,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    });
    expect(header.sealedLength).toBe(17);
    expect(header.frameLength).toBe(88);
    const bytes = encodeRecordFrameHeader({ header });
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('HZRECORD');
    expect(decodeRecordFrameHeader({ bytes })).toEqual(header);
  });

  it('requires physical-only exactly for relocation index records', () => {
    expect(() => createRecordFrameHeader({
      flags: 0,
      homeOffset: createUInt64({ value: 64n }),
      homeSegmentId: segmentId(),
      nonce: new Uint8Array(12),
      plaintextLength: 0,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page,
    })).toThrow('physical-only');
    const physical = createRecordFrameHeader({
      flags: HIZOFS_V1_FORMAT_CONSTANTS.flags.recordPhysicalOnly,
      homeOffset: createUInt64({ value: 64n }),
      homeSegmentId: segmentId(),
      nonce: new Uint8Array(12),
      plaintextLength: 0,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page,
    });
    expect(decodeRecordFrameHeader({ bytes: encodeRecordFrameHeader({ header: physical }) })).toEqual(physical);
  });

  it('rejects inconsistent frame lengths and header corruption', () => {
    const header = createRecordFrameHeader({
      flags: 0,
      homeOffset: createUInt64({ value: 64n }),
      homeSegmentId: segmentId(),
      nonce: new Uint8Array(12),
      plaintextLength: 8,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    });
    const bytes = encodeRecordFrameHeader({ header });
    bytes[51] ^= 1;
    expect(() => decodeRecordFrameHeader({ bytes })).toThrow('length');
    const magic = encodeRecordFrameHeader({ header });
    magic[0] ^= 1;
    expect(() => decodeRecordFrameHeader({ bytes: magic })).toThrow('magic');
  });
});

describe('Segment Footer codecs', () => {
  it('round-trips the header, trailer, and authenticated index entry layout', () => {
    const physicalSegmentId = segmentId();
    const header = createSegmentFooterHeader({
      entryCount: 2,
      nonce: Uint8Array.from({ length: 12 }, (_, index) => index + 1),
      physicalSegmentId,
      segmentClass: 'metadata',
      segmentDataLength: createUInt64({ value: 4096n }),
    });
    const encodedHeader = encodeSegmentFooterHeader({ header });
    expect(encodedHeader).toHaveLength(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentFooterHeader);
    expect(decodeSegmentFooterHeader({ bytes: encodedHeader })).toEqual(header);

    const footerTotalLength = calculateSegmentFooterTotalLength({ entryCount: 2 });
    const trailer = { footerTotalLength, physicalSegmentId };
    expect(decodeSegmentFooterTrailer({ bytes: encodeSegmentFooterTrailer({ trailer }) })).toEqual(trailer);

    const entry = {
      flags: 0,
      frameLength: 96,
      homeOffset: createUInt64({ value: 64n }),
      homeSegmentId: segmentId(),
      physicalOffset: createUInt64({ value: 128n }),
      plaintextLength: 16,
      recordCodecVersion: 1 as const,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    };
    expect(decodeSegmentFooterIndexEntry({ bytes: encodeSegmentFooterIndexEntry({ entry }) })).toEqual(entry);
  });

  it('rejects zero-entry and class-bound footer headers', () => {
    expect(() => calculateSegmentFooterTotalLength({ entryCount: 0 })).toThrow('entry count');
    expect(() => createSegmentFooterHeader({
      entryCount: HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataFramesPerSegment + 1,
      nonce: new Uint8Array(12),
      physicalSegmentId: segmentId(),
      segmentClass: 'metadata',
      segmentDataLength: createUInt64({ value: 80n }),
    })).toThrow('class bound');
    expect(() => createSegmentFooterHeader({
      entryCount: 1,
      nonce: new Uint8Array(12),
      physicalSegmentId: segmentId(),
      segmentClass: 'metadata',
      segmentDataLength: createUInt64({ value: BigInt(HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataSegmentDataBytes) + 8n }),
    })).toThrow('class bound');
  });

  it('rejects inconsistent lengths, reserved bytes, and physical-only mismatches', () => {
    const header = createSegmentFooterHeader({
      entryCount: 1,
      nonce: new Uint8Array(12),
      physicalSegmentId: segmentId(),
      segmentClass: 'data',
      segmentDataLength: createUInt64({ value: 64n }),
    });
    const badHeader = encodeSegmentFooterHeader({ header });
    badHeader[63] = 1;
    expect(() => decodeSegmentFooterHeader({ bytes: badHeader })).toThrow('reserved');

    const trailer = encodeSegmentFooterTrailer({
      trailer: { footerTotalLength: calculateSegmentFooterTotalLength({ entryCount: 1 }), physicalSegmentId: segmentId() },
    });
    trailer[15] = 0;
    expect(() => decodeSegmentFooterTrailer({ bytes: trailer })).toThrow('total length');

    expect(() => encodeSegmentFooterIndexEntry({
      entry: {
        flags: 0,
        frameLength: 88,
        homeOffset: createUInt64({ value: 64n }),
        homeSegmentId: segmentId(),
        physicalOffset: createUInt64({ value: 64n }),
        plaintextLength: 0,
        recordCodecVersion: 1,
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page,
      },
    })).toThrow('physical-only');
  });
});
