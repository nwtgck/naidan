import type {
  EncryptedStoreHeaderDto,
  PassphraseEncryptionKeySlotDto,
} from '@/00-storage/00-dto/encryption.dto';
import { decodeBase64UrlWithLength, encodeBase64Url } from './base64-url';
import { assertEncryptionPassphraseCanBeUsed } from './passphrase';
import { toExactArrayBuffer } from './array-buffer';
import type { CreatedEncryptionMaterial, EncryptedStoreRuntimeKeys } from './types';

export const DEFAULT_PBKDF2_ITERATIONS = 600_000;

const UTF8 = new TextEncoder();
const WRAPPED_KEY_AAD = UTF8.encode('naidan/opfs-encryption/wrapped-key/v1');
const OBJECT_ENCRYPTION_HKDF_INFO = UTF8.encode('naidan/opfs-encryption/object-encryption-key/v1');
const OBJECT_ADDRESS_HKDF_INFO = UTF8.encode('naidan/opfs-encryption/object-address-key/v1');

function randomBytes({ byteLength }: { byteLength: number }): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(byteLength));
}

export function createEncryptionOpaqueId(): string {
  return encodeBase64Url({ bytes: randomBytes({ byteLength: 16 }) });
}

async function importAesGcmKey({ rawKey, usages }: {
  rawKey: Uint8Array,
  usages: KeyUsage[],
}): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    toExactArrayBuffer({ bytes: rawKey }),
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}

async function derivePassphraseWrappingKey({
  passphrase,
  salt,
  iterations,
}: {
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
}): Promise<CryptoKey> {
  assertEncryptionPassphraseCanBeUsed({ passphrase });
  if (!Number.isSafeInteger(iterations) || iterations <= 0) {
    throw new Error('PBKDF2 iteration count must be a positive safe integer');
  }

  const passphraseBytes = UTF8.encode(passphrase);
  let material: CryptoKey;
  try {
    material = await crypto.subtle.importKey(
      'raw',
      toExactArrayBuffer({ bytes: passphraseBytes }),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
  } finally {
    passphraseBytes.fill(0);
  }
  return await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: toExactArrayBuffer({ bytes: salt }),
      iterations,
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function wrapRawKey({
  rawKey,
  wrappingKey,
}: {
  rawKey: Uint8Array,
  wrappingKey: CryptoKey,
}): Promise<{ nonce: string, ciphertext: string }> {
  if (rawKey.byteLength !== 32) {
    throw new Error('Wrapped key plaintext must contain exactly 32 bytes');
  }
  const nonce = randomBytes({ byteLength: 12 });
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toExactArrayBuffer({ bytes: nonce }),
      additionalData: toExactArrayBuffer({ bytes: WRAPPED_KEY_AAD }),
      tagLength: 128,
    },
    wrappingKey,
    toExactArrayBuffer({ bytes: rawKey }),
  );
  return {
    nonce: encodeBase64Url({ bytes: nonce }),
    ciphertext: encodeBase64Url({ bytes: new Uint8Array(ciphertext) }),
  };
}

async function unwrapRawKey({
  wrappedKey,
  wrappingKey,
}: {
  wrappedKey: { nonce: string, ciphertext: string },
  wrappingKey: CryptoKey,
}): Promise<Uint8Array> {
  const nonce = decodeBase64UrlWithLength({
    value: wrappedKey.nonce,
    expectedByteLength: 12,
    fieldName: 'Wrapped key nonce',
  });
  const ciphertext = decodeBase64UrlWithLength({
    value: wrappedKey.ciphertext,
    expectedByteLength: 48,
    fieldName: 'Wrapped key ciphertext',
  });
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toExactArrayBuffer({ bytes: nonce }),
      additionalData: toExactArrayBuffer({ bytes: WRAPPED_KEY_AAD }),
      tagLength: 128,
    },
    wrappingKey,
    toExactArrayBuffer({ bytes: ciphertext }),
  );
  const rawKey = new Uint8Array(plaintext);
  if (rawKey.byteLength !== 32) {
    throw new Error('Unwrapped key must contain exactly 32 bytes');
  }
  return rawKey;
}

export async function createPassphraseEncryptionKeySlot({
  storageUnlockKey,
  passphrase,
  pbkdf2Iterations,
}: {
  storageUnlockKey: Uint8Array,
  passphrase: string,
  pbkdf2Iterations: number,
}): Promise<PassphraseEncryptionKeySlotDto> {
  assertEncryptionPassphraseCanBeUsed({ passphrase });
  const salt = randomBytes({ byteLength: 32 });
  try {
    const wrappingKey = await derivePassphraseWrappingKey({
      passphrase,
      salt,
      iterations: pbkdf2Iterations,
    });
    return {
      pbkdf2: {
        salt: encodeBase64Url({ bytes: salt }),
        iterations: pbkdf2Iterations,
      },
      wrappedStorageUnlockKey: await wrapRawKey({
        rawKey: storageUnlockKey,
        wrappingKey,
      }),
    };
  } finally {
    salt.fill(0);
  }
}

