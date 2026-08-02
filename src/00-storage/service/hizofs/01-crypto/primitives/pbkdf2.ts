import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  encodePassphraseSlotKdfContext,
  encodePassphraseUtf8,
  parseCredentialSlotId,
  parseFileSystemId,
  type CredentialSlotId,
  type FileSystemId,
} from '@/00-storage/service/hizofs/00-format';

export async function deriveCredentialWrappingKey({
  fileSystemId,
  iterations,
  passphrase,
  salt,
  slotId,
}: {
  fileSystemId: FileSystemId;
  iterations: number;
  passphrase: string;
  salt: Uint8Array;
  slotId: CredentialSlotId;
}): Promise<CryptoKey> {
  parseFileSystemId({ value: fileSystemId });
  parseCredentialSlotId({ value: slotId });
  if (salt.byteLength !== 16) throw new RangeError('PBKDF2 credential salt must be exactly 16 bytes');
  if (!Number.isInteger(iterations)
    || iterations < HIZOFS_V1_FORMAT_CONSTANTS.limits.credentialPbkdf2IterationsMinimum
    || iterations > HIZOFS_V1_FORMAT_CONSTANTS.limits.credentialPbkdf2IterationsMaximum) {
    throw new RangeError('PBKDF2 iterations are outside the V1 credential bounds');
  }
  const passphraseBytes = encodePassphraseUtf8({ value: passphrase });
  const kdfSalt = encodePassphraseSlotKdfContext({ fileSystemId, salt, slotId });
  try {
    const baseKey = await globalThis.crypto.subtle.importKey(
      'raw',
      Uint8Array.from(passphraseBytes).buffer,
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return await globalThis.crypto.subtle.deriveKey(
      { hash: 'SHA-256', iterations, name: 'PBKDF2', salt: Uint8Array.from(kdfSalt).buffer },
      baseKey,
      { length: 256, name: 'AES-GCM' },
      false,
      ['decrypt', 'encrypt'],
    );
  } finally {
    passphraseBytes.fill(0);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
