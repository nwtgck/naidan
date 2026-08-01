import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';
import { parseSegmentId, type SegmentId } from '@/00-storage/service/hizofs/00-format/v1/identifiers';
import { type SegmentClass } from '@/00-storage/service/hizofs/00-format/v1/paths';
import { assertFixedAscii, writeFixedAscii } from './fixed-ascii';
import { readU16Be, writeU16Be } from './scalars';

const CONSTANTS = HIZOFS_V1_FORMAT_CONSTANTS;
const SIZE = CONSTANTS.fixedSizes.segmentHeader;
const MAGIC = CONSTANTS.magic.segment;
const AUTHENTICATED_PREFIX_SIZE = SIZE - CONSTANTS.crypto.tagBytes;

export type SegmentHeaderV1 = Readonly<{
  authenticationTag: Uint8Array;
  physicalSegmentId: SegmentId;
  segmentClass: SegmentClass;
}>;

function classCode({ segmentClass }: { segmentClass: SegmentClass }): number {
  return CONSTANTS.container.segmentClasses[segmentClass];
}

function classFromCode({ value }: { value: number }): SegmentClass {
  if (value === CONSTANTS.container.segmentClasses.metadata) return 'metadata';
  if (value === CONSTANTS.container.segmentClasses.data) return 'data';
  throw new TypeError('Segment Header class is unknown');
}

export function encodeSegmentHeader({ header }: { header: SegmentHeaderV1 }): Uint8Array {
  parseSegmentId({ bytes: header.physicalSegmentId });
  if (header.authenticationTag.byteLength !== CONSTANTS.crypto.tagBytes) {
    throw new RangeError('Segment Header authentication tag must be exactly 16 bytes');
  }
  const bytes = new Uint8Array(SIZE);
  writeFixedAscii({ bytes, offset: 0, value: MAGIC });
  writeU16Be({ bytes, offset: 8, value: CONSTANTS.formatVersion });
  writeU16Be({ bytes, offset: 10, value: SIZE });
  bytes[12] = classCode({ segmentClass: header.segmentClass });
  bytes.set(header.physicalSegmentId, 16);
  bytes.set(header.authenticationTag, 48);
  return bytes;
}

export function segmentHeaderAuthenticatedPrefix({ bytes }: { bytes: Uint8Array }): Uint8Array {
  if (bytes.byteLength !== SIZE) throw new RangeError(`Segment Header must be exactly ${SIZE} bytes`);
  return Uint8Array.from(bytes.subarray(0, AUTHENTICATED_PREFIX_SIZE));
}

export function decodeSegmentHeader({ bytes }: { bytes: Uint8Array }): SegmentHeaderV1 {
  if (bytes.byteLength !== SIZE) throw new RangeError(`Segment Header must be exactly ${SIZE} bytes`);
  assertFixedAscii({ bytes, offset: 0, value: MAGIC });
  if (readU16Be({ bytes, offset: 8 }) !== CONSTANTS.formatVersion) throw new TypeError('Segment Header format version is unsupported');
  if (readU16Be({ bytes, offset: 10 }) !== SIZE) throw new TypeError('Segment Header length is invalid');
  if (bytes[13] !== 0 || bytes[14] !== 0 || bytes[15] !== 0) throw new TypeError('Segment Header flags/reserved bytes must be zero');
  for (let index = 32; index < 48; index += 1) {
    if (bytes[index] !== 0) throw new TypeError('Segment Header reserved bytes must be zero');
  }
  const classByte = bytes[12];
  if (classByte === undefined) throw new Error('Segment Header class offset invariant failed');
  return {
    authenticationTag: bytes.slice(48, 64),
    physicalSegmentId: parseSegmentId({ bytes: bytes.subarray(16, 32) }),
    segmentClass: classFromCode({ value: classByte }),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
