import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD,
} from '@/00-storage/service/hizofs/00-format';

declare const plaintextRecordBytesBrand: unique symbol;
declare const authenticatedRecordBytesBrand: unique symbol;
declare const plaintextSuperblockBytesBrand: unique symbol;
declare const authenticatedSuperblockBytesBrand: unique symbol;
declare const plaintextSegmentHeaderBytesBrand: unique symbol;
declare const authenticatedSegmentHeaderBytesBrand: unique symbol;
declare const plaintextSegmentFooterBytesBrand: unique symbol;
declare const authenticatedSegmentFooterBytesBrand: unique symbol;
declare const wrappedRootKeyBytesBrand: unique symbol;
declare const recordNonceBrand: unique symbol;
declare const superblockNonceBrand: unique symbol;
declare const segmentFooterNonceBrand: unique symbol;
declare const unlockAuthenticatorNonceBrand: unique symbol;
declare const credentialWrapNonceBrand: unique symbol;
declare const unlockAuthenticatorTagBrand: unique symbol;

export type PlaintextRecordBytes = Uint8Array & { readonly [plaintextRecordBytesBrand]: true };
export type AuthenticatedRecordBytes = Uint8Array & { readonly [authenticatedRecordBytesBrand]: true };
export type PlaintextSuperblockBytes = Uint8Array & { readonly [plaintextSuperblockBytesBrand]: true };
export type AuthenticatedSuperblockBytes = Uint8Array & { readonly [authenticatedSuperblockBytesBrand]: true };
export type PlaintextSegmentHeaderBytes = Uint8Array & { readonly [plaintextSegmentHeaderBytesBrand]: true };
export type AuthenticatedSegmentHeaderBytes = Uint8Array & { readonly [authenticatedSegmentHeaderBytesBrand]: true };
export type PlaintextSegmentFooterBytes = Uint8Array & { readonly [plaintextSegmentFooterBytesBrand]: true };
export type AuthenticatedSegmentFooterBytes = Uint8Array & { readonly [authenticatedSegmentFooterBytesBrand]: true };
export type AuthenticatedWrappedRootKeyBytes = Uint8Array & { readonly [wrappedRootKeyBytesBrand]: true };
export type RecordNonce = Uint8Array & { readonly [recordNonceBrand]: true };
export type SuperblockNonce = Uint8Array & { readonly [superblockNonceBrand]: true };
export type SegmentFooterNonce = Uint8Array & { readonly [segmentFooterNonceBrand]: true };
export type UnlockAuthenticatorNonce = Uint8Array & { readonly [unlockAuthenticatorNonceBrand]: true };
export type CredentialWrapNonce = Uint8Array & { readonly [credentialWrapNonceBrand]: true };
export type UnlockAuthenticatorTag = Uint8Array & { readonly [unlockAuthenticatorTagBrand]: true };

function copyBytes<T extends Uint8Array>({ bytes }: { bytes: Uint8Array }): T {
  return Uint8Array.from(bytes) as T;
}

function copyNonce<T extends Uint8Array>({ bytes, label }: { bytes: Uint8Array; label: string }): T {
  if (bytes.byteLength !== HIZOFS_V1_FORMAT_CONSTANTS.crypto.nonceBytes) {
    throw new RangeError(`${label} must be exactly ${HIZOFS_V1_FORMAT_CONSTANTS.crypto.nonceBytes} bytes`);
  }
  return copyBytes<T>({ bytes });
}

export function plaintextRecordBytes({ bytes }: { bytes: Uint8Array }): PlaintextRecordBytes {
  return copyBytes<PlaintextRecordBytes>({ bytes });
}
export function authenticatedRecordBytes({ bytes }: { bytes: Uint8Array }): AuthenticatedRecordBytes {
  return copyBytes<AuthenticatedRecordBytes>({ bytes });
}
export function plaintextSuperblockBytes({ bytes }: { bytes: Uint8Array }): PlaintextSuperblockBytes {
  return copyBytes<PlaintextSuperblockBytes>({ bytes });
}
export function authenticatedSuperblockBytes({ bytes }: { bytes: Uint8Array }): AuthenticatedSuperblockBytes {
  return copyBytes<AuthenticatedSuperblockBytes>({ bytes });
}
export function plaintextSegmentHeaderBytes({ bytes }: { bytes: Uint8Array }): PlaintextSegmentHeaderBytes {
  return copyBytes<PlaintextSegmentHeaderBytes>({ bytes });
}
export function authenticatedSegmentHeaderBytes({ bytes }: { bytes: Uint8Array }): AuthenticatedSegmentHeaderBytes {
  return copyBytes<AuthenticatedSegmentHeaderBytes>({ bytes });
}
export function plaintextSegmentFooterBytes({ bytes }: { bytes: Uint8Array }): PlaintextSegmentFooterBytes {
  return copyBytes<PlaintextSegmentFooterBytes>({ bytes });
}
export function authenticatedSegmentFooterBytes({ bytes }: { bytes: Uint8Array }): AuthenticatedSegmentFooterBytes {
  return copyBytes<AuthenticatedSegmentFooterBytes>({ bytes });
}
export function authenticatedWrappedRootKeyBytes({ bytes }: { bytes: Uint8Array }): AuthenticatedWrappedRootKeyBytes {
  if (bytes.byteLength !== HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.wrappedRootKeyBytes) {
    throw new RangeError('wrapped File System Root Key must contain exactly 32 ciphertext bytes and one authentication tag');
  }
  return copyBytes<AuthenticatedWrappedRootKeyBytes>({ bytes });
}
export function recordNonce({ bytes }: { bytes: Uint8Array }): RecordNonce {
  return copyNonce<RecordNonce>({ bytes, label: 'Record nonce' });
}
export function superblockNonce({ bytes }: { bytes: Uint8Array }): SuperblockNonce {
  return copyNonce<SuperblockNonce>({ bytes, label: 'Superblock nonce' });
}
export function segmentFooterNonce({ bytes }: { bytes: Uint8Array }): SegmentFooterNonce {
  return copyNonce<SegmentFooterNonce>({ bytes, label: 'Segment Footer nonce' });
}
export function unlockAuthenticatorNonce({ bytes }: { bytes: Uint8Array }): UnlockAuthenticatorNonce {
  return copyNonce<UnlockAuthenticatorNonce>({ bytes, label: 'Unlock Authenticator nonce' });
}
export function credentialWrapNonce({ bytes }: { bytes: Uint8Array }): CredentialWrapNonce {
  return copyNonce<CredentialWrapNonce>({ bytes, label: 'Credential wrapping nonce' });
}

export function unlockAuthenticatorTag({ bytes }: { bytes: Uint8Array }): UnlockAuthenticatorTag {
  if (bytes.byteLength !== HIZOFS_V1_FORMAT_CONSTANTS.crypto.tagBytes) {
    throw new RangeError('Unlock Authenticator tag must have the exact V1 tag length');
  }
  return copyBytes<UnlockAuthenticatorTag>({ bytes });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
