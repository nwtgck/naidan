import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  encodeSegmentFooterAad,
  encodeSegmentHeaderAad,
  type FileSystemId,
  type SegmentId,
} from '@/00-storage/service/hizofs/00-format';
import { deriveSegmentFooterKey, deriveSegmentHeaderKey } from '@/00-storage/service/hizofs/crypto/key-application/derived-keys';
import { decryptAesGcm, encryptAesGcm } from '@/00-storage/service/hizofs/crypto/primitives/aes-gcm';
import type { FileSystemRootKey } from '@/00-storage/service/hizofs/crypto/secret-types';
import {
  authenticatedSegmentFooterBytes,
  authenticatedSegmentHeaderBytes,
  plaintextSegmentFooterBytes,
  plaintextSegmentHeaderBytes,
  type AuthenticatedSegmentFooterBytes,
  type AuthenticatedSegmentHeaderBytes,
  type PlaintextSegmentFooterBytes,
  type PlaintextSegmentHeaderBytes,
  type SegmentFooterNonce,
} from '@/00-storage/service/hizofs/crypto/types';

const ZERO_NONCE = new Uint8Array(HIZOFS_V1_FORMAT_CONSTANTS.crypto.nonceBytes);

function requireSize({ bytes, expected, label }: { bytes: Uint8Array; expected: number; label: string }): void {
  if (bytes.byteLength !== expected) throw new RangeError(`${label} must have the exact V1 byte length`);
}

export async function encryptSegmentHeader({ fileSystemId, physicalSegmentId, plaintext, rootKey, segmentClass, segmentHeaderPrefix }: {
  fileSystemId: FileSystemId;
  physicalSegmentId: SegmentId;
  plaintext: PlaintextSegmentHeaderBytes;
  rootKey: FileSystemRootKey;
  segmentClass: number;
  segmentHeaderPrefix: Uint8Array;
}): Promise<AuthenticatedSegmentHeaderBytes> {
  requireSize({ bytes: segmentHeaderPrefix, expected: 48, label: 'Segment Header AAD prefix' });
  const key = await deriveSegmentHeaderKey({ fileSystemId, physicalSegmentId, rootKey, segmentClass });
  return authenticatedSegmentHeaderBytes({
    bytes: await encryptAesGcm({
      aad: encodeSegmentHeaderAad({ fileSystemId, segmentHeaderPrefix }),
      key,
      nonce: ZERO_NONCE,
      plaintext,
    }),
  });
}

export async function decryptAuthenticatedSegmentHeader({ ciphertext, fileSystemId, physicalSegmentId, rootKey, segmentClass, segmentHeaderPrefix }: {
  ciphertext: AuthenticatedSegmentHeaderBytes;
  fileSystemId: FileSystemId;
  physicalSegmentId: SegmentId;
  rootKey: FileSystemRootKey;
  segmentClass: number;
  segmentHeaderPrefix: Uint8Array;
}): Promise<PlaintextSegmentHeaderBytes> {
  requireSize({ bytes: segmentHeaderPrefix, expected: 48, label: 'Segment Header AAD prefix' });
  const key = await deriveSegmentHeaderKey({ fileSystemId, physicalSegmentId, rootKey, segmentClass });
  return plaintextSegmentHeaderBytes({
    bytes: await decryptAesGcm({
      aad: encodeSegmentHeaderAad({ fileSystemId, segmentHeaderPrefix }),
      ciphertextAndTag: ciphertext,
      key,
      nonce: ZERO_NONCE,
    }),
  });
}

export async function encryptSegmentFooter({ fileSystemId, footerHeader, footerTrailer, nonce, physicalSegmentId, plaintext, rootKey }: {
  fileSystemId: FileSystemId;
  footerHeader: Uint8Array;
  footerTrailer: Uint8Array;
  nonce: SegmentFooterNonce;
  physicalSegmentId: SegmentId;
  plaintext: PlaintextSegmentFooterBytes;
  rootKey: FileSystemRootKey;
}): Promise<AuthenticatedSegmentFooterBytes> {
  requireSize({ bytes: footerHeader, expected: HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentFooterHeader, label: 'Segment Footer Header' });
  requireSize({ bytes: footerTrailer, expected: HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentFooterTrailer, label: 'Segment Footer Trailer' });
  const key = await deriveSegmentFooterKey({ fileSystemId, physicalSegmentId, rootKey });
  return authenticatedSegmentFooterBytes({
    bytes: await encryptAesGcm({
      aad: encodeSegmentFooterAad({ fileSystemId, footerHeader, footerTrailer }),
      key,
      nonce,
      plaintext,
    }),
  });
}

export async function decryptAuthenticatedSegmentFooter({ ciphertext, fileSystemId, footerHeader, footerTrailer, nonce, physicalSegmentId, rootKey }: {
  ciphertext: AuthenticatedSegmentFooterBytes;
  fileSystemId: FileSystemId;
  footerHeader: Uint8Array;
  footerTrailer: Uint8Array;
  nonce: SegmentFooterNonce;
  physicalSegmentId: SegmentId;
  rootKey: FileSystemRootKey;
}): Promise<PlaintextSegmentFooterBytes> {
  requireSize({ bytes: footerHeader, expected: HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentFooterHeader, label: 'Segment Footer Header' });
  requireSize({ bytes: footerTrailer, expected: HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.segmentFooterTrailer, label: 'Segment Footer Trailer' });
  const key = await deriveSegmentFooterKey({ fileSystemId, physicalSegmentId, rootKey });
  return plaintextSegmentFooterBytes({
    bytes: await decryptAesGcm({
      aad: encodeSegmentFooterAad({ fileSystemId, footerHeader, footerTrailer }),
      ciphertextAndTag: ciphertext,
      key,
      nonce,
    }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
