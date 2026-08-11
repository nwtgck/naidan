import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format';
import { throwNormalizedHizoFSCryptoFailure } from '@/00-storage/service/hizofs/01-crypto/authentication-failure';
import type { AuthenticatedRecordBytes, PlaintextRecordBytes, RecordNonce } from '@/00-storage/service/hizofs/01-crypto/types';

function requireArrayBufferBacked({ bytes, label }: { bytes: Uint8Array; label: string }): Uint8Array<ArrayBuffer> {
  if (!(bytes.buffer instanceof ArrayBuffer)) {
    throw new TypeError(`${label} must be backed by an ArrayBuffer`);
  }
  return bytes as Uint8Array<ArrayBuffer>;
}

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

/**
 * Encrypts an append-owned Record plaintext without re-snapshotting it in JavaScript.
 *
 * WHY: AuthenticatedSegmentWriter already owns PlaintextRecordBytes until this
 * Promise settles and zeroizes them before backend I/O. The generic AES-GCM
 * primitive deliberately snapshots arbitrary caller buffers, but doing that
 * again here copied every File Data Record immediately before Web Crypto.
 * The Web Crypto result is a fresh ArrayBuffer, so it can carry the authenticated
 * Record brand directly without another full ciphertext copy.
 */
export async function encryptAesGcmOwnedRecord({ aad, key, nonce, plaintext }: {
  aad: Uint8Array;
  key: CryptoKey;
  nonce: RecordNonce;
  plaintext: PlaintextRecordBytes;
}): Promise<AuthenticatedRecordBytes> {
  validateNonce({ nonce });
  const encrypted = await globalThis.crypto.subtle.encrypt(
    {
      additionalData: requireArrayBufferBacked({ bytes: aad, label: 'Record AAD' }),
      iv: requireArrayBufferBacked({ bytes: nonce, label: 'Record nonce' }),
      name: 'AES-GCM',
      tagLength: 128,
    },
    key,
    requireArrayBufferBacked({ bytes: plaintext, label: 'Record plaintext' }),
  );
  return new Uint8Array(encrypted) as AuthenticatedRecordBytes;
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
