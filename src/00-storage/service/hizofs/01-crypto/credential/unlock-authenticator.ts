import {
  encodeUnlockAuthenticatorAad,
  type FileSystemId,
  type UnlockSequence,
} from '@/00-storage/service/hizofs/00-format';
import { deriveUnlockAuthenticatorKey } from '@/00-storage/service/hizofs/01-crypto/key-application/derived-keys';
import { decryptAesGcm, encryptAesGcm } from '@/00-storage/service/hizofs/01-crypto/primitives/aes-gcm';
import type { FileSystemRootKey } from '@/00-storage/service/hizofs/01-crypto/secret-types';
import {
  unlockAuthenticatorTag,
  type UnlockAuthenticatorNonce,
  type UnlockAuthenticatorTag,
} from '@/00-storage/service/hizofs/01-crypto/types';

export async function createUnlockAuthenticatorTag({
  canonicalUnsignedEnvelopeBytes,
  copy,
  fileSystemId,
  nonce,
  rootKey,
  unlockSequence,
}: {
  canonicalUnsignedEnvelopeBytes: Uint8Array;
  copy: 0 | 1;
  fileSystemId: FileSystemId;
  nonce: UnlockAuthenticatorNonce;
  rootKey: FileSystemRootKey;
  unlockSequence: UnlockSequence;
}): Promise<UnlockAuthenticatorTag> {
  const key = await deriveUnlockAuthenticatorKey({ copy, fileSystemId, rootKey, unlockSequence });
  return unlockAuthenticatorTag({
    bytes: await encryptAesGcm({
      aad: encodeUnlockAuthenticatorAad({ canonicalUnsignedEnvelopeBytes }),
      key,
      nonce,
      plaintext: new Uint8Array(),
    }),
  });
}

export async function verifyUnlockAuthenticator({
  canonicalUnsignedEnvelopeBytes,
  copy,
  fileSystemId,
  nonce,
  rootKey,
  tag,
  unlockSequence,
}: {
  canonicalUnsignedEnvelopeBytes: Uint8Array;
  copy: 0 | 1;
  fileSystemId: FileSystemId;
  nonce: UnlockAuthenticatorNonce;
  rootKey: FileSystemRootKey;
  tag: UnlockAuthenticatorTag;
  unlockSequence: UnlockSequence;
}): Promise<void> {
  const key = await deriveUnlockAuthenticatorKey({ copy, fileSystemId, rootKey, unlockSequence });
  const plaintext = await decryptAesGcm({
    aad: encodeUnlockAuthenticatorAad({ canonicalUnsignedEnvelopeBytes }),
    ciphertextAndTag: tag,
    key,
    nonce,
  });
  if (plaintext.byteLength !== 0) throw new TypeError('Unlock Authenticator unexpectedly produced plaintext');
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
