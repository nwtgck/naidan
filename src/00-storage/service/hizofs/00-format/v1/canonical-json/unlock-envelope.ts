import { decodeBase64UrlUnpadded } from '@/00-storage/service/hizofs/00-format/v1/encoding/base64-url';
import { encodeUtf8Strict } from '@/00-storage/service/hizofs/00-format/v1/encoding/utf8';
import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';
import { HIZOFS_V1_JSON_FORMATS } from '@/00-storage/service/hizofs/00-format/v1/json-formats';
import { parseCredentialSlotId, parseFileSystemId, type CredentialSlotId, type FileSystemId } from '@/00-storage/service/hizofs/00-format/v1/identifiers';
import { decodeRestrictedCanonicalJson, encodeCanonicalAsciiString } from './lexical';

const CONSTANTS = HIZOFS_V1_FORMAT_CONSTANTS;
const METHOD_ID = /^[a-z][a-z0-9_]{0,63}$/u;
const ROOT_FIELDS = HIZOFS_V1_JSON_FORMATS.unlockEnvelope.fieldOrder;
const SLOT_FIELDS = HIZOFS_V1_JSON_FORMATS.credentialSlot.fieldOrder;

type JsonObject = Record<string, unknown>;

export type CredentialSlotV1 = {
  readonly method: string;
  readonly methodParameters: string;
  readonly methodVersion: number;
  readonly slotId: CredentialSlotId;
  readonly type: 'credential';
  readonly wrappedFileSystemRootKey: string;
};

export type UnlockEnvelopeUnsignedV1 = {
  readonly authenticatorNonce: string;
  readonly copy: 0 | 1;
  readonly credentialSlots: readonly CredentialSlotV1[];
  readonly fileSystemId: FileSystemId;
  readonly format: 'hizofs-unlock';
  readonly formatVersion: 1;
  readonly sequence: number;
};

export type UnlockEnvelopeV1 = UnlockEnvelopeUnsignedV1 & {
  readonly authenticatorTag: string;
};

export const HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD = {
  id: 'passphrase_pbkdf2_hmac_sha256_aes_256_gcm',
  version: 1,
} as const;

function asStrictObject({ fields, label, value }: { fields: readonly string[]; label: string; value: unknown }): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const object = value as JsonObject;
  const keys = Object.keys(object);
  if (keys.length !== fields.length || keys.some((key, index) => key !== fields[index])) {
    throw new TypeError(`${label} fields are unknown, missing, or out of canonical order`);
  }
  return object;
}

function asCanonicalInteger({ maximum, minimum, value, label }: { maximum: number; minimum: number; value: unknown; label: string }): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < minimum || value > maximum) {
    throw new RangeError(`${label} is outside the canonical integer range`);
  }
  return value;
}

function asString({ label, value }: { label: string; value: unknown }): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
}

function validateCredentialSlot({ slot }: { slot: CredentialSlotV1 }): number {
  if (slot.type !== 'credential') throw new TypeError('Credential Slot type must be credential');
  parseCredentialSlotId({ value: slot.slotId });
  if (!METHOD_ID.test(slot.method)) throw new TypeError('credential method token is invalid');
  asCanonicalInteger({
    label: 'credential method version',
    maximum: CONSTANTS.limits.credentialMethodVersionMaximum,
    minimum: 1,
    value: slot.methodVersion,
  });
  const parametersBytes = decodeBase64UrlUnpadded({
    maximumDecodedBytes: CONSTANTS.limits.credentialMethodParametersBytes,
    value: slot.methodParameters,
  });
  const wrappedBytes = decodeBase64UrlUnpadded({
    maximumDecodedBytes: CONSTANTS.limits.credentialWrappedRootKeyBytes,
    value: slot.wrappedFileSystemRootKey,
  });
  if (slot.method !== HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.id
    || slot.methodVersion !== HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.version) return 0;
  if (parametersBytes.byteLength !== 32 || wrappedBytes.byteLength !== 48) {
    throw new RangeError('known passphrase credential material has an invalid byte length');
  }
  const iterations = new DataView(parametersBytes.buffer, parametersBytes.byteOffset + 16, 4).getUint32(0, false);
  if (
    iterations < CONSTANTS.limits.credentialPbkdf2IterationsMinimum
    || iterations > CONSTANTS.limits.credentialPbkdf2IterationsMaximum
  ) {
    throw new RangeError('PBKDF2 iterations are outside the V1 credential bounds');
  }
  return iterations;
}

function validateCredentialSlots({ slots }: { slots: readonly CredentialSlotV1[] }): void {
  if (slots.length < 1 || slots.length > CONSTANTS.limits.credentialSlots) {
    throw new RangeError('Credential Slot count is outside the V1 bounds');
  }
  let previousSlotId: string | undefined;
  let totalIterations = 0;
  for (const slot of slots) {
    if (previousSlotId !== undefined && previousSlotId >= slot.slotId) {
      throw new TypeError('Credential Slots must be strict ascending by Slot ID');
    }
    previousSlotId = slot.slotId;
    totalIterations += validateCredentialSlot({ slot });
    if (totalIterations > CONSTANTS.limits.credentialUnlockTotalIterations) {
      throw new RangeError('Credential Slot PBKDF2 work exceeds the V1 cumulative bound');
    }
  }
}