export async function replacePassphraseEncryptionKeySlot({
  storageUnlockKey,
  passphrase,
  pbkdf2Iterations,
}: {
  storageUnlockKey: Uint8Array,
  passphrase: string,
  pbkdf2Iterations: number,
}): Promise<PassphraseEncryptionKeySlotDto> {
  return await createPassphraseEncryptionKeySlot({
    storageUnlockKey,
    passphrase,
    pbkdf2Iterations,
  });
}

export async function createEncryptionMaterial({
  passphrase,
  pbkdf2Iterations,
}: {
  passphrase: string,
  pbkdf2Iterations: number,
}): Promise<CreatedEncryptionMaterial> {
  assertEncryptionPassphraseCanBeUsed({ passphrase });
  const storageUnlockKey = randomBytes({ byteLength: 32 });
  const storeRootKey = randomBytes({ byteLength: 32 });
  const passphraseSlot = await createPassphraseEncryptionKeySlot({
    storageUnlockKey,
    passphrase,
    pbkdf2Iterations,
  });

  return {
    storageUnlockKey,
    storeRootKey,
    passphraseKeySlot: passphraseSlot,
  };
}

export async function unlockStorageUnlockKeyWithPassphrase({
  passphraseKeySlot,
  passphrase,
}: {
  passphraseKeySlot: PassphraseEncryptionKeySlotDto,
  passphrase: string,
}): Promise<Uint8Array> {
  assertEncryptionPassphraseCanBeUsed({ passphrase });
  try {
    const salt = decodeBase64UrlWithLength({
      value: passphraseKeySlot.pbkdf2.salt,
      expectedByteLength: 32,
      fieldName: 'Passphrase KDF salt',
    });
    try {
      const wrappingKey = await derivePassphraseWrappingKey({
        passphrase,
        salt,
        iterations: passphraseKeySlot.pbkdf2.iterations,
      });
      return await unwrapRawKey({
        wrappedKey: passphraseKeySlot.wrappedStorageUnlockKey,
        wrappingKey,
      });
    } finally {
      salt.fill(0);
    }
  } catch (error) {
    throw new Error('Passphrase did not unlock the encryption key slot', {
      cause: error,
    });
  }
}

export async function wrapStoreRootKey({
  storageUnlockKey,
  storeRootKey,
}: {
  storageUnlockKey: Uint8Array,
  storeRootKey: Uint8Array,
}): Promise<EncryptedStoreHeaderDto['wrappedStoreRootKey']> {
  const wrappingKey = await importAesGcmKey({
    rawKey: storageUnlockKey,
    usages: ['encrypt'],
  });
  return await wrapRawKey({ rawKey: storeRootKey, wrappingKey });
}

export async function unwrapStoreRootKey({
  storageUnlockKey,
  header,
}: {
  storageUnlockKey: Uint8Array,
  header: EncryptedStoreHeaderDto,
}): Promise<Uint8Array> {
  const wrappingKey = await importAesGcmKey({
    rawKey: storageUnlockKey,
    usages: ['decrypt'],
  });
  return await unwrapRawKey({
    wrappedKey: header.wrappedStoreRootKey,
    wrappingKey,
  });
}

export async function deriveEncryptedStoreRuntimeKeys({
  storeRootKey,
  encryptedStoreId,
}: {
  storeRootKey: Uint8Array,
  encryptedStoreId: string,
}): Promise<EncryptedStoreRuntimeKeys> {
  if (storeRootKey.byteLength !== 32) {
    throw new Error('Encrypted store root key must contain exactly 32 bytes');
  }
  const material = await crypto.subtle.importKey(
    'raw',
    toExactArrayBuffer({ bytes: storeRootKey }),
    'HKDF',
    false,
    ['deriveKey'],
  );
  const salt = UTF8.encode(encryptedStoreId);
  const objectEncryptionKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toExactArrayBuffer({ bytes: salt }),
      info: toExactArrayBuffer({ bytes: OBJECT_ENCRYPTION_HKDF_INFO }),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const objectAddressKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toExactArrayBuffer({ bytes: salt }),
      info: toExactArrayBuffer({ bytes: OBJECT_ADDRESS_HKDF_INFO }),
    },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  return { objectEncryptionKey, objectAddressKey };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  derivePassphraseWrappingKey,
  unwrapRawKey,
  wrapRawKey,
};
