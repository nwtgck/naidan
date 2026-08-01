import {
  decodePersistenceControlBase64Url,
  decodePersistenceControlCanonicalJson,
  encodePersistenceControlAsciiString,
  encodePersistenceControlBase64Url,
  encodePersistenceControlUtf8,
  parsePortableFileSystemId,
  type FileSystemId,
} from '@/00-storage/service/hizofs/compatibility';
import {
  encodePersistenceEndpoint,
  parsePersistenceEndpoint,
  parseTransitionOperationId,
  type NaidanPersistenceEndpointV1,
  type TransitionOperationId,
} from '@/00-storage/service/naidan-persistence-control/00-format/canonical-json/persistence-control';
import { NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS } from '@/00-storage/service/naidan-persistence-control/00-format/transition-progress-format-constants';
import { NAIDAN_TRANSITION_PROGRESS_JSON_FORMATS } from '@/00-storage/service/naidan-persistence-control/00-format/transition-progress-json-formats';

const CONSTANTS = NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS;
const FORMATS = NAIDAN_TRANSITION_PROGRESS_JSON_FORMATS;
const UINT64_MAXIMUM = (1n << 64n) - 1n;
type JsonObject = Record<string, unknown>;

export type TransitionProgressCopy = 0 | 1;
export type TransitionProgressProviderCheckpointState = 'active' | 'sealed';
export type TransitionProgressProviderCheckpointCodec =
  typeof CONSTANTS.providerCheckpointCodecs[keyof typeof CONSTANTS.providerCheckpointCodecs];

export type TransitionProgressPayloadV1 = Readonly<{
  journalGeneration: bigint;
  portableProgressBytes: Uint8Array;
  providerCheckpointBytes: Uint8Array;
  providerCheckpointCodec: TransitionProgressProviderCheckpointCodec;
  providerCheckpointState: TransitionProgressProviderCheckpointState;
  sourceAuthorityIdentity: string;
  sourceEndpoint: NaidanPersistenceEndpointV1;
  targetAuthorityIdentity: string;
  targetEndpoint: NaidanPersistenceEndpointV1;
}>;

export type NaidanTransitionProgressEnvelopeV1 = Readonly<{
  authenticationFileSystemId: FileSystemId;
  ciphertext: string;
  copy: TransitionProgressCopy;
  format: 'naidan-transition-progress';
  formatVersion: 1;
  nonce: string;
  operationId: TransitionOperationId;
  providerKind: 'hizofs';
  sequence: number;
}>;

export type NaidanUnsignedTransitionProgressEnvelopeV1 = Omit<NaidanTransitionProgressEnvelopeV1, 'ciphertext'>;

function strictObject({ fields, label, value }: { fields: readonly string[]; label: string; value: unknown }): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const object = value as JsonObject;
  const keys = Object.keys(object);
  if (keys.length !== fields.length || keys.some((key, index) => key !== fields[index])) {
    throw new TypeError(`${label} fields are unknown, missing, or out of canonical order`);
  }
  return object;
}

function stringValue({ label, value }: { label: string; value: unknown }): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
}

function exactLiteral<T extends number | string>({ expected, label, value }: {
  expected: T;
  label: string;
  value: unknown;
}): T {
  if (value !== expected) throw new TypeError(`${label} is unsupported`);
  return expected;
}

