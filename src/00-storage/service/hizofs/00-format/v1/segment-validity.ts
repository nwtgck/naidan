import { decodeRecordFrameHeader, type RecordFrameHeaderV1 } from './binary/record-frame-header';
import {
  calculateSegmentFooterTotalLength,
  type SegmentFooterHeaderV1,
  type SegmentFooterIndexEntryV1,
  type SegmentFooterTrailerV1,
} from './binary/segment-footer';
import type { SegmentHeaderV1 } from './binary/segment-header';
import { HIZOFS_V1_FORMAT_CONSTANTS } from './format-constants';
import type { SegmentId } from './identifiers';
import type { SegmentClass } from './paths';
import { segmentClassForRecordKind } from './records/record-kind';
import { createUInt64 } from './scalars';
import { validatePhysicalOnlyRecordIdentity } from './semantic-validation/record-payloads';

export type SegmentFrameDescriptor = Readonly<{
  header: RecordFrameHeaderV1;
  physicalOffset: bigint;
}>;

export function formatBytesEqual({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

export function segmentMaximumBytes({ segmentClass }: { segmentClass: SegmentClass }): number {
  switch (segmentClass) {
  case 'data': return HIZOFS_V1_FORMAT_CONSTANTS.limits.dataSegmentFileMaximumBytes;
  case 'metadata': return HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataSegmentFileMaximumBytes;
  default: return segmentClass satisfies never;
  }
}

export function segmentFooterMaximumBytes({ segmentClass }: { segmentClass: SegmentClass }): number {
  switch (segmentClass) {
  case 'data': return HIZOFS_V1_FORMAT_CONSTANTS.limits.dataSegmentFooterMaximumBytes;
  case 'metadata': return HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataSegmentFooterMaximumBytes;
  default: return segmentClass satisfies never;
  }
}

export function segmentFrameMaximumCount({ segmentClass }: { segmentClass: SegmentClass }): number {
  switch (segmentClass) {
  case 'data': return HIZOFS_V1_FORMAT_CONSTANTS.limits.dataFramesPerSegment;
  case 'metadata': return HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataFramesPerSegment;
  default: return segmentClass satisfies never;
  }
}

export function recordPlaintextMaximumBytes({ recordKind }: { recordKind: number }): number {
  return recordKind === HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data
    ? HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes
    : HIZOFS_V1_FORMAT_CONSTANTS.limits.metadataPlaintextBytes;
}

export function segmentFileSizeIsReaderValid({ fileSize, segmentClass }: {
  fileSize: bigint;
  segmentClass: SegmentClass;
}): boolean {
  return fileSize >= BigInt(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentHeader)
    && fileSize <= BigInt(segmentMaximumBytes({ segmentClass }));
}

export function segmentHeaderMatchesPhysicalIdentity({ header, physicalSegmentId, segmentClass }: {
  header: SegmentHeaderV1;
  physicalSegmentId: SegmentId;
  segmentClass: SegmentClass;
}): boolean {
  return header.segmentClass === segmentClass
    && formatBytesEqual({ left: header.physicalSegmentId, right: physicalSegmentId });
}

export function segmentPrefixHasTruncatedFrameHeader({ remainingBytes }: { remainingBytes: bigint }): boolean {
  return remainingBytes < BigInt(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.recordFrameHeader);
}

export function segmentPrefixStartsWithFooterMagic({ bytes }: { bytes: Uint8Array }): boolean {
  const footerMagic = new TextEncoder().encode(HIZOFS_V1_FORMAT_CONSTANTS.magic.segmentFooter);
  return formatBytesEqual({ left: bytes.subarray(0, footerMagic.byteLength), right: footerMagic });
}

export function assertRecordFrameReaderValidity({
  frameCount,
  header,
  physicalOffset,
  physicalSegmentId,
  remainingBytes,
  segmentClass,
}: {
  frameCount: number;
  header: RecordFrameHeaderV1;
  physicalOffset: bigint;
  physicalSegmentId: SegmentId;
  remainingBytes: bigint;
  segmentClass: SegmentClass;
}): void {
  if (segmentClassForRecordKind({ recordKind: header.recordKind }) !== segmentClass
    || header.plaintextLength > recordPlaintextMaximumBytes({ recordKind: header.recordKind })
    || frameCount >= segmentFrameMaximumCount({ segmentClass })
    || BigInt(header.frameLength) > remainingBytes) {
    throw new TypeError('Record Frame violates its segment bounds');
  }
  if (header.recordKind === HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page) {
    validatePhysicalOnlyRecordIdentity({
      authenticatedHeader: header,
      physicalOffset,
      physicalSegmentId,
    });
  }
}

export function segmentFramePaddingIsZero({ body, sealedLength }: {
  body: Uint8Array;
  sealedLength: number;
}): boolean {
  return body.subarray(sealedLength).every(byte => byte === 0);
}

export function segmentFooterIndexEntryFromFrame({ frame }: {
  frame: SegmentFrameDescriptor;
}): SegmentFooterIndexEntryV1 {
  return {
    flags: frame.header.flags,
    frameLength: frame.header.frameLength,
    homeOffset: frame.header.homeOffset,
    homeSegmentId: frame.header.homeSegmentId,
    physicalOffset: createUInt64({ value: frame.physicalOffset }),
    plaintextLength: frame.header.plaintextLength,
    recordCodecVersion: frame.header.recordCodecVersion,
    recordKind: frame.header.recordKind,
  };
}

export function segmentFooterTrailerIsReaderCandidate({ fileSize, physicalSegmentId, segmentClass, trailer }: {
  fileSize: bigint;
  physicalSegmentId: SegmentId;
  segmentClass: SegmentClass;
  trailer: SegmentFooterTrailerV1;
}): boolean {
  return formatBytesEqual({ left: trailer.physicalSegmentId, right: physicalSegmentId })
    && trailer.footerTotalLength <= segmentFooterMaximumBytes({ segmentClass })
    && BigInt(trailer.footerTotalLength) <= fileSize - BigInt(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentHeader);
}

export function segmentFooterCandidateStructureIsValid({
  candidateByteLength,
  fileSize,
  footerOffset,
  header,
  observedFooterTotalLength,
  physicalSegmentId,
  segmentClass,
  trailer,
}: {
  candidateByteLength: number;
  fileSize: bigint;
  footerOffset: bigint;
  header: SegmentFooterHeaderV1;
  observedFooterTotalLength: number;
  physicalSegmentId: SegmentId;
  segmentClass: SegmentClass;
  trailer: SegmentFooterTrailerV1;
}): boolean {
  const expectedFooterOffset = BigInt(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentHeader) + header.segmentDataLength;
  return header.segmentClass === segmentClass
    && formatBytesEqual({ left: header.physicalSegmentId, right: physicalSegmentId })
    && formatBytesEqual({ left: trailer.physicalSegmentId, right: physicalSegmentId })
    && trailer.footerTotalLength === observedFooterTotalLength
    && candidateByteLength === observedFooterTotalLength
    && calculateSegmentFooterTotalLength({ entryCount: header.entryCount }) === observedFooterTotalLength
    && segmentFooterTrailerIsReaderCandidate({ fileSize, physicalSegmentId, segmentClass, trailer })
    && expectedFooterOffset === footerOffset
    && header.entryCount <= segmentFrameMaximumCount({ segmentClass });
}

export function segmentFooterIndexEntryMatchesFrame({
  entry,
  frameHeader,
  physicalOffset,
  physicalSegmentId,
  segmentClass,
}: {
  entry: SegmentFooterIndexEntryV1;
  frameHeader: ReturnType<typeof decodeRecordFrameHeader>;
  physicalOffset: bigint;
  physicalSegmentId: SegmentId;
  segmentClass: SegmentClass;
}): boolean {
  if (frameHeader.recordKind === HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page) {
    validatePhysicalOnlyRecordIdentity({
      authenticatedHeader: frameHeader,
      physicalOffset,
      physicalSegmentId,
    });
  }
  return entry.physicalOffset === physicalOffset
    && entry.frameLength === frameHeader.frameLength
    && entry.plaintextLength === frameHeader.plaintextLength
    && entry.recordKind === frameHeader.recordKind
    && entry.flags === frameHeader.flags
    && entry.recordCodecVersion === frameHeader.recordCodecVersion
    && formatBytesEqual({ left: entry.homeSegmentId, right: frameHeader.homeSegmentId })
    && entry.homeOffset === frameHeader.homeOffset
    && segmentClassForRecordKind({ recordKind: frameHeader.recordKind }) === segmentClass;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
