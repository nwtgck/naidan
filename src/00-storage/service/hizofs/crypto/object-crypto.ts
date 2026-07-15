import { encodeBase64Url } from '@/00-storage/service/hizofs/base64-url';
import { toExactArrayBuffer } from '@/00-storage/service/hizofs/bytes';

const ROOT_KEY_BYTE_LENGTH = 32;
const FILE_SYSTEM_ID_BIT_LENGTH = 128;
const NONCE_BYTE_LENGTH = 12;
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

async function deriveObjectKey({ rootKey, fileSystemId, objectIdentity, area }: {
  rootKey: CryptoKey;
  fileSystemId: string;
  objectIdentity: string;
  area: 'object' | 'superblock';
}): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toExactArrayBuffer({ bytes: UTF8.encode(`HizoFS/v1/filesystem/${fileSystemId}`) }),
      info: toExactArrayBuffer({
        bytes: UTF8.encode(`HizoFS/v1/${area}/${objectIdentity}`),
      }),
    },
    rootKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function createAad({ fileSystemId, objectIdentity, area }: {
  fileSystemId: string;
  objectIdentity: string;
  area: 'object' | 'superblock';
}): Uint8Array {
  return UTF8.encode(`HizoFS/v1/${area}/${fileSystemId}/${objectIdentity}`);
}

export async function encryptHizoFSObject({
  rootKey,
  fileSystemId,
  objectIdentity,
  area,
  plaintext,
}: {
  rootKey: CryptoKey;
  fileSystemId: string;
  objectIdentity: string;
  area: 'object' | 'superblock';
  plaintext: Uint8Array;
}): Promise<{
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTE_LENGTH));
  const key = await deriveObjectKey({ rootKey, fileSystemId, objectIdentity, area });
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toExactArrayBuffer({ bytes: nonce }),
      additionalData: toExactArrayBuffer({
        bytes: createAad({ fileSystemId, objectIdentity, area }),
      }),
      tagLength: 128,
    },
    key,
    toExactArrayBuffer({ bytes: plaintext }),
  ));
  return { nonce, ciphertext };
}

export async function decryptHizoFSObject({
  rootKey,
  fileSystemId,
  objectIdentity,
  area,
  nonce,
  ciphertext,
}: {
  rootKey: CryptoKey;
  fileSystemId: string;
  objectIdentity: string;
  area: 'object' | 'superblock';
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}): Promise<Uint8Array> {
  const key = await deriveObjectKey({ rootKey, fileSystemId, objectIdentity, area });
  return new Uint8Array(await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toExactArrayBuffer({ bytes: nonce }),
      additionalData: toExactArrayBuffer({
        bytes: createAad({ fileSystemId, objectIdentity, area }),
      }),
      tagLength: 128,
    },
    key,
    toExactArrayBuffer({ bytes: ciphertext }),
  ));
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
