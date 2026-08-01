import {
  decodePersistenceControlBase64Url,
  encodePersistenceControlBase64Url,
  type FileSystemId,
} from '@/00-storage/service/hizofs/compatibility';
import {
  encodePersistenceControlAad,
  encodePersistenceControlCore,
  encodePersistenceControlKeyContext,
  encodePlainControlDigestContext,
  encodeUnsignedProtectedPersistenceControl,
  type NaidanPersistenceControlCoreV1,
  type NaidanPersistenceControlUnsignedProtectedV1,
  type NaidanPersistenceControlV1,
} from '@/00-storage/service/naidan-persistence-control/00-format';

export interface PersistenceControlRootKeyDerivationCapability {
  deriveAesGcmKey({ info }: { info: Uint8Array }): Promise<CryptoKey>;
}

export type PersistenceControlRandomSource = ({ bytes }: { bytes: Uint8Array }) => void;

function defaultRandomSource({ bytes }: { bytes: Uint8Array }): void {
  const owned = new Uint8Array(bytes.byteLength);
  globalThis.crypto.getRandomValues(owned);
  bytes.set(owned);
}


function toExactArrayBuffer({ bytes }: { bytes: Uint8Array }): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

function bytesEqual({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function isAeadAuthenticationFailure({ cause }: { cause: unknown }): boolean {
  return typeof cause === 'object' && cause !== null && 'name' in cause && cause.name === 'OperationError';
}

function buildHizoFSControlCryptographicMaterial({
  authenticationFileSystemId,
  core,
  nonce,
}: {
  authenticationFileSystemId: FileSystemId;
  core: NaidanPersistenceControlCoreV1;
  nonce: Uint8Array;
}): { readonly aad: Uint8Array; readonly info: Uint8Array } {
  const unsigned: NaidanPersistenceControlUnsignedProtectedV1 = {
    ...core,
    protection: {
      authenticationFileSystemId,
      nonce: encodePersistenceControlBase64Url({ bytes: nonce }),
      type: 'hizofs_aes_256_gcm',
    },
  };
  return {
    aad: encodePersistenceControlAad({
      canonicalUnsignedProtectedControlBytes: encodeUnsignedProtectedPersistenceControl({ control: unsigned }),
    }),
    info: encodePersistenceControlKeyContext({ authenticationFileSystemId, copy: core.copy, sequence: core.sequence }),
  };
}

export async function createPlainControlProtection({ core }: { core: NaidanPersistenceControlCoreV1 }): Promise<NaidanPersistenceControlV1['protection']> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest(
    'SHA-256',
    toExactArrayBuffer({ bytes: encodePlainControlDigestContext({ canonicalCoreBytes: encodePersistenceControlCore({ control: core }) }) }),
  ));
  return { digest: encodePersistenceControlBase64Url({ bytes: digest }), type: 'plain_sha256' };
}

export async function verifyPlainControlProtection({ control }: { control: NaidanPersistenceControlV1 }): Promise<boolean> {
  switch (control.protection.type) {
  case 'hizofs_aes_256_gcm': return false;
  case 'plain_sha256': break;
  default: return control.protection satisfies never;
  }
  const { protection: _protection, ...core } = control;
  const expected = await createPlainControlProtection({ core });
  switch (expected.type) {
  case 'plain_sha256':
    return bytesEqual({
      left: decodePersistenceControlBase64Url({ maximumDecodedBytes: 32, value: control.protection.digest }),
      right: decodePersistenceControlBase64Url({ maximumDecodedBytes: 32, value: expected.digest }),
    });
  case 'hizofs_aes_256_gcm': throw new Error('plain protection invariant failed');
  default: return expected satisfies never;
  }
}

export async function createHizoFSControlProtection({
  authenticationFileSystemId,
  core,
  randomSource,
  rootKey,
}: {
  authenticationFileSystemId: FileSystemId;
  core: NaidanPersistenceControlCoreV1;
  randomSource: PersistenceControlRandomSource | undefined;
  rootKey: PersistenceControlRootKeyDerivationCapability;
}): Promise<NaidanPersistenceControlV1['protection']> {
  const nonce = new Uint8Array(12);
  (randomSource ?? defaultRandomSource)({ bytes: nonce });
  const material = buildHizoFSControlCryptographicMaterial({ authenticationFileSystemId, core, nonce });
  const key = await rootKey.deriveAesGcmKey({ info: material.info });
  const encrypted = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    {
      additionalData: toExactArrayBuffer({ bytes: material.aad }),
      iv: toExactArrayBuffer({ bytes: nonce }),
      name: 'AES-GCM',
      tagLength: 128,
    },
    key,
    new ArrayBuffer(0),
  ));
  if (encrypted.byteLength !== 16) throw new Error('empty persistence control plaintext must produce exactly one authentication tag');
  return {
    authenticationFileSystemId,
    authenticatorTag: encodePersistenceControlBase64Url({ bytes: encrypted }),
    nonce: encodePersistenceControlBase64Url({ bytes: nonce }),
    type: 'hizofs_aes_256_gcm',
  };
}

export async function verifyHizoFSControlProtection({ control, rootKey }: {
  control: NaidanPersistenceControlV1;
  rootKey: PersistenceControlRootKeyDerivationCapability;
}): Promise<boolean> {
  switch (control.protection.type) {
  case 'hizofs_aes_256_gcm': break;
  case 'plain_sha256': return false;
  default: return control.protection satisfies never;
  }
  const { protection, ...core } = control;
  const nonce = decodePersistenceControlBase64Url({ maximumDecodedBytes: 12, value: protection.nonce });
  const material = buildHizoFSControlCryptographicMaterial({
    authenticationFileSystemId: protection.authenticationFileSystemId,
    core,
    nonce,
  });
  const key = await rootKey.deriveAesGcmKey({ info: material.info });
  try {
    const plaintext = new Uint8Array(await globalThis.crypto.subtle.decrypt(
      {
        additionalData: toExactArrayBuffer({ bytes: material.aad }),
        iv: toExactArrayBuffer({ bytes: nonce }),
        name: 'AES-GCM',
        tagLength: 128,
      },
      key,
      toExactArrayBuffer({ bytes: decodePersistenceControlBase64Url({ maximumDecodedBytes: 16, value: protection.authenticatorTag }) }),
    ));
    return plaintext.byteLength === 0;
  } catch (cause: unknown) {
    if (isAeadAuthenticationFailure({ cause })) return false;
    throw cause;
  }
}

export const TEST_ONLY = {
  buildHizoFSControlCryptographicMaterial,
  bytesEqual,
  isAeadAuthenticationFailure,
  toExactArrayBuffer,
};
