import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  encodeRecordAad,
  type FileSystemId,
  type SegmentId,
} from '@/00-storage/service/hizofs/00-format';
import { deriveRecordKey } from '@/00-storage/service/hizofs/01-crypto/key-application/derived-keys';
import { decryptAesGcm, encryptAesGcm } from '@/00-storage/service/hizofs/01-crypto/primitives/aes-gcm';
import type { FileSystemRootKey } from '@/00-storage/service/hizofs/01-crypto/secret-types';
import {
  authenticatedRecordBytes,
  plaintextRecordBytes,
  type AuthenticatedRecordBytes,
  type PlaintextRecordBytes,
  type RecordNonce,
} from '@/00-storage/service/hizofs/01-crypto/types';

function validateFrameHeader({ completeFrameHeader }: { completeFrameHeader: Uint8Array }): void {
  if (completeFrameHeader.byteLength !== HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.recordFrameHeader) {
    throw new RangeError('Record Frame Header must have the exact V1 byte length');
  }
}

export async function encryptRecord({ completeFrameHeader, fileSystemId, homeSegmentId, nonce, plaintext, rootKey }: {
  completeFrameHeader: Uint8Array;
  fileSystemId: FileSystemId;
  homeSegmentId: SegmentId;
  nonce: RecordNonce;
  plaintext: PlaintextRecordBytes;
  rootKey: FileSystemRootKey;
}): Promise<AuthenticatedRecordBytes> {
  validateFrameHeader({ completeFrameHeader });
  const key = await deriveRecordKey({ fileSystemId, homeSegmentId, rootKey });
  return authenticatedRecordBytes({
    bytes: await encryptAesGcm({
      aad: encodeRecordAad({ completeFrameHeader, fileSystemId }),
      key,
      nonce,
      plaintext,
    }),
  });
}

export async function decryptAuthenticatedRecord({ ciphertext, completeFrameHeader, fileSystemId, homeSegmentId, nonce, rootKey }: {
  ciphertext: AuthenticatedRecordBytes;
  completeFrameHeader: Uint8Array;
  fileSystemId: FileSystemId;
  homeSegmentId: SegmentId;
  nonce: RecordNonce;
  rootKey: FileSystemRootKey;
}): Promise<PlaintextRecordBytes> {
  validateFrameHeader({ completeFrameHeader });
  const key = await deriveRecordKey({ fileSystemId, homeSegmentId, rootKey });
  return plaintextRecordBytes({
    bytes: await decryptAesGcm({
      aad: encodeRecordAad({ completeFrameHeader, fileSystemId }),
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
