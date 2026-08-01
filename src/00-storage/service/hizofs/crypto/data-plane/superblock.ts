import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  encodeSuperblockAad,
  type FileSystemId,
  type PublicationSequence,
} from '@/00-storage/service/hizofs/00-format';
import { deriveSuperblockKey } from '@/00-storage/service/hizofs/crypto/key-application/derived-keys';
import { decryptAesGcm, encryptAesGcm } from '@/00-storage/service/hizofs/crypto/primitives/aes-gcm';
import type { FileSystemRootKey } from '@/00-storage/service/hizofs/crypto/secret-types';
import {
  authenticatedSuperblockBytes,
  plaintextSuperblockBytes,
  type AuthenticatedSuperblockBytes,
  type PlaintextSuperblockBytes,
  type SuperblockNonce,
} from '@/00-storage/service/hizofs/crypto/types';

function validateHeader({ exactHeader }: { exactHeader: Uint8Array }): void {
  if (exactHeader.byteLength !== HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.superblockHeader) {
    throw new RangeError('Superblock Header must have the exact V1 byte length');
  }
}

export async function encryptSuperblock({ copy, exactHeader, fileSystemId, nonce, plaintext, publicationSequence, rootKey }: {
  copy: 0 | 1;
  exactHeader: Uint8Array;
  fileSystemId: FileSystemId;
  nonce: SuperblockNonce;
  plaintext: PlaintextSuperblockBytes;
  publicationSequence: PublicationSequence;
  rootKey: FileSystemRootKey;
}): Promise<AuthenticatedSuperblockBytes> {
  validateHeader({ exactHeader });
  const key = await deriveSuperblockKey({ copy, fileSystemId, publicationSequence, rootKey });
  return authenticatedSuperblockBytes({
    bytes: await encryptAesGcm({ aad: encodeSuperblockAad({ exactHeader }), key, nonce, plaintext }),
  });
}

export async function decryptAuthenticatedSuperblock({ ciphertext, copy, exactHeader, fileSystemId, nonce, publicationSequence, rootKey }: {
  ciphertext: AuthenticatedSuperblockBytes;
  copy: 0 | 1;
  exactHeader: Uint8Array;
  fileSystemId: FileSystemId;
  nonce: SuperblockNonce;
  publicationSequence: PublicationSequence;
  rootKey: FileSystemRootKey;
}): Promise<PlaintextSuperblockBytes> {
  validateHeader({ exactHeader });
  const key = await deriveSuperblockKey({ copy, fileSystemId, publicationSequence, rootKey });
  return plaintextSuperblockBytes({
    bytes: await decryptAesGcm({ aad: encodeSuperblockAad({ exactHeader }), ciphertextAndTag: ciphertext, key, nonce }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
