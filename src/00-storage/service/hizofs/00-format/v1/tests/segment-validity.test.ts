import { describe, expect, it } from 'vitest';
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  assertRecordFrameReaderValidity,
  calculateSegmentFooterTotalLength,
  createRecordFrameHeader,
  createSegmentFooterHeader,
  createUInt64,
  parseSegmentId,
  segmentFileSizeIsReaderValid,
  segmentFooterCandidateStructureIsValid,
  segmentFooterIndexEntryFromFrame,
  segmentFooterIndexEntryMatchesFrame,
  segmentFooterTrailerIsReaderCandidate,
  segmentFramePaddingIsZero,
  segmentHeaderMatchesPhysicalIdentity,
  segmentPrefixHasTruncatedFrameHeader,
  segmentPrefixStartsWithFooterMagic,
} from '@/00-storage/service/hizofs/00-format';

function segmentId({ seed }: { seed: number }) {
  return parseSegmentId({ bytes: new Uint8Array(16).fill(seed) });
}

describe('HizoFS V1 Segment reader validity', () => {
  it('classifies file, header, prefix, frame bounds, and padding facts', () => {
    const physicalSegmentId = segmentId({ seed: 1 });
    const frameHeader = createRecordFrameHeader({
      flags: 0,
      homeOffset: createUInt64({ value: 64n }),
      homeSegmentId: segmentId({ seed: 2 }),
      nonce: new Uint8Array(12),
      plaintextLength: 8,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    });
    expect(segmentFileSizeIsReaderValid({ fileSize: 64n, segmentClass: 'metadata' })).toBe(true);
    expect(segmentFileSizeIsReaderValid({ fileSize: 63n, segmentClass: 'metadata' })).toBe(false);
    expect(segmentHeaderMatchesPhysicalIdentity({
      header: { authenticationTag: new Uint8Array(16), physicalSegmentId, segmentClass: 'metadata' },
      physicalSegmentId,
      segmentClass: 'metadata',
    })).toBe(true);
    expect(segmentPrefixHasTruncatedFrameHeader({ remainingBytes: 63n })).toBe(true);
    expect(segmentPrefixStartsWithFooterMagic({
      bytes: new TextEncoder().encode(`${HIZOFS_V1_FORMAT_CONSTANTS.magic.segmentFooter}${'0'.repeat(64)}`),
    })).toBe(true);
    expect(() => assertRecordFrameReaderValidity({
      frameCount: 0,
      header: frameHeader,
      physicalOffset: 64n,
      physicalSegmentId,
      remainingBytes: BigInt(frameHeader.frameLength),
      segmentClass: 'metadata',
    })).not.toThrow();
    expect(segmentFramePaddingIsZero({ body: Uint8Array.of(1, 2, 0, 0), sealedLength: 2 })).toBe(true);
    expect(segmentFramePaddingIsZero({ body: Uint8Array.of(1, 2, 0, 1), sealedLength: 2 })).toBe(false);
  });

  it('validates a footer candidate and its exact frame index binding', () => {
    const physicalSegmentId = segmentId({ seed: 1 });
    const frame = {
      header: createRecordFrameHeader({
        flags: 0,
        homeOffset: createUInt64({ value: 64n }),
        homeSegmentId: segmentId({ seed: 2 }),
        nonce: new Uint8Array(12),
        plaintextLength: 8,
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
      }),
      physicalOffset: 64n,
    };
    const footerOffset = 64n + BigInt(frame.header.frameLength);
    const footerTotalLength = calculateSegmentFooterTotalLength({ entryCount: 1 });
    const fileSize = footerOffset + BigInt(footerTotalLength);
    const header = createSegmentFooterHeader({
      entryCount: 1,
      nonce: new Uint8Array(12),
      physicalSegmentId,
      segmentClass: 'metadata',
      segmentDataLength: createUInt64({ value: BigInt(frame.header.frameLength) }),
    });
    const trailer = { footerTotalLength, physicalSegmentId };
    expect(segmentFooterTrailerIsReaderCandidate({ fileSize, physicalSegmentId, segmentClass: 'metadata', trailer })).toBe(true);
    expect(segmentFooterCandidateStructureIsValid({
      candidateByteLength: footerTotalLength,
      fileSize,
      footerOffset,
      header,
      observedFooterTotalLength: footerTotalLength,
      physicalSegmentId,
      segmentClass: 'metadata',
      trailer,
    })).toBe(true);
    const entry = segmentFooterIndexEntryFromFrame({ frame });
    expect(segmentFooterIndexEntryMatchesFrame({
      entry,
      frameHeader: frame.header,
      physicalOffset: frame.physicalOffset,
      physicalSegmentId,
      segmentClass: 'metadata',
    })).toBe(true);
    expect(segmentFooterIndexEntryMatchesFrame({
      entry: { ...entry, frameLength: entry.frameLength + 8 },
      frameHeader: frame.header,
      physicalOffset: frame.physicalOffset,
      physicalSegmentId,
      segmentClass: 'metadata',
    })).toBe(false);
  });
});
