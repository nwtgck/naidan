import { encodePersistenceControlUtf8 } from '@/00-storage/service/hizofs/compatibility';
import { NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS } from './format-constants';

const ENCODING_VERSION = 1;
const MAXIMUM_U16 = 0xffff;
const MAXIMUM_FIELD_BYTES = NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.limits.persistenceControlJsonBytes;

export type NaidanPersistenceControlCryptoDomain = typeof NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.crypto.domains[number];

function writeU16Be({ bytes, offset, value }: { bytes: Uint8Array; offset: number; value: number }): void {
  if (!Number.isInteger(value) || value < 0 || value > MAXIMUM_U16) throw new RangeError('u16 value is outside range');
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function writeU64Be({ bytes, offset, value }: { bytes: Uint8Array; offset: number; value: bigint }): void {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new RangeError('u64 value is outside range');
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(offset, value, false);
}

function expectedFieldCount({ domain }: { domain: NaidanPersistenceControlCryptoDomain }): number {
  return NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.crypto.contextFields[domain].length;
}

export function encodeNaidanPersistenceCryptoContext({ domain, expectedFields, fields, maximumFieldBytes }: {
  domain: string;
  expectedFields: number;
  fields: readonly Uint8Array[];
  maximumFieldBytes: number;
}): Uint8Array {
  if (!/^[\x20-\x7e]+$/u.test(domain)) throw new TypeError('crypto domain must be printable ASCII');
  if (!Number.isSafeInteger(expectedFields) || expectedFields < 0 || fields.length !== expectedFields || fields.length > MAXIMUM_U16) {
    throw new RangeError('crypto context field count does not match the persisted authority');
  }
  if (!Number.isSafeInteger(maximumFieldBytes) || maximumFieldBytes < 0) {
    throw new RangeError('crypto context field bound is invalid');
  }
  const domainBytes = encodePersistenceControlUtf8({ value: domain });
  if (domainBytes.byteLength < 1 || domainBytes.byteLength > MAXIMUM_U16) throw new RangeError('crypto domain length is outside u16');
  let totalLength = 1 + 2 + domainBytes.byteLength + 2;
  for (const field of fields) {
    if (field.byteLength > maximumFieldBytes) throw new RangeError('crypto context field exceeds the persisted hard bound');
    totalLength += 8 + field.byteLength;
  }
  const bytes = new Uint8Array(totalLength);
  bytes[0] = ENCODING_VERSION;
  writeU16Be({ bytes, offset: 1, value: domainBytes.byteLength });
  bytes.set(domainBytes, 3);
  let offset = 3 + domainBytes.byteLength;
  writeU16Be({ bytes, offset, value: fields.length });
  offset += 2;
  for (const field of fields) {
    writeU64Be({ bytes, offset, value: BigInt(field.byteLength) });
    offset += 8;
    bytes.set(field, offset);
    offset += field.byteLength;
  }
  return bytes;
}

export function encodePersistenceControlCryptoContext({ domain, fields }: {
  domain: NaidanPersistenceControlCryptoDomain;
  fields: readonly Uint8Array[];
}): Uint8Array {
  return encodeNaidanPersistenceCryptoContext({
    domain,
    expectedFields: expectedFieldCount({ domain }),
    fields,
    maximumFieldBytes: MAXIMUM_FIELD_BYTES,
  });
}

export const TEST_ONLY = {
  encodingVersion: ENCODING_VERSION,
};
