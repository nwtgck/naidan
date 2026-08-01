import { describe, expect, it } from 'vitest';
import {
  createHomeRecordReference,
  createPhysicalRecordReference,
  decodeRequiredHomeRecordReference,
  decodeRequiredPhysicalRecordReference,
  encodeHomeRecordReference,
  encodePhysicalRecordReference,
} from '@/00-storage/service/hizofs/00-format/v1/binary/record-reference';
import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';
import { parseSegmentId } from '@/00-storage/service/hizofs/00-format/v1/identifiers';
import { createUInt64, UINT64_MAXIMUM } from '@/00-storage/service/hizofs/00-format/v1/scalars';

function fields() {
  return {
    byteOffset: createUInt64({ value: 64n }),
    frameLength: 88,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    segmentId: parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => index + 1) }),
  };
}

describe('HizoFS V1 Record Reference', () => {
  it('encodes one exact 32-byte big-endian fixture and separates semantic types', () => {
    const home = createHomeRecordReference({ fields: fields() });
    const physical = createPhysicalRecordReference({ fields: fields() });
    const expected = Uint8Array.of(
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
      0, 0, 0, 0, 0, 0, 0, 64,
      0, 0, 0, 88,
      1, 0, 0, 0,
    );
    expect(encodeHomeRecordReference({ reference: home })).toEqual(expected);
    expect(encodePhysicalRecordReference({ reference: physical })).toEqual(expected);
    expect(decodeRequiredHomeRecordReference({ bytes: expected })).toEqual(home);
    expect(decodeRequiredPhysicalRecordReference({ bytes: expected })).toEqual(physical);
  });

  it('rejects all-zero, reserved bytes, unknown kinds, and wrong size', () => {
    expect(() => decodeRequiredHomeRecordReference({ bytes: new Uint8Array(32) })).toThrow('all-zero');
    const valid = encodeHomeRecordReference({ reference: createHomeRecordReference({ fields: fields() }) });
    valid[29] = 1;
    expect(() => decodeRequiredHomeRecordReference({ bytes: valid })).toThrow('reserved');
    valid[29] = 0;
    valid[28] = 255;
    expect(() => decodeRequiredHomeRecordReference({ bytes: valid })).toThrow('unknown');
    expect(() => decodeRequiredHomeRecordReference({ bytes: new Uint8Array(31) })).toThrow('32 bytes');
  });

  it('rejects unaligned and overflowing ranges before encoding', () => {
    expect(() => createHomeRecordReference({ fields: { ...fields(), byteOffset: createUInt64({ value: 65n }) } })).toThrow('aligned');
    expect(() => createHomeRecordReference({ fields: { ...fields(), frameLength: 89 } })).toThrow('aligned');
    expect(() => createHomeRecordReference({
      fields: { ...fields(), byteOffset: createUInt64({ value: UINT64_MAXIMUM - 7n }), frameLength: 88 },
    })).toThrow('exceeds u64');
  });
});
