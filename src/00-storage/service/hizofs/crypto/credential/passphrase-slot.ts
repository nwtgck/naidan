import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD,
  encodePassphraseCredentialParametersV1,
  type PassphraseCredentialParametersV1,
  encodePassphraseSlotAad,
  type CredentialSlotId,
  type FileSystemId,
} from "@/00-storage/service/hizofs/00-format";
import { decryptAesGcm, encryptAesGcm } from "@/00-storage/service/hizofs/crypto/primitives/aes-gcm";
import { deriveCredentialWrappingKey } from "@/00-storage/service/hizofs/crypto/primitives/pbkdf2";
import { FileSystemRootKey, withFileSystemRootKeyBytes } from "@/00-storage/service/hizofs/crypto/secret-types";
import {
  authenticatedWrappedRootKeyBytes,
  type AuthenticatedWrappedRootKeyBytes,
} from "@/00-storage/service/hizofs/crypto/types";

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
