import { decodeBase64Url } from '@/00-storage/service/hizofs/base64-url';
import { concatenateBytes, toExactArrayBuffer } from '@/00-storage/service/hizofs/bytes';
import {
  assertHizoFSSegmentId,
  encodeHizoFSSegmentId,
} from '@/00-storage/service/hizofs/segment-store/object-reference';

const UTF8 = new TextEncoder();
const HIZOFS_NONCE_BYTE_LENGTH = 12;

function decodeFileSystemId({ fileSystemId }: {
  fileSystemId: string;
}): Uint8Array {
  const bytes = decodeBase64Url({ value: fileSystemId });
  if (bytes.byteLength !== 16) {
    throw new Error('HizoFS file-system ID must decode to exactly 16 bytes');
  }
  return bytes;
}

async function deriveAesKey({ rootKey, salt, info }: {
  rootKey: CryptoKey;
  salt: Uint8Array;
  info: Uint8Array;
}): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toExactArrayBuffer({ bytes: salt }),
      info: toExactArrayBuffer({ bytes: info }),
    },
    rootKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function deriveHizoFSSegmentRecordKey({
  rootKey,
  fileSystemId,
  homeSegmentId,
}: {
  rootKey: CryptoKey;
  fileSystemId: string;
  homeSegmentId: Uint8Array;
}): Promise<CryptoKey> {
  assertHizoFSSegmentId({ segmentId: homeSegmentId });
  return deriveAesKey({
    rootKey,
    salt: concatenateBytes({
      parts: [
        UTF8.encode('HizoFS/v1/segment-record/salt/'),
        decodeFileSystemId({ fileSystemId }),
      ],
    }),
    info: UTF8.encode(
      `HizoFS/v1/segment-record/${encodeHizoFSSegmentId({ segmentId: homeSegmentId })}`,
    ),
  });
}

export async function deriveHizoFSSegmentHeaderKey({
  rootKey,
  fileSystemId,
  segmentId,
}: {
  rootKey: CryptoKey;
  fileSystemId: string;
  segmentId: Uint8Array;
}): Promise<CryptoKey> {
  assertHizoFSSegmentId({ segmentId });
  return deriveAesKey({
    rootKey,
    salt: concatenateBytes({
      parts: [
        UTF8.encode('HizoFS/v1/segment-header/salt/'),
        decodeFileSystemId({ fileSystemId }),
      ],
    }),
    info: UTF8.encode(
      `HizoFS/v1/segment-header/${encodeHizoFSSegmentId({ segmentId })}`,
    ),
  });
}

export async function deriveHizoFSHeadKey({
  rootKey,
  fileSystemId,
  slot,
}: {
  rootKey: CryptoKey;
  fileSystemId: string;
  slot: 0 | 1;
}): Promise<CryptoKey> {
  return deriveAesKey({
    rootKey,
    salt: concatenateBytes({
      parts: [
        UTF8.encode('HizoFS/v1/head/salt/'),
        decodeFileSystemId({ fileSystemId }),
      ],
    }),
    info: UTF8.encode(`HizoFS/v1/head/${String(slot)}`),
  });
}

export function createHizoFSNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(HIZOFS_NONCE_BYTE_LENGTH));
}

export async function encryptHizoFSAesGcm({
  key,
  nonce,
  plaintext,
  additionalData,
}: {
  key: CryptoKey;
  nonce: Uint8Array;
  plaintext: Uint8Array;
  additionalData: Uint8Array;
}): Promise<Uint8Array> {
  if (nonce.byteLength !== HIZOFS_NONCE_BYTE_LENGTH) {
    throw new Error('HizoFS AES-GCM nonce must contain exactly 12 bytes');
  }
  return new Uint8Array(await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toExactArrayBuffer({ bytes: nonce }),
      additionalData: toExactArrayBuffer({ bytes: additionalData }),
      tagLength: 128,
    },
    key,
    toExactArrayBuffer({ bytes: plaintext }),
  ));
}

export async function decryptHizoFSAesGcm({
  key,
  nonce,
  ciphertext,
  additionalData,
}: {
  key: CryptoKey;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  additionalData: Uint8Array;
}): Promise<Uint8Array> {
  if (nonce.byteLength !== HIZOFS_NONCE_BYTE_LENGTH) {
    throw new Error('HizoFS AES-GCM nonce must contain exactly 12 bytes');
  }
  return new Uint8Array(await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toExactArrayBuffer({ bytes: nonce }),
      additionalData: toExactArrayBuffer({ bytes: additionalData }),
      tagLength: 128,
    },
    key,
    toExactArrayBuffer({ bytes: ciphertext }),
  ));
}

export const HIZOFS_AES_GCM_TAG_BYTE_LENGTH = 16;
export const HIZOFS_AES_GCM_NONCE_BYTE_LENGTH = HIZOFS_NONCE_BYTE_LENGTH;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  decodeFileSystemId,
};
