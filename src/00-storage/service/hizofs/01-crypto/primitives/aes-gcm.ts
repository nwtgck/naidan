import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format';
import { throwNormalizedHizoFSCryptoFailure } from '@/00-storage/service/hizofs/01-crypto/authentication-failure';

function validateNonce({ nonce }: { nonce: Uint8Array }): void {
  if (nonce.byteLength !== HIZOFS_V1_FORMAT_CONSTANTS.crypto.nonceBytes) {
    throw new RangeError('AES-GCM nonce must match the V1 nonce length');
  }
}

export async function encryptAesGcm({ aad, key, nonce, plaintext }: {
  aad: Uint8Array;
  key: CryptoKey;
  nonce: Uint8Array;
  plaintext: Uint8Array;
}): Promise<Uint8Array> {
  validateNonce({ nonce });
  const encrypted = await globalThis.crypto.subtle.encrypt(
    { additionalData: Uint8Array.from(aad), iv: Uint8Array.from(nonce), name: 'AES-GCM', tagLength: 128 },
    key,
    Uint8Array.from(plaintext),
  );
  return new Uint8Array(encrypted);
}

export async function decryptAesGcm({ aad, ciphertextAndTag, key, nonce }: {
  aad: Uint8Array;
  ciphertextAndTag: Uint8Array;
  key: CryptoKey;
  nonce: Uint8Array;
}): Promise<Uint8Array> {
  validateNonce({ nonce });
  if (ciphertextAndTag.byteLength < HIZOFS_V1_FORMAT_CONSTANTS.crypto.tagBytes) {
    throw new RangeError('AES-GCM ciphertext is shorter than the authentication tag');
  }
  try {
    const decrypted = await globalThis.crypto.subtle.decrypt(
      { additionalData: Uint8Array.from(aad), iv: Uint8Array.from(nonce), name: 'AES-GCM', tagLength: 128 },
      key,
      Uint8Array.from(ciphertextAndTag),
    );
    return new Uint8Array(decrypted);
  } catch (cause: unknown) {
    return throwNormalizedHizoFSCryptoFailure({ cause });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