function validateUnlockEnvelope({ envelope }: { envelope: UnlockEnvelopeV1 }): void {
  if (envelope.format !== 'hizofs-unlock' || envelope.formatVersion !== 1) {
    throw new TypeError('Unlock Envelope format/version is unsupported');
  }
  asCanonicalInteger({ label: 'Unlock Envelope copy', maximum: 1, minimum: 0, value: envelope.copy });
  asCanonicalInteger({
    label: 'Unlock Envelope sequence',
    maximum: Number.MAX_SAFE_INTEGER,
    minimum: 1,
    value: envelope.sequence,
  });
  parseFileSystemId({ value: envelope.fileSystemId });
  validateCredentialSlots({ slots: envelope.credentialSlots });
  if (decodeBase64UrlUnpadded({ maximumDecodedBytes: 12, value: envelope.authenticatorNonce }).byteLength !== 12) {
    throw new RangeError('unlock authenticator nonce must decode to 12 bytes');
  }
  if (decodeBase64UrlUnpadded({ maximumDecodedBytes: 16, value: envelope.authenticatorTag }).byteLength !== 16) {
    throw new RangeError('unlock authenticator tag must decode to 16 bytes');
  }
}

function parseSlot({ value }: { value: unknown }): CredentialSlotV1 {
  const object = asStrictObject({ fields: SLOT_FIELDS, label: 'Credential Slot', value });
  const slot: CredentialSlotV1 = {
    method: asString({ label: 'credential method', value: object.method }),
    methodParameters: asString({ label: 'credential method parameters', value: object.methodParameters }),
    methodVersion: asCanonicalInteger({
      label: 'credential method version',
      maximum: CONSTANTS.limits.credentialMethodVersionMaximum,
      minimum: 1,
      value: object.methodVersion,
    }),
    slotId: parseCredentialSlotId({ value: asString({ label: 'Credential Slot ID', value: object.slotId }) }),
    type: object.type as 'credential',
    wrappedFileSystemRootKey: asString({ label: 'wrapped File System Root Key', value: object.wrappedFileSystemRootKey }),
  };
  validateCredentialSlot({ slot });
  return slot;
}

function encodeSlot({ slot }: { slot: CredentialSlotV1 }): string {
  return `{${[
    `"type":${encodeCanonicalAsciiString({ value: slot.type })}`,
    `"slotId":${encodeCanonicalAsciiString({ value: slot.slotId })}`,
    `"method":${encodeCanonicalAsciiString({ value: slot.method })}`,
    `"methodVersion":${slot.methodVersion}`,
    `"methodParameters":${encodeCanonicalAsciiString({ value: slot.methodParameters })}`,
    `"wrappedFileSystemRootKey":${encodeCanonicalAsciiString({ value: slot.wrappedFileSystemRootKey })}`,
  ].join(',')}}`;
}

export function encodeUnlockEnvelope({ envelope, includeAuthenticatorTag = true }: { envelope: UnlockEnvelopeV1; includeAuthenticatorTag?: boolean }): Uint8Array {
  validateUnlockEnvelope({ envelope });
  const fields = [
    `"format":${encodeCanonicalAsciiString({ value: envelope.format })}`,
    `"formatVersion":${envelope.formatVersion}`,
    `"copy":${envelope.copy}`,
    `"sequence":${envelope.sequence}`,
    `"fileSystemId":${encodeCanonicalAsciiString({ value: envelope.fileSystemId })}`,
    `"credentialSlots":[${envelope.credentialSlots.map(slot => encodeSlot({ slot })).join(',')}]`,
    `"authenticatorNonce":${encodeCanonicalAsciiString({ value: envelope.authenticatorNonce })}`,
  ];
  if (includeAuthenticatorTag) {
    fields.push(`"authenticatorTag":${encodeCanonicalAsciiString({ value: envelope.authenticatorTag })}`);
  }
  return encodeUtf8Strict({ value: `{${fields.join(',')}}\n` });
}

export function decodeUnlockEnvelope({ bytes }: { bytes: Uint8Array }): UnlockEnvelopeV1 {
  const parsed = decodeRestrictedCanonicalJson({
    bytes,
    maximumBytes: CONSTANTS.limits.unlockEnvelopeJsonBytes,
    maximumDepth: CONSTANTS.limits.controlJsonNestingDepth,
  });
  const object = asStrictObject({ fields: ROOT_FIELDS, label: 'Unlock Envelope', value: parsed });
  if (object.format !== 'hizofs-unlock' || object.formatVersion !== 1) {
    throw new TypeError('Unlock Envelope format/version is unsupported');
  }
  const copy = asCanonicalInteger({ label: 'Unlock Envelope copy', maximum: 1, minimum: 0, value: object.copy }) as 0 | 1;
  const sequence = asCanonicalInteger({ label: 'Unlock Envelope sequence', maximum: Number.MAX_SAFE_INTEGER, minimum: 1, value: object.sequence });
  const fileSystemId = parseFileSystemId({ value: asString({ label: 'File System ID', value: object.fileSystemId }) });
  if (!Array.isArray(object.credentialSlots)) throw new TypeError('Credential Slots must be an array');
  const credentialSlots = object.credentialSlots.map(value => parseSlot({ value }));
  validateCredentialSlots({ slots: credentialSlots });
  const authenticatorNonce = asString({ label: 'unlock authenticator nonce', value: object.authenticatorNonce });
  const authenticatorTag = asString({ label: 'unlock authenticator tag', value: object.authenticatorTag });
  const envelope: UnlockEnvelopeV1 = {
    authenticatorNonce,
    authenticatorTag,
    copy,
    credentialSlots,
    fileSystemId,
    format: 'hizofs-unlock',
    formatVersion: 1,
    sequence,
  };
  const canonical = encodeUnlockEnvelope({ envelope });
  if (canonical.byteLength !== bytes.byteLength || canonical.some((byte, index) => byte !== bytes[index])) {
    throw new TypeError('Unlock Envelope bytes are not canonical');
  }
  return envelope;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