function canonicalInteger({ label, maximum, minimum, value }: {
  label: string;
  maximum: number;
  minimum: number;
  value: unknown;
}): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} is outside the canonical integer range`);
  }
  return value;
}

function validateAuthorityIdentity({ label, value }: { label: string; value: string }): string {
  if (value.length === 0 || value.length > CONSTANTS.limits.authorityIdentityCharacters) {
    throw new RangeError(`${label} length is outside the transition-progress bound`);
  }
  encodePersistenceControlAsciiString({ value });
  return value;
}

function parseJournalGeneration({ value }: { value: unknown }): bigint {
  const text = stringValue({ label: 'transition journal generation', value });
  if (!/^(0|[1-9][0-9]*)$/u.test(text)) throw new TypeError('transition journal generation is not canonical unsigned decimal');
  const generation = BigInt(text);
  if (generation > UINT64_MAXIMUM) throw new RangeError('transition journal generation exceeds UInt64');
  return generation;
}

export function transitionProgressAuthenticationFileSystemId({ sourceEndpoint, targetEndpoint }: {
  sourceEndpoint: NaidanPersistenceEndpointV1;
  targetEndpoint: NaidanPersistenceEndpointV1;
}): FileSystemId {
  switch (targetEndpoint.type) {
  case 'hizofs': return targetEndpoint.fileSystemId;
  case 'plain':
    switch (sourceEndpoint.type) {
    case 'hizofs': return sourceEndpoint.fileSystemId;
    case 'plain': throw new TypeError('transition-progress companion requires one HizoFS endpoint');
    default: return sourceEndpoint satisfies never;
    }
  default: return targetEndpoint satisfies never;
  }
}

function validatePayload({ payload }: { payload: TransitionProgressPayloadV1 }): void {
  validateAuthorityIdentity({ label: 'source authority identity', value: payload.sourceAuthorityIdentity });
  validateAuthorityIdentity({ label: 'target authority identity', value: payload.targetAuthorityIdentity });
  encodePersistenceEndpoint({ endpoint: payload.sourceEndpoint });
  encodePersistenceEndpoint({ endpoint: payload.targetEndpoint });
  if (payload.journalGeneration < 0n || payload.journalGeneration > UINT64_MAXIMUM) {
    throw new RangeError('transition journal generation exceeds UInt64');
  }
  if (payload.portableProgressBytes.byteLength > CONSTANTS.limits.portableProgressBytes) {
    throw new RangeError('portable transition progress exceeds its byte bound');
  }
  if (payload.providerCheckpointBytes.byteLength > CONSTANTS.limits.providerCheckpointBytes) {
    throw new RangeError('provider checkpoint exceeds its byte bound');
  }
  switch (payload.providerCheckpointCodec) {
  case CONSTANTS.providerCheckpointCodecs.hizofs:
  case CONSTANTS.providerCheckpointCodecs.nativePlain: break;
  default: {
    const unhandled: never = payload.providerCheckpointCodec;
    throw new TypeError(`provider checkpoint codec is unsupported: ${String(unhandled)}`);
  }
  }
  switch (payload.providerCheckpointState) {
  case 'active':
  case 'sealed': return;
  default: {
    const unhandled: never = payload.providerCheckpointState;
    throw new TypeError(`provider checkpoint state is unsupported: ${String(unhandled)}`);
  }
  }
}

function validateUnsignedEnvelope({ envelope }: { envelope: NaidanUnsignedTransitionProgressEnvelopeV1 }): void {
  if (envelope.format !== CONSTANTS.format || envelope.formatVersion !== CONSTANTS.formatVersion) {
    throw new TypeError('transition-progress format/version is unsupported');
  }
  canonicalInteger({ label: 'transition-progress copy', maximum: 1, minimum: 0, value: envelope.copy });
  canonicalInteger({ label: 'transition-progress sequence', maximum: Number.MAX_SAFE_INTEGER, minimum: CONSTANTS.sequenceMinimum, value: envelope.sequence });
  parseTransitionOperationId({ value: envelope.operationId });
  if (envelope.providerKind !== CONSTANTS.providerKind) throw new TypeError('transition-progress provider kind is unsupported');
  parsePortableFileSystemId({ value: envelope.authenticationFileSystemId });
  if (decodePersistenceControlBase64Url({ maximumDecodedBytes: CONSTANTS.crypto.nonceBytes, value: envelope.nonce }).byteLength !== CONSTANTS.crypto.nonceBytes) {
    throw new RangeError('transition-progress nonce must decode to 12 bytes');
  }
}

function unsignedEnvelopeFields({ envelope }: { envelope: NaidanUnsignedTransitionProgressEnvelopeV1 }): readonly string[] {
  validateUnsignedEnvelope({ envelope });
  return [
    `"format":"${CONSTANTS.format}"`,
    `"formatVersion":${CONSTANTS.formatVersion}`,
    `"copy":${envelope.copy}`,
    `"sequence":${envelope.sequence}`,
    `"operationId":${encodePersistenceControlAsciiString({ value: envelope.operationId })}`,
    `"providerKind":"${CONSTANTS.providerKind}"`,
    `"authenticationFileSystemId":${encodePersistenceControlAsciiString({ value: envelope.authenticationFileSystemId })}`,
    `"nonce":${encodePersistenceControlAsciiString({ value: envelope.nonce })}`,
  ];
}

export function encodeTransitionProgressPlaintext({ payload }: { payload: TransitionProgressPayloadV1 }): Uint8Array {
  validatePayload({ payload });
  const fields = [
    `"sourceAuthorityIdentity":${encodePersistenceControlAsciiString({ value: payload.sourceAuthorityIdentity })}`,
    `"sourceEndpoint":${encodePersistenceEndpoint({ endpoint: payload.sourceEndpoint })}`,
    `"targetAuthorityIdentity":${encodePersistenceControlAsciiString({ value: payload.targetAuthorityIdentity })}`,
    `"targetEndpoint":${encodePersistenceEndpoint({ endpoint: payload.targetEndpoint })}`,
    `"journalGeneration":${encodePersistenceControlAsciiString({ value: payload.journalGeneration.toString(10) })}`,
    `"portableProgressCodec":"${CONSTANTS.portableProgressCodec}"`,
    `"portableProgressBytes":${encodePersistenceControlAsciiString({ value: encodePersistenceControlBase64Url({ bytes: payload.portableProgressBytes }) })}`,
    `"providerCheckpointCodec":${encodePersistenceControlAsciiString({ value: payload.providerCheckpointCodec })}`,
    `"providerCheckpointState":${encodePersistenceControlAsciiString({ value: payload.providerCheckpointState })}`,
    `"providerCheckpointBytes":${encodePersistenceControlAsciiString({ value: encodePersistenceControlBase64Url({ bytes: payload.providerCheckpointBytes }) })}`,
  ];
  const encoded = encodePersistenceControlUtf8({ value: `{${fields.join(',')}}
