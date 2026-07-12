import type {
  EncryptedStoreHeaderDto,
  EncryptionKeySlotDto,
} from '@/00-storage/00-dto/encryption.dto';
import { decodeBase64UrlWithLength, encodeBase64Url } from './base64-url';
import { assertEncryptionPassphraseCanBeUsed } from './passphrase';
import { toExactArrayBuffer } from './array-buffer';
import type { CreatedEncryptionMaterial, EncryptedStoreRuntimeKeys } from './types';

export const DEFAULT_PBKDF2_ITERATIONS = 600_000;
export const MAX_PBKDF2_ITERATIONS = 10_000_000;
export const MAX_ENCRYPTION_KEY_SLOTS = 32;

const UTF8 = new TextEncoder();
const OBJECT_ENCRYPTION_HKDF_INFO = UTF8.encode('naidan/opfs-encryption/object-encryption-key/v1');
const OBJECT_ADDRESS_HKDF_INFO = UTF8.encode('naidan/opfs-encryption/object-address-key/v1');

function randomBytes({ byteLength }: { byteLength: number }): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(byteLength));
}

export function createEncryptionOpaqueId(): string {
  return encodeBase64Url({ bytes: randomBytes({ byteLength: 16 }) });
}

function createWrappedKeyAad({
  purpose,
  bindingId,
}: {
  purpose: 'storage_unlock_key' | 'store_root_key',
  bindingId: string,
}): Uint8Array {
  const role = (() => {
    switch (purpose) {
    case 'storage_unlock_key':
      return 'storage-unlock-key';
    case 'store_root_key':
      return 'store-root-key';
    default: {
      const _ex: never = purpose;
      throw new Error(`Unhandled wrapped key purpose: ${String(_ex)}`);
    }
    }
  })();
  return UTF8.encode(`naidan/opfs-encryption/${role}/v1/${bindingId}`);
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

async function deriveSecretWrappingKey({
  secret,
  salt,
  iterations,
}: {
  secret: Uint8Array,
  salt: Uint8Array,
  iterations: number,
}): Promise<CryptoKey> {
  if (
    !Number.isSafeInteger(iterations)
    || iterations <= 0
    || iterations > MAX_PBKDF2_ITERATIONS
  ) {
    throw new Error(
      `PBKDF2 iteration count must be between 1 and ${MAX_PBKDF2_ITERATIONS}`,
    );
  }
  const material = await crypto.subtle.importKey(
    'raw',
    toExactArrayBuffer({ bytes: secret }),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
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
  additionalData,
}: {
  rawKey: Uint8Array,
  wrappingKey: CryptoKey,
  additionalData: Uint8Array,
}): Promise<{ nonce: string, ciphertext: string }> {
  if (rawKey.byteLength !== 32) {
    throw new Error('Wrapped key plaintext must contain exactly 32 bytes');
  }
  const nonce = randomBytes({ byteLength: 12 });
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toExactArrayBuffer({ bytes: nonce }),
      additionalData: toExactArrayBuffer({ bytes: additionalData }),
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
  additionalData,
}: {
  wrappedKey: { nonce: string, ciphertext: string },
  wrappingKey: CryptoKey,
  additionalData: Uint8Array,
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
      additionalData: toExactArrayBuffer({ bytes: additionalData }),
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

export async function createEncryptionKeySlotFromSecret({
  storageUnlockKey,
  secret,
  keySlotId,
  pbkdf2Iterations,
}: {
  storageUnlockKey: Uint8Array,
  secret: Uint8Array,
  keySlotId: string,
  pbkdf2Iterations: number,
}): Promise<EncryptionKeySlotDto> {
  const salt = randomBytes({ byteLength: 32 });
  try {
    const wrappingKey = await deriveSecretWrappingKey({
      secret,
      salt,
      iterations: pbkdf2Iterations,
    });
    return {
      id: keySlotId,
      keyDerivation: {
        type: 'pbkdf2_sha256',
        salt: encodeBase64Url({ bytes: salt }),
        iterations: pbkdf2Iterations,
      },
      wrappedStorageUnlockKey: await wrapRawKey({
        rawKey: storageUnlockKey,
        wrappingKey,
        additionalData: createWrappedKeyAad({
          purpose: 'storage_unlock_key',
          bindingId: keySlotId,
        }),
      }),
    };
  } finally {
    salt.fill(0);
  }
}

export async function createPassphraseEncryptionKeySlot({
  storageUnlockKey,
  passphrase,
  keySlotId,
  pbkdf2Iterations,
}: {
  storageUnlockKey: Uint8Array,
  passphrase: string,
  keySlotId: string,
  pbkdf2Iterations: number,
}): Promise<EncryptionKeySlotDto> {
  assertEncryptionPassphraseCanBeUsed({ passphrase });
  const passphraseBytes = UTF8.encode(passphrase);
  try {
    return await createEncryptionKeySlotFromSecret({
      storageUnlockKey,
      secret: passphraseBytes,
      keySlotId,
      pbkdf2Iterations,
    });
  } finally {
    passphraseBytes.fill(0);
  }
}

export async function replacePassphraseEncryptionKeySlot({
  storageUnlockKey,
  keySlots,
  keySlotId,
  passphrase,
  pbkdf2Iterations,
}: {
  storageUnlockKey: Uint8Array,
  keySlots: EncryptionKeySlotDto[],
  keySlotId: string,
  passphrase: string,
  pbkdf2Iterations: number,
}): Promise<EncryptionKeySlotDto[]> {
  const replacement = await createPassphraseEncryptionKeySlot({
    storageUnlockKey,
    passphrase,
    keySlotId,
    pbkdf2Iterations,
  });
  const nextSlots = keySlots.map(slot => slot.id === keySlotId ? replacement : slot);
  if (!nextSlots.some(slot => slot.id === keySlotId)) {
    throw new Error(`Encryption key slot does not exist: ${keySlotId}`);
  }
  return nextSlots;
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
  try {
    const keySlotId = createEncryptionOpaqueId();
    const keySlot = await createPassphraseEncryptionKeySlot({
      storageUnlockKey,
      passphrase,
      keySlotId,
      pbkdf2Iterations,
    });
    return {
      storageUnlockKey,
      storeRootKey,
      keySlots: [keySlot],
    };
  } catch (error) {
    storageUnlockKey.fill(0);
    storeRootKey.fill(0);
    throw error;
  }
}

export async function unlockStorageUnlockKeyWithPassphrase({
  keySlots,
  passphrase,
}: {
  keySlots: EncryptionKeySlotDto[],
  passphrase: string,
}): Promise<{ storageUnlockKey: Uint8Array, keySlotId: string }> {
  assertEncryptionPassphraseCanBeUsed({ passphrase });
  if (keySlots.length === 0 || keySlots.length > MAX_ENCRYPTION_KEY_SLOTS) {
    throw new Error(
      `Encryption state must contain between 1 and ${MAX_ENCRYPTION_KEY_SLOTS} key slots`,
    );
  }
  const passphraseBytes = UTF8.encode(passphrase);
  try {
    for (const keySlot of keySlots) {
      switch (keySlot.keyDerivation.type) {
      case 'pbkdf2_sha256': {
        const salt = decodeBase64UrlWithLength({
          value: keySlot.keyDerivation.salt,
          expectedByteLength: 32,
          fieldName: 'Encryption key slot KDF salt',
        });
        try {
          const wrappingKey = await deriveSecretWrappingKey({
            secret: passphraseBytes,
            salt,
            iterations: keySlot.keyDerivation.iterations,
          });
          try {
            return {
              storageUnlockKey: await unwrapRawKey({
                wrappedKey: keySlot.wrappedStorageUnlockKey,
                wrappingKey,
                additionalData: createWrappedKeyAad({
                  purpose: 'storage_unlock_key',
                  bindingId: keySlot.id,
                }),
              }),
              keySlotId: keySlot.id,
            };
          } catch {
            // Another slot may have been created from this passphrase.
          }
        } finally {
          salt.fill(0);
        }
        break;
      }
      }
    }
  } finally {
    passphraseBytes.fill(0);
  }
  throw new Error('Passphrase did not unlock any encryption key slot');
}

export async function wrapStoreRootKey({
  storageUnlockKey,
  storeRootKey,
  encryptedStoreId,
}: {
  storageUnlockKey: Uint8Array,
  storeRootKey: Uint8Array,
  encryptedStoreId: string,
}): Promise<EncryptedStoreHeaderDto['wrappedStoreRootKey']> {
  const wrappingKey = await importAesGcmKey({
    rawKey: storageUnlockKey,
    usages: ['encrypt'],
  });
  return await wrapRawKey({
    rawKey: storeRootKey,
    wrappingKey,
    additionalData: createWrappedKeyAad({
      purpose: 'store_root_key',
      bindingId: encryptedStoreId,
    }),
  });
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
    additionalData: createWrappedKeyAad({
      purpose: 'store_root_key',
      bindingId: header.encryptedStoreId,
    }),
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
  createWrappedKeyAad,
  deriveSecretWrappingKey,
  unwrapRawKey,
  wrapRawKey,
};
