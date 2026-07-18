import { encodeBase64Url } from '@/00-storage/service/hizofs/base64-url';
import { toExactArrayBuffer } from '@/00-storage/service/hizofs/bytes';

const ROOT_KEY_BYTE_LENGTH = 32;
const FILE_SYSTEM_ID_BIT_LENGTH = 128;
const UTF8 = new TextEncoder();

export async function importHizoFSRootKey({ rawRootKey }: {
  rawRootKey: Uint8Array;
}): Promise<CryptoKey> {
  if (rawRootKey.byteLength !== ROOT_KEY_BYTE_LENGTH) {
    throw new Error('HizoFS root key must contain exactly 32 bytes');
  }
  return crypto.subtle.importKey(
    'raw',
    toExactArrayBuffer({ bytes: rawRootKey }),
    'HKDF',
    false,
    ['deriveBits', 'deriveKey'],
  );
}


export async function importHizoFSWorkerRootKey({ rawRootKey }: {
  rawRootKey: Uint8Array;
}): Promise<CryptoKey> {
  if (rawRootKey.byteLength !== ROOT_KEY_BYTE_LENGTH) {
    throw new Error('HizoFS root key must contain exactly 32 bytes');
  }
  return crypto.subtle.importKey(
    'raw',
    toExactArrayBuffer({ bytes: rawRootKey }),
    'HKDF',
    false,
    ['deriveKey'],
  );
}

/**
 * Derives the stable filesystem identity from the root key instead of relying
 * on one plaintext descriptor field as the only copy of critical key-domain
 * metadata. The descriptor can therefore be reconstructed without making the
 * encrypted object graph unreadable.
 */
export async function deriveHizoFSFileSystemId({ rootKey }: {
  rootKey: CryptoKey;
}): Promise<string> {
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toExactArrayBuffer({
        bytes: UTF8.encode('HizoFS/v1/filesystem-id/salt'),
      }),
      info: toExactArrayBuffer({
        bytes: UTF8.encode('HizoFS/v1/filesystem-id'),
      }),
    },
    rootKey,
    FILE_SYSTEM_ID_BIT_LENGTH,
  );
  return encodeBase64Url({ bytes: new Uint8Array(bits) });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