` });
  if (encoded.byteLength > CONSTANTS.limits.plaintextJsonBytes) throw new RangeError('transition-progress plaintext exceeds its byte bound');
  return encoded;
}

export function decodeTransitionProgressPlaintext({ bytes }: { bytes: Uint8Array }): TransitionProgressPayloadV1 {
  const parsed = decodePersistenceControlCanonicalJson({
    bytes,
    maximumBytes: CONSTANTS.limits.plaintextJsonBytes,
    maximumDepth: CONSTANTS.limits.canonicalJsonDepth,
  });
  const object = strictObject({ fields: FORMATS.plaintext.fieldOrder, label: 'transition-progress plaintext', value: parsed });
  if (object.portableProgressCodec !== CONSTANTS.portableProgressCodec) throw new TypeError('portable transition progress codec is unsupported');
  const providerCheckpointCodec = stringValue({ label: 'provider checkpoint codec', value: object.providerCheckpointCodec });
  if (providerCheckpointCodec !== CONSTANTS.providerCheckpointCodecs.hizofs
    && providerCheckpointCodec !== CONSTANTS.providerCheckpointCodecs.nativePlain) {
    throw new TypeError('provider checkpoint codec is unsupported');
  }
  const providerCheckpointState = stringValue({ label: 'provider checkpoint state', value: object.providerCheckpointState });
  if (providerCheckpointState !== 'active' && providerCheckpointState !== 'sealed') throw new TypeError('provider checkpoint state is unsupported');
  const payload: TransitionProgressPayloadV1 = {
    journalGeneration: parseJournalGeneration({ value: object.journalGeneration }),
    portableProgressBytes: decodePersistenceControlBase64Url({
      maximumDecodedBytes: CONSTANTS.limits.portableProgressBytes,
      value: stringValue({ label: 'portable transition progress bytes', value: object.portableProgressBytes }),
    }),
    providerCheckpointBytes: decodePersistenceControlBase64Url({
      maximumDecodedBytes: CONSTANTS.limits.providerCheckpointBytes,
      value: stringValue({ label: 'provider checkpoint bytes', value: object.providerCheckpointBytes }),
    }),
    providerCheckpointCodec,
    providerCheckpointState,
    sourceAuthorityIdentity: validateAuthorityIdentity({
      label: 'source authority identity',
      value: stringValue({ label: 'source authority identity', value: object.sourceAuthorityIdentity }),
    }),
    sourceEndpoint: parsePersistenceEndpoint({ value: object.sourceEndpoint }),
    targetAuthorityIdentity: validateAuthorityIdentity({
      label: 'target authority identity',
      value: stringValue({ label: 'target authority identity', value: object.targetAuthorityIdentity }),
    }),
    targetEndpoint: parsePersistenceEndpoint({ value: object.targetEndpoint }),
  };
  validatePayload({ payload });
  return payload;
}

export function encodeUnsignedTransitionProgressEnvelope({ envelope }: {
  envelope: NaidanUnsignedTransitionProgressEnvelopeV1;
}): Uint8Array {
  return encodePersistenceControlUtf8({ value: `{${unsignedEnvelopeFields({ envelope }).join(',')}}
