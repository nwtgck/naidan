import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';
import { parseSegmentId, type SegmentId } from '@/00-storage/service/hizofs/00-format/v1/identifiers';
import { type SegmentClass } from '@/00-storage/service/hizofs/00-format/v1/paths';
import { createUInt64, UINT64_MAXIMUM, type UInt64 } from '@/00-storage/service/hizofs/00-format/v1/scalars';
import { assertFixedAscii, writeFixedAscii } from './fixed-ascii';
import { readU16Be, readU32Be, readU64Be, writeU16Be, writeU32Be, writeU64Be } from './scalars';

const CONSTANTS = HIZOFS_V1_FORMAT_CONSTANTS;
const HEADER_SIZE = CONSTANTS.fixedSizes.segmentFooterHeader;
const TRAILER_SIZE = CONSTANTS.fixedSizes.segmentFooterTrailer;
const ENTRY_SIZE = CONSTANTS.fixedSizes.segmentFooterIndexEntry;
const TAG_SIZE = CONSTANTS.crypto.tagBytes;
const HEADER_MAGIC = CONSTANTS.magic.segmentFooter;
const TRAILER_MAGIC = CONSTANTS.magic.segmentTrailer;
const PHYSICAL_ONLY = CONSTANTS.flags.recordPhysicalOnly;
const RELOCATION_KIND = CONSTANTS.recordKinds.relocation_index_page;
const KNOWN_KINDS = new Set<number>(Object.values(CONSTANTS.recordKinds));

export type SegmentFooterHeaderV1 = Readonly<{
  entryCount: number;
  nonce: Uint8Array;
  physicalSegmentId: SegmentId;
  plaintextIndexLength: number;
  segmentClass: SegmentClass;
  segmentDataLength: UInt64;
}>;

export type SegmentFooterTrailerV1 = Readonly<{
  footerTotalLength: number;
  physicalSegmentId: SegmentId;
}>;

export type SegmentFooterIndexEntryV1 = Readonly<{
  flags: number;
  frameLength: number;
  homeOffset: UInt64;
  homeSegmentId: SegmentId;
  physicalOffset: UInt64;
  plaintextLength: number;
  recordCodecVersion: 1;
  recordKind: number;
}>;

function classCode({ segmentClass }: { segmentClass: SegmentClass }): number {
  return CONSTANTS.container.segmentClasses[segmentClass];
}

function classFromCode({ value }: { value: number }): SegmentClass {
  if (value === CONSTANTS.container.segmentClasses.metadata) return 'metadata';
  if (value === CONSTANTS.container.segmentClasses.data) return 'data';
  throw new TypeError('Segment Footer class is unknown');
}

function align8({ value }: { value: number }): number {
  return Math.ceil(value / 8) * 8;
}

export function calculateSegmentFooterTotalLength({ entryCount }: { entryCount: number }): number {
  if (!Number.isInteger(entryCount) || entryCount < 1 || entryCount > CONSTANTS.limits.dataFramesPerSegment) {
    throw new RangeError('Segment Footer entry count is invalid');
  }
  const plaintextIndexLength = entryCount * ENTRY_SIZE;
  const total = HEADER_SIZE + plaintextIndexLength + TAG_SIZE + TRAILER_SIZE;
  if (!Number.isSafeInteger(total) || total > 0xffff_ffff) throw new RangeError('Segment Footer total length exceeds u32');
  return total;
}

function validateHeader({ header }: { header: SegmentFooterHeaderV1 }): void {
  parseSegmentId({ bytes: header.physicalSegmentId });
  if (header.segmentDataLength === 0n || header.segmentDataLength % 8n !== 0n) {
    throw new RangeError('Segment Footer data length must be a non-zero aligned Record Frame byte length');
  }
  const { frameMaximum, plaintextIndexMaximum, segmentDataMaximum } = (() => {
    switch (header.segmentClass) {
    case 'data':
      return {
        frameMaximum: CONSTANTS.limits.dataFramesPerSegment,
        plaintextIndexMaximum: CONSTANTS.limits.dataFooterPlaintextIndexBytes,
        segmentDataMaximum: CONSTANTS.limits.dataSegmentDataBytes,
      };
    case 'metadata':
      return {
        frameMaximum: CONSTANTS.limits.metadataFramesPerSegment,
        plaintextIndexMaximum: CONSTANTS.limits.metadataFooterPlaintextIndexBytes,
        segmentDataMaximum: CONSTANTS.limits.metadataSegmentDataBytes,
      };
    default:
      return header.segmentClass satisfies never;
    }
  })();
  if (header.segmentDataLength > BigInt(segmentDataMaximum)) {
    throw new RangeError('Segment Footer data length exceeds its class bound');
  }
  if (!Number.isInteger(header.entryCount) || header.entryCount < 1 || header.entryCount > frameMaximum) {
    throw new RangeError('Segment Footer entry count exceeds its class bound');
  }
  if (header.plaintextIndexLength !== header.entryCount * ENTRY_SIZE
    || header.plaintextIndexLength > plaintextIndexMaximum) {
    throw new RangeError('Segment Footer plaintext index length is inconsistent');
  }
  calculateSegmentFooterTotalLength({ entryCount: header.entryCount });
  if (header.nonce.byteLength !== CONSTANTS.crypto.nonceBytes) throw new RangeError('Segment Footer nonce must be exactly 12 bytes');
}

