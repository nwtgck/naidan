import { decodeLowercaseHex, encodeLowercaseHex } from './encoding/lowercase-hex';
import { HIZOFS_V1_FORMAT_CONSTANTS } from './format-constants';

const NANO_ID_21 = /^[A-Za-z0-9_-]{21}$/u;
const RANDOM_ID_BYTES = HIZOFS_V1_FORMAT_CONSTANTS.limits.binaryRandomIdBytes;

declare const fileSystemIdBrand: unique symbol;
declare const credentialSlotIdBrand: unique symbol;
declare const segmentIdBrand: unique symbol;
declare const mutationIdBrand: unique symbol;
declare const publicationIdBrand: unique symbol;

export type FileSystemId = string & { readonly [fileSystemIdBrand]: true };
export type CredentialSlotId = string & { readonly [credentialSlotIdBrand]: true };
export type SegmentId = Uint8Array & { readonly [segmentIdBrand]: true };
export type MutationId = Uint8Array & { readonly [mutationIdBrand]: true };
export type PublicationId = Uint8Array & { readonly [publicationIdBrand]: true };

function parseNanoId21({ label, value }: { label: string; value: string }): string {
  if (!NANO_ID_21.test(value)) throw new TypeError(`${label} must use the exact 21-character Nano ID alphabet`);
  return value;
}

function validateRandomId16({ bytes, label }: { bytes: Uint8Array; label: string }): void {
  if (bytes.byteLength !== RANDOM_ID_BYTES) throw new RangeError(`${label} must be exactly ${RANDOM_ID_BYTES} bytes`);
  let hasNonZero = false;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0) {
      hasNonZero = true;
      break;
    }
  }
  if (!hasNonZero) throw new TypeError(`${label} must not be all-zero`);
}

function parseRandomId16<T extends Uint8Array>({ bytes, label }: { bytes: Uint8Array; label: string }): T {
  validateRandomId16({ bytes, label });
  return Uint8Array.from(bytes) as T;
}

export function parseFileSystemId({ value }: { value: string }): FileSystemId {
  return parseNanoId21({ label: 'File System ID', value }) as FileSystemId;
}

export function parseCredentialSlotId({ value }: { value: string }): CredentialSlotId {
  return parseNanoId21({ label: 'Credential Slot ID', value }) as CredentialSlotId;
}

export function parseSegmentId({ bytes }: { bytes: Uint8Array }): SegmentId {
  return parseRandomId16<SegmentId>({ bytes, label: 'Segment ID' });
}

/** Validates an already-owned Segment ID without creating a throwaway copy. */
export function assertSegmentId({ id }: { id: SegmentId }): void {
  validateRandomId16({ bytes: id, label: 'Segment ID' });
}

export function parseMutationId({ bytes }: { bytes: Uint8Array }): MutationId {
  return parseRandomId16<MutationId>({ bytes, label: 'Mutation ID' });
}

export function parsePublicationId({ bytes }: { bytes: Uint8Array }): PublicationId {
  return parseRandomId16<PublicationId>({ bytes, label: 'Publication ID' });
}

export function segmentIdToLowercaseHex({ id }: { id: SegmentId }): string {
  return encodeLowercaseHex({ bytes: id });
}

export function parseSegmentIdLowercaseHex({ value }: { value: string }): SegmentId {
  return parseSegmentId({ bytes: decodeLowercaseHex({ expectedBytes: RANDOM_ID_BYTES, value }) });
}

export function copyBinaryId({ id }: { id: SegmentId | MutationId | PublicationId }): Uint8Array {
  return Uint8Array.from(id);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