` });
}

export function encodeTransitionProgressEnvelope({ envelope }: { envelope: NaidanTransitionProgressEnvelopeV1 }): Uint8Array {
  const { ciphertext, ...unsigned } = envelope;
  const ciphertextBytes = decodePersistenceControlBase64Url({
    maximumDecodedBytes: CONSTANTS.limits.plaintextJsonBytes + CONSTANTS.crypto.tagBytes,
    value: ciphertext,
  });
  if (ciphertextBytes.byteLength < CONSTANTS.crypto.tagBytes) throw new RangeError('transition-progress ciphertext is shorter than its authentication tag');
  const encoded = encodePersistenceControlUtf8({
    value: `{${[...unsignedEnvelopeFields({ envelope: unsigned }), `"ciphertext":${encodePersistenceControlAsciiString({ value: ciphertext })}`].join(',')}}
`,
  });
  if (encoded.byteLength > CONSTANTS.limits.companionJsonBytes) throw new RangeError('transition-progress companion exceeds its byte bound');
  return encoded;
}

export function decodeTransitionProgressEnvelope({ bytes }: { bytes: Uint8Array }): NaidanTransitionProgressEnvelopeV1 {
  const parsed = decodePersistenceControlCanonicalJson({
    bytes,
    maximumBytes: CONSTANTS.limits.companionJsonBytes,
    maximumDepth: CONSTANTS.limits.canonicalJsonDepth,
  });
  const object = strictObject({ fields: FORMATS.envelope.fieldOrder, label: 'transition-progress envelope', value: parsed });
  const envelope: NaidanTransitionProgressEnvelopeV1 = {
    authenticationFileSystemId: parsePortableFileSystemId({ value: stringValue({ label: 'authentication File System ID', value: object.authenticationFileSystemId }) }),
    ciphertext: stringValue({ label: 'transition-progress ciphertext', value: object.ciphertext }),
    copy: canonicalInteger({ label: 'transition-progress copy', maximum: 1, minimum: 0, value: object.copy }) as TransitionProgressCopy,
    format: exactLiteral({ expected: CONSTANTS.format, label: 'transition-progress format', value: object.format }),
    formatVersion: exactLiteral({ expected: CONSTANTS.formatVersion, label: 'transition-progress version', value: object.formatVersion }),
    nonce: stringValue({ label: 'transition-progress nonce', value: object.nonce }),
    operationId: parseTransitionOperationId({ value: stringValue({ label: 'Transition Operation ID', value: object.operationId }) }),
    providerKind: exactLiteral({ expected: CONSTANTS.providerKind, label: 'transition-progress provider kind', value: object.providerKind }),
    sequence: canonicalInteger({ label: 'transition-progress sequence', maximum: Number.MAX_SAFE_INTEGER, minimum: CONSTANTS.sequenceMinimum, value: object.sequence }),
  };
  encodeTransitionProgressEnvelope({ envelope });
  return envelope;
}

export const TEST_ONLY = {
  UINT64_MAXIMUM,
  validatePayload,
};
