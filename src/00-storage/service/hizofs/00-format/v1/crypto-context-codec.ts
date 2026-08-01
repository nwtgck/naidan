import { writeU16Be, writeU64Be } from '@/00-storage/service/hizofs/00-format/v1/binary/scalars';
import { encodeUtf8Strict } from '@/00-storage/service/hizofs/00-format/v1/encoding/utf8';
import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';
import { createUInt64 } from '@/00-storage/service/hizofs/00-format/v1/scalars';

const ENCODING_VERSION = 1;
const FIELD_COUNT_MAXIMUM = 0xffff;
const FIELD_BYTES_MAXIMUM = HIZOFS_V1_FORMAT_CONSTANTS.limits.unlockEnvelopeJsonBytes;

export type HizoFSCryptoDomain = typeof HIZOFS_V1_FORMAT_CONSTANTS.crypto.domains[number];

function expectedFieldCount({ domain }: { domain: HizoFSCryptoDomain }): number {
  if (!Object.hasOwn(HIZOFS_V1_FORMAT_CONSTANTS.crypto.contextFields, domain)) {
    throw new TypeError('crypto domain is not registered by the HizoFS V1 owner');
  }
  return HIZOFS_V1_FORMAT_CONSTANTS.crypto.contextFields[domain].length;
}

export function encodeCryptoContext({ domain, fields }: {
  domain: HizoFSCryptoDomain;
  fields: readonly Uint8Array[];
}): Uint8Array {
  if (!/^[\x20-\x7e]+$/u.test(domain)) throw new TypeError('crypto domain must be non-empty printable ASCII');
  const domainBytes = encodeUtf8Strict({ label: 'crypto domain', value: domain });
  if (domainBytes.byteLength < 1 || domainBytes.byteLength > 0xffff) {
    throw new RangeError('crypto domain byte length is outside u16');
  }
  if (fields.length !== expectedFieldCount({ domain }) || fields.length > FIELD_COUNT_MAXIMUM) {
    throw new RangeError('crypto context field count does not match the owner registry');
  }
  let totalLength = 1 + 2 + domainBytes.byteLength + 2;
  for (const field of fields) {
    if (field.byteLength > FIELD_BYTES_MAXIMUM) {
      throw new RangeError('crypto context field exceeds the V1 hard bound');
    }
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
    writeU64Be({ bytes, offset, value: createUInt64({ value: BigInt(field.byteLength) }) });
    offset += 8;
    bytes.set(field, offset);
    offset += field.byteLength;
  }
  return bytes;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  encodingVersion: ENCODING_VERSION,
};
