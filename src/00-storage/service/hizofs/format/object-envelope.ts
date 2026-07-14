import { HizoFSCorruptionError, HizoFSUnsupportedFormatError } from '@/00-storage/service/hizofs/errors';
import { concatenateBytes } from '@/00-storage/service/hizofs/bytes';

const MAGIC = new Uint8Array([0x48, 0x49, 0x5a, 0x4f, 0x46, 0x53, 0x00, 0x00]);
const FORMAT_VERSION = 1;
const NONCE_BYTE_LENGTH = 12;
const HEADER_BYTE_LENGTH = 32;
const TAG_BYTE_LENGTH = 16;

export type HizoFSObjectEnvelope = {
  readonly formatVersion: number;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
};

export function encodeHizoFSObjectEnvelope({ nonce, ciphertext }: {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}): Uint8Array {
  if (nonce.byteLength !== NONCE_BYTE_LENGTH) {
    throw new Error('HizoFS object nonce must contain exactly 12 bytes');
  }
  if (ciphertext.byteLength < TAG_BYTE_LENGTH) {
    throw new Error('HizoFS object ciphertext is missing its authentication tag');
  }

  const header = new Uint8Array(HEADER_BYTE_LENGTH);
  header.set(MAGIC, 0);
  const view = new DataView(header.buffer);
  view.setUint16(8, FORMAT_VERSION, false);
  view.setUint16(10, HEADER_BYTE_LENGTH, false);
  header.set(nonce, 12);
  view.setBigUint64(24, BigInt(ciphertext.byteLength), false);
  return concatenateBytes({ parts: [header, ciphertext] });
}

export function decodeHizoFSObjectEnvelope({ physical }: {
  physical: Uint8Array;
}): HizoFSObjectEnvelope {
  if (physical.byteLength < HEADER_BYTE_LENGTH + TAG_BYTE_LENGTH) {
    throw new HizoFSCorruptionError({ message: 'HizoFS object is truncated', cause: undefined });
  }

  for (let index = 0; index < MAGIC.byteLength; index += 1) {
    if (physical[index] !== MAGIC[index]) {
      throw new HizoFSCorruptionError({ message: 'HizoFS object magic is invalid', cause: undefined });
    }
  }

  const view = new DataView(physical.buffer, physical.byteOffset, physical.byteLength);
  const formatVersion = view.getUint16(8, false);
  if (formatVersion !== FORMAT_VERSION) {
    throw new HizoFSUnsupportedFormatError({ message: `HizoFS object envelope version is unsupported: ${String(formatVersion)}` });
  }

  const headerByteLength = view.getUint16(10, false);
  if (headerByteLength !== HEADER_BYTE_LENGTH) {
    throw new HizoFSUnsupportedFormatError({ message: `HizoFS object header length is unsupported: ${String(headerByteLength)}` });
  }

  const ciphertextByteLengthBigInt = view.getBigUint64(24, false);
  if (ciphertextByteLengthBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HizoFSCorruptionError({ message: 'HizoFS object ciphertext length exceeds the safe integer range', cause: undefined });
  }
  const ciphertextByteLength = Number(ciphertextByteLengthBigInt);
  if (physical.byteLength !== HEADER_BYTE_LENGTH + ciphertextByteLength) {
    throw new HizoFSCorruptionError({ message: 'HizoFS object ciphertext length does not match the envelope', cause: undefined });
  }

  return {
    formatVersion,
    nonce: physical.slice(12, 24),
    ciphertext: physical.slice(HEADER_BYTE_LENGTH),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
