import { toExactArrayBuffer } from '@/00-storage/service/encrypted-opfs/bytes';

const ROOT_KEY_BYTE_LENGTH = 32;
const NONCE_BYTE_LENGTH = 12;
const UTF8 = new TextEncoder();

export async function importEncryptedOpfsRootKey({ rawRootKey }: {
  rawRootKey: Uint8Array;
}): Promise<CryptoKey> {
  if (rawRootKey.byteLength !== ROOT_KEY_BYTE_LENGTH) {
    throw new Error('EncryptedOpfs root key must contain exactly 32 bytes');
  }
  return crypto.subtle.importKey(
    'raw',
    toExactArrayBuffer({ bytes: rawRootKey }),
    'HKDF',
    false,
    ['deriveKey'],
  );
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
      salt: toExactArrayBuffer({ bytes: UTF8.encode(`EncryptedOpfs/v1/filesystem/${fileSystemId}`) }),
      info: toExactArrayBuffer({
        bytes: UTF8.encode(`EncryptedOpfs/v1/${area}/${objectIdentity}`),
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
  return UTF8.encode(`EncryptedOpfs/v1/${area}/${fileSystemId}/${objectIdentity}`);
}

export async function encryptEncryptedOpfsObject({
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

export async function decryptEncryptedOpfsObject({
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
