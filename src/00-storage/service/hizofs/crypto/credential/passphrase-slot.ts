import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD,
  encodePassphraseSlotAad,
  type CredentialSlotId,
  type FileSystemId,
} from "@/00-storage/service/hizofs/00-format";
import { decryptAesGcm, encryptAesGcm } from "@/00-storage/service/hizofs/crypto/primitives/aes-gcm";
import { deriveCredentialWrappingKey } from "@/00-storage/service/hizofs/crypto/primitives/pbkdf2";
import { FileSystemRootKey, withFileSystemRootKeyBytes } from "@/00-storage/service/hizofs/crypto/secret-types";
import {
  authenticatedWrappedRootKeyBytes,
  credentialWrapNonce,
  type AuthenticatedWrappedRootKeyBytes,
  type CredentialWrapNonce,
} from "@/00-storage/service/hizofs/crypto/types";

export type PassphraseCredentialParametersV1 = {
  readonly iterations: number;
  readonly nonce: CredentialWrapNonce;
  readonly salt: Uint8Array;
};

function validatePassphraseCredentialParametersV1({ parameters }: {
  parameters: PassphraseCredentialParametersV1;
}): void {
  if (parameters.salt.byteLength !== 16) throw new RangeError("Credential salt must be exactly 16 bytes");
  if (!Number.isInteger(parameters.iterations)
    || parameters.iterations < HIZOFS_V1_FORMAT_CONSTANTS.limits.credentialPbkdf2IterationsMinimum
    || parameters.iterations > HIZOFS_V1_FORMAT_CONSTANTS.limits.credentialPbkdf2IterationsMaximum) {
    throw new RangeError("PBKDF2 iterations are outside the V1 credential bounds");
  }
  credentialWrapNonce({ bytes: parameters.nonce });
}

export function encodePassphraseCredentialParametersV1({ parameters }: {
  parameters: PassphraseCredentialParametersV1;
}): Uint8Array {
  validatePassphraseCredentialParametersV1({ parameters });
  const bytes = new Uint8Array(32);
  bytes.set(parameters.salt, 0);
  new DataView(bytes.buffer).setUint32(16, parameters.iterations, false);
  bytes.set(parameters.nonce, 20);
  return bytes;
}

export function decodePassphraseCredentialParametersV1({ bytes }: {
  bytes: Uint8Array;
}): PassphraseCredentialParametersV1 {
  if (bytes.byteLength !== 32) throw new RangeError("passphrase credential parameters must be exactly 32 bytes");
  const parameters: PassphraseCredentialParametersV1 = {
    iterations: new DataView(bytes.buffer, bytes.byteOffset + 16, 4).getUint32(0, false),
    nonce: credentialWrapNonce({ bytes: bytes.subarray(20, 32) }),
    salt: Uint8Array.from(bytes.subarray(0, 16)),
  };
  validatePassphraseCredentialParametersV1({ parameters });
  return parameters;
}

export async function wrapFileSystemRootKeyForCredentialSlot({
  fileSystemId,
  parameters,
  passphrase,
  rootKey,
  slotId,
}: {
  fileSystemId: FileSystemId;
  parameters: PassphraseCredentialParametersV1;
  passphrase: string;
  rootKey: FileSystemRootKey;
  slotId: CredentialSlotId;
}): Promise<AuthenticatedWrappedRootKeyBytes> {
  const methodParameters = encodePassphraseCredentialParametersV1({ parameters });
  const key = await deriveCredentialWrappingKey({
    fileSystemId,
    iterations: parameters.iterations,
    passphrase,
    salt: parameters.salt,
    slotId,
  });
  const aad = encodePassphraseSlotAad({
    fileSystemId,
    formatVersion: HIZOFS_V1_FORMAT_CONSTANTS.formatVersion,
    method: HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.id,
    methodParameters,
    methodVersion: HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.version,
    slotId,
  });
  return await withFileSystemRootKeyBytes({
    rootKey,
    useBytes: async ({ bytes }) => authenticatedWrappedRootKeyBytes({
      bytes: await encryptAesGcm({ aad, key, nonce: parameters.nonce, plaintext: bytes }),
    }),
  });
}

export async function unwrapFileSystemRootKeyFromCredentialSlot({
  fileSystemId,
  parameters,
  passphrase,
  slotId,
  wrappedRootKey,
}: {
  fileSystemId: FileSystemId;
  parameters: PassphraseCredentialParametersV1;
  passphrase: string;
  slotId: CredentialSlotId;
  wrappedRootKey: AuthenticatedWrappedRootKeyBytes;
}): Promise<FileSystemRootKey> {
  const methodParameters = encodePassphraseCredentialParametersV1({ parameters });
  const key = await deriveCredentialWrappingKey({
    fileSystemId,
    iterations: parameters.iterations,
    passphrase,
    salt: parameters.salt,
    slotId,
  });
  const aad = encodePassphraseSlotAad({
    fileSystemId,
    formatVersion: HIZOFS_V1_FORMAT_CONSTANTS.formatVersion,
    method: HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.id,
    methodParameters,
    methodVersion: HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.version,
    slotId,
  });
  const bytes = await decryptAesGcm({ aad, ciphertextAndTag: wrappedRootKey, key, nonce: parameters.nonce });
  try {
    return FileSystemRootKey.create({ bytes });
  } finally {
    bytes.fill(0);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
