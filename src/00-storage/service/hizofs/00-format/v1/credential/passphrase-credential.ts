import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';

export const HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD = {
  id: 'passphrase_pbkdf2_hmac_sha256_aes_256_gcm',
  iterationsBytes: 4,
  iterationsOffset: 16,
  nonceBytes: HIZOFS_V1_FORMAT_CONSTANTS.crypto.nonceBytes,
  nonceOffset: 20,
  parametersBytes: 32,
  rootKeyBytes: 32,
  saltBytes: 16,
  saltOffset: 0,
  version: 1,
  wrappedRootKeyBytes: 32 + HIZOFS_V1_FORMAT_CONSTANTS.crypto.tagBytes,
} as const;

export type PassphraseCredentialParametersV1 = Readonly<{
  iterations: number;
  nonce: Uint8Array;
  salt: Uint8Array;
}>;

function validatePassphraseCredentialParametersV1({ parameters }: {
  parameters: PassphraseCredentialParametersV1;
}): void {
  if (parameters.salt.byteLength !== HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.saltBytes) {
    throw new RangeError(`Credential salt must be exactly ${HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.saltBytes} bytes`);
  }
  if (!Number.isInteger(parameters.iterations)
    || parameters.iterations < HIZOFS_V1_FORMAT_CONSTANTS.limits.credentialPbkdf2IterationsMinimum
    || parameters.iterations > HIZOFS_V1_FORMAT_CONSTANTS.limits.credentialPbkdf2IterationsMaximum) {
    throw new RangeError('PBKDF2 iterations are outside the V1 credential bounds');
  }
  if (parameters.nonce.byteLength !== HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.nonceBytes) {
    throw new RangeError(`Credential wrapping nonce must be exactly ${HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.nonceBytes} bytes`);
  }
}

export function encodePassphraseCredentialParametersV1({ parameters }: {
  parameters: PassphraseCredentialParametersV1;
}): Uint8Array {
  validatePassphraseCredentialParametersV1({ parameters });
  const bytes = new Uint8Array(HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.parametersBytes);
  bytes.set(parameters.salt, HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.saltOffset);
  new DataView(bytes.buffer).setUint32(
    HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.iterationsOffset,
    parameters.iterations,
    false,
  );
  bytes.set(parameters.nonce, HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.nonceOffset);
  return bytes;
}

export function decodePassphraseCredentialParametersV1({ bytes }: {
  bytes: Uint8Array;
}): PassphraseCredentialParametersV1 {
  if (bytes.byteLength !== HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.parametersBytes) {
    throw new RangeError(
      `passphrase credential parameters must be exactly ${HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.parametersBytes} bytes`,
    );
  }
  const parameters: PassphraseCredentialParametersV1 = {
    iterations: new DataView(
      bytes.buffer,
      bytes.byteOffset + HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.iterationsOffset,
      HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.iterationsBytes,
    ).getUint32(0, false),
    nonce: Uint8Array.from(bytes.subarray(
      HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.nonceOffset,
      HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.nonceOffset + HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.nonceBytes,
    )),
    salt: Uint8Array.from(bytes.subarray(
      HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.saltOffset,
      HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.saltOffset + HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.saltBytes,
    )),
  };
  validatePassphraseCredentialParametersV1({ parameters });
  return parameters;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