export function createSegmentFooterHeader({
  entryCount,
  nonce,
  physicalSegmentId,
  segmentClass,
  segmentDataLength,
}: {
  entryCount: number;
  nonce: Uint8Array;
  physicalSegmentId: SegmentId;
  segmentClass: SegmentClass;
  segmentDataLength: UInt64;
}): SegmentFooterHeaderV1 {
  const header: SegmentFooterHeaderV1 = {
    entryCount,
    nonce: Uint8Array.from(nonce),
    physicalSegmentId: parseSegmentId({ bytes: physicalSegmentId }),
    plaintextIndexLength: entryCount * ENTRY_SIZE,
    segmentClass,
    segmentDataLength: createUInt64({ value: segmentDataLength }),
  };
  validateHeader({ header });
  return header;
}

export function encodeSegmentFooterHeader({ header }: { header: SegmentFooterHeaderV1 }): Uint8Array {
  validateHeader({ header });
  const bytes = new Uint8Array(HEADER_SIZE);
  writeFixedAscii({ bytes, offset: 0, value: HEADER_MAGIC });
  writeU16Be({ bytes, offset: 8, value: CONSTANTS.formatVersion });
  writeU16Be({ bytes, offset: 10, value: HEADER_SIZE });
  bytes[12] = classCode({ segmentClass: header.segmentClass });
  bytes.set(header.physicalSegmentId, 16);
  writeU64Be({ bytes, offset: 32, value: header.segmentDataLength });
  writeU32Be({ bytes, offset: 40, value: header.entryCount });
  writeU32Be({ bytes, offset: 44, value: header.plaintextIndexLength });
  bytes.set(header.nonce, 48);
  return bytes;
}

export function decodeSegmentFooterHeader({ bytes }: { bytes: Uint8Array }): SegmentFooterHeaderV1 {
  if (bytes.byteLength !== HEADER_SIZE) throw new RangeError(`Segment Footer Header must be exactly ${HEADER_SIZE} bytes`);
  assertFixedAscii({ bytes, offset: 0, value: HEADER_MAGIC });
  if (readU16Be({ bytes, offset: 8 }) !== CONSTANTS.formatVersion) throw new TypeError('Segment Footer format version is unsupported');
  if (readU16Be({ bytes, offset: 10 }) !== HEADER_SIZE) throw new TypeError('Segment Footer Header length is invalid');
  if (bytes[13] !== 0 || bytes[14] !== 0 || bytes[15] !== 0) throw new TypeError('Segment Footer flags/reserved bytes must be zero');
  for (let index = 60; index < 64; index += 1) if (bytes[index] !== 0) throw new TypeError('Segment Footer reserved bytes must be zero');
  const segmentClass = bytes[12];
  if (segmentClass === undefined) throw new Error('Segment Footer class offset invariant failed');
  const header: SegmentFooterHeaderV1 = {
    entryCount: readU32Be({ bytes, offset: 40 }),
    nonce: bytes.slice(48, 60),
    physicalSegmentId: parseSegmentId({ bytes: bytes.subarray(16, 32) }),
    plaintextIndexLength: readU32Be({ bytes, offset: 44 }),
    segmentClass: classFromCode({ value: segmentClass }),
    segmentDataLength: readU64Be({ bytes, offset: 32 }),
  };
  validateHeader({ header });
  return header;
}

function validateTrailer({ trailer }: { trailer: SegmentFooterTrailerV1 }): void {
  parseSegmentId({ bytes: trailer.physicalSegmentId });
  if (!Number.isInteger(trailer.footerTotalLength) || trailer.footerTotalLength < HEADER_SIZE + TAG_SIZE + TRAILER_SIZE) {
    throw new RangeError('Segment Footer total length is invalid');
  }
  if ((trailer.footerTotalLength - HEADER_SIZE - TAG_SIZE - TRAILER_SIZE) % ENTRY_SIZE !== 0) {
    throw new RangeError('Segment Footer total length is not an integral index');
  }
}

export function encodeSegmentFooterTrailer({ trailer }: { trailer: SegmentFooterTrailerV1 }): Uint8Array {
  validateTrailer({ trailer });
  const bytes = new Uint8Array(TRAILER_SIZE);
  writeFixedAscii({ bytes, offset: 0, value: TRAILER_MAGIC });
  writeU16Be({ bytes, offset: 8, value: CONSTANTS.formatVersion });
  writeU16Be({ bytes, offset: 10, value: TRAILER_SIZE });
  writeU32Be({ bytes, offset: 12, value: trailer.footerTotalLength });
  bytes.set(trailer.physicalSegmentId, 16);
  return bytes;
}

