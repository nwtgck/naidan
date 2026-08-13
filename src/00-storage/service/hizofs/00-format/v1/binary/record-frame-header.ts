import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';
import { parseSegmentId, type SegmentId } from '@/00-storage/service/hizofs/00-format/v1/identifiers';
import { createUInt64, UINT64_MAXIMUM, type UInt64 } from '@/00-storage/service/hizofs/00-format/v1/scalars';
import { assertFixedAscii, writeFixedAscii } from './fixed-ascii';
import { readU16Be, readU32Be, readU64Be, writeU16Be, writeU32Be, writeU64Be } from './scalars';

const CONSTANTS = HIZOFS_V1_FORMAT_CONSTANTS;
const SIZE = CONSTANTS.fixedSizes.recordFrameHeader;
const MAGIC = CONSTANTS.magic.recordFrame;
const PHYSICAL_ONLY = CONSTANTS.flags.recordPhysicalOnly;
const RELOCATION_KIND = CONSTANTS.recordKinds.relocation_index_page;
const KNOWN_KINDS = new Set<number>(Object.values(CONSTANTS.recordKinds));

export type RecordFrameHeaderV1 = Readonly<{
  flags: number;
  frameLength: number;
  homeOffset: UInt64;
  homeSegmentId: SegmentId;
  nonce: Uint8Array;
  plaintextLength: number;
  recordCodecVersion: 1;
  recordKind: number;
  sealedLength: number;
}>;

function align8({ value }: { value: number }): number {
  return Math.ceil(value / 8) * 8;
}

function validate({ header }: { header: RecordFrameHeaderV1 }): void {
  if (!KNOWN_KINDS.has(header.recordKind)) throw new TypeError('Record Frame kind is unknown');
  const physicalOnly = (header.flags & PHYSICAL_ONLY) !== 0;
  if ((header.flags & ~PHYSICAL_ONLY) !== 0) throw new TypeError('Record Frame has unknown flags');
  if ((header.recordKind === RELOCATION_KIND) !== physicalOnly) {
    throw new TypeError('Record Frame physical-only flag does not match record kind');
  }
  if (header.recordCodecVersion !== 1) throw new TypeError('Record Frame codec version is unsupported');
  if (header.homeOffset < 64n || header.homeOffset % 8n !== 0n) throw new RangeError('Record Frame home offset is invalid');
  if (!Number.isInteger(header.plaintextLength) || header.plaintextLength < 0 || header.plaintextLength > 0xffff_ffff) {
    throw new RangeError('Record Frame plaintext length is outside u32');
  }
  if (header.sealedLength !== header.plaintextLength + CONSTANTS.crypto.tagBytes) {
    throw new RangeError('Record Frame sealed length is inconsistent');
  }
  if (header.frameLength !== align8({ value: SIZE + header.sealedLength })) {
    throw new RangeError('Record Frame total length is inconsistent');
  }
  if (header.homeOffset + BigInt(header.frameLength) > UINT64_MAXIMUM) throw new RangeError('Record Frame range exceeds u64');
  if (header.nonce.byteLength !== CONSTANTS.crypto.nonceBytes) throw new RangeError('Record Frame nonce must be exactly 12 bytes');
}

export function createRecordFrameHeader({
  flags,
  homeOffset,
  homeSegmentId,
  nonce,
  plaintextLength,
  recordKind,
}: {
  flags: number;
  homeOffset: UInt64;
  homeSegmentId: SegmentId;
  nonce: Uint8Array;
  plaintextLength: number;
  recordKind: number;
}): RecordFrameHeaderV1 {
  const sealedLength = plaintextLength + CONSTANTS.crypto.tagBytes;
  const header: RecordFrameHeaderV1 = {
    flags,
    frameLength: align8({ value: SIZE + sealedLength }),
    homeOffset: createUInt64({ value: homeOffset }),
    homeSegmentId: parseSegmentId({ bytes: homeSegmentId }),
    nonce: Uint8Array.from(nonce),
    plaintextLength,
    recordCodecVersion: 1,
    recordKind,
    sealedLength,
  };
  validate({ header });
  return header;
}

export function writeRecordFrameHeader({ bytes, header, offset }: {
  bytes: Uint8Array;
  header: RecordFrameHeaderV1;
  offset: number;
}): void {
  validate({ header });
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + SIZE > bytes.byteLength) {
    throw new RangeError('Record Frame Header destination range is invalid');
  }
  writeFixedAscii({ bytes, offset, value: MAGIC });
  writeU16Be({ bytes, offset: offset + 8, value: CONSTANTS.formatVersion });
  writeU16Be({ bytes, offset: offset + 10, value: SIZE });
  bytes[offset + 12] = header.recordKind;
  bytes[offset + 13] = header.flags;
  writeU16Be({ bytes, offset: offset + 14, value: header.recordCodecVersion });
  bytes.set(header.homeSegmentId, offset + 16);
  writeU64Be({ bytes, offset: offset + 32, value: header.homeOffset });
  writeU32Be({ bytes, offset: offset + 40, value: header.plaintextLength });
  writeU32Be({ bytes, offset: offset + 44, value: header.sealedLength });
  writeU32Be({ bytes, offset: offset + 48, value: header.frameLength });
  bytes.set(header.nonce, offset + 52);
}

export function encodeRecordFrameHeader({ header }: { header: RecordFrameHeaderV1 }): Uint8Array {
  const bytes = new Uint8Array(SIZE);
  writeRecordFrameHeader({ bytes, header, offset: 0 });
  return bytes;
}

export function decodeRecordFrameHeader({ bytes }: { bytes: Uint8Array }): RecordFrameHeaderV1 {
  if (bytes.byteLength !== SIZE) throw new RangeError(`Record Frame Header must be exactly ${SIZE} bytes`);
  assertFixedAscii({ bytes, offset: 0, value: MAGIC });
  if (readU16Be({ bytes, offset: 8 }) !== CONSTANTS.formatVersion) throw new TypeError('Record Frame format version is unsupported');
  if (readU16Be({ bytes, offset: 10 }) !== SIZE) throw new TypeError('Record Frame Header length is invalid');
  const recordKind = bytes[12];
  const flags = bytes[13];
  if (recordKind === undefined || flags === undefined) throw new Error('Record Frame tag offset invariant failed');
  const header: RecordFrameHeaderV1 = {
    flags,
    frameLength: readU32Be({ bytes, offset: 48 }),
    homeOffset: readU64Be({ bytes, offset: 32 }),
    homeSegmentId: parseSegmentId({ bytes: bytes.subarray(16, 32) }),
    nonce: bytes.slice(52, 64),
    plaintextLength: readU32Be({ bytes, offset: 40 }),
    recordCodecVersion: readU16Be({ bytes, offset: 14 }) as 1,
    recordKind,
    sealedLength: readU32Be({ bytes, offset: 44 }),
  };
  validate({ header });
  return header;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