export function decodeSegmentFooterTrailer({ bytes }: { bytes: Uint8Array }): SegmentFooterTrailerV1 {
  if (bytes.byteLength !== TRAILER_SIZE) throw new RangeError(`Segment Footer Trailer must be exactly ${TRAILER_SIZE} bytes`);
  assertFixedAscii({ bytes, offset: 0, value: TRAILER_MAGIC });
  if (readU16Be({ bytes, offset: 8 }) !== CONSTANTS.formatVersion) throw new TypeError('Segment Footer Trailer format version is unsupported');
  if (readU16Be({ bytes, offset: 10 }) !== TRAILER_SIZE) throw new TypeError('Segment Footer Trailer length is invalid');
  const trailer: SegmentFooterTrailerV1 = {
    footerTotalLength: readU32Be({ bytes, offset: 12 }),
    physicalSegmentId: parseSegmentId({ bytes: bytes.subarray(16, 32) }),
  };
  validateTrailer({ trailer });
  return trailer;
}

function validateIndexEntry({ entry }: { entry: SegmentFooterIndexEntryV1 }): void {
  parseSegmentId({ bytes: entry.homeSegmentId });
  if (!KNOWN_KINDS.has(entry.recordKind)) throw new TypeError('Segment Footer index record kind is unknown');
  if (entry.recordCodecVersion !== 1) throw new TypeError('Segment Footer index codec version is unsupported');
  const physicalOnly = (entry.flags & PHYSICAL_ONLY) !== 0;
  if ((entry.flags & ~PHYSICAL_ONLY) !== 0) throw new TypeError('Segment Footer index has unknown flags');
  if ((entry.recordKind === RELOCATION_KIND) !== physicalOnly) throw new TypeError('Segment Footer index physical-only flag does not match record kind');
  if (entry.physicalOffset < 64n || entry.physicalOffset % 8n !== 0n) throw new RangeError('Segment Footer index physical offset is invalid');
  if (entry.homeOffset < 64n || entry.homeOffset % 8n !== 0n) throw new RangeError('Segment Footer index home offset is invalid');
  if (!Number.isInteger(entry.plaintextLength) || entry.plaintextLength < 0 || entry.plaintextLength > 0xffff_ffff) {
    throw new RangeError('Segment Footer index plaintext length is outside u32');
  }
  const expectedFrameLength = align8({ value: CONSTANTS.fixedSizes.recordFrameHeader + entry.plaintextLength + TAG_SIZE });
  if (entry.frameLength !== expectedFrameLength) throw new RangeError('Segment Footer index frame length is inconsistent');
  if (entry.physicalOffset + BigInt(entry.frameLength) > UINT64_MAXIMUM || entry.homeOffset + BigInt(entry.frameLength) > UINT64_MAXIMUM) {
    throw new RangeError('Segment Footer index range exceeds u64');
  }
}

export function writeSegmentFooterIndexEntry({ bytes, entry, offset }: {
  bytes: Uint8Array;
  entry: SegmentFooterIndexEntryV1;
  offset: number;
}): void {
  validateIndexEntry({ entry });
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + ENTRY_SIZE > bytes.byteLength) {
    throw new RangeError("Segment Footer index entry destination is outside the output buffer");
  }
  writeU64Be({ bytes, offset, value: entry.physicalOffset });
  writeU32Be({ bytes, offset: offset + 8, value: entry.frameLength });
  writeU32Be({ bytes, offset: offset + 12, value: entry.plaintextLength });
  bytes[offset + 16] = entry.recordKind;
  bytes[offset + 17] = entry.flags;
  writeU16Be({ bytes, offset: offset + 18, value: entry.recordCodecVersion });
  bytes.set(entry.homeSegmentId, offset + 20);
  writeU64Be({ bytes, offset: offset + 36, value: entry.homeOffset });
  bytes.fill(0, offset + 44, offset + ENTRY_SIZE);
}

export function encodeSegmentFooterIndexEntry({ entry }: { entry: SegmentFooterIndexEntryV1 }): Uint8Array {
  const bytes = new Uint8Array(ENTRY_SIZE);
  writeSegmentFooterIndexEntry({ bytes, entry, offset: 0 });
  return bytes;
}

export function decodeSegmentFooterIndexEntry({ bytes }: { bytes: Uint8Array }): SegmentFooterIndexEntryV1 {
  if (bytes.byteLength !== ENTRY_SIZE) throw new RangeError(`Segment Footer index entry must be exactly ${ENTRY_SIZE} bytes`);
  for (let index = 44; index < 48; index += 1) if (bytes[index] !== 0) throw new TypeError('Segment Footer index reserved bytes must be zero');
  const recordKind = bytes[16];
  const flags = bytes[17];
  if (recordKind === undefined || flags === undefined) throw new Error('Segment Footer index tag offset invariant failed');
  const entry: SegmentFooterIndexEntryV1 = {
    flags,
    frameLength: readU32Be({ bytes, offset: 8 }),
    homeOffset: readU64Be({ bytes, offset: 36 }),
    homeSegmentId: parseSegmentId({ bytes: bytes.subarray(20, 36) }),
    physicalOffset: readU64Be({ bytes, offset: 0 }),
    plaintextLength: readU32Be({ bytes, offset: 12 }),
    recordCodecVersion: readU16Be({ bytes, offset: 18 }) as 1,
    recordKind,
  };
  validateIndexEntry({ entry });
  return entry;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
