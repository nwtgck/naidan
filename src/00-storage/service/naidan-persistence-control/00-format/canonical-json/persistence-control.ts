import {
  decodePersistenceControlBase64Url,
  decodePersistenceControlCanonicalJson,
  encodePersistenceControlAsciiString,
  encodePersistenceControlUtf8,
  parsePortableFileSystemId,
  type FileSystemId,
} from '@/00-storage/service/hizofs/compatibility';
import { NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS } from '@/00-storage/service/naidan-persistence-control/00-format/format-constants';
import { NAIDAN_PERSISTENCE_CONTROL_JSON_FORMATS } from '@/00-storage/service/naidan-persistence-control/00-format/json-formats';

const CONSTANTS = NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS;
const FORMATS = NAIDAN_PERSISTENCE_CONTROL_JSON_FORMATS;
const NANO_ID_21 = /^[A-Za-z0-9_-]{21}$/u;

declare const transitionOperationIdBrand: unique symbol;
export type TransitionOperationId = string & { readonly [transitionOperationIdBrand]: true };
type JsonObject = Record<string, unknown>;

export type NaidanPersistenceEndpointV1 =
  | { readonly type: 'plain' }
  | { readonly fileSystemId: FileSystemId; readonly type: 'hizofs' };
export type NaidanTransitionOperationV1 = 'decrypt' | 'encrypt' | 're_encrypt';
export type NaidanTransitionPhaseV1 = {
  readonly source: NaidanPersistenceEndpointV1;
  readonly target: NaidanPersistenceEndpointV1;
  readonly type: 'building_target' | 'cleaning_up_source';
};
export type NaidanPersistenceModeV1 =
  | { readonly type: 'plain' }
  | { readonly activeFileSystemId: FileSystemId; readonly type: 'hizofs' }
  | {
      readonly operation: NaidanTransitionOperationV1;
      readonly operationId: TransitionOperationId;
      readonly phase: NaidanTransitionPhaseV1;
      readonly type: 'transitioning';
    };
export type NaidanControlProtectionV1 =
  | { readonly digest: string; readonly type: 'plain_sha256' }
  | {
      readonly authenticationFileSystemId: FileSystemId;
      readonly authenticatorTag: string;
      readonly nonce: string;
      readonly type: 'hizofs_aes_256_gcm';
    };
export type NaidanPersistenceControlCoreV1 = {
  readonly copy: 0 | 1;
  readonly format: 'naidan-persistence-control';
  readonly formatVersion: 1;
  readonly mode: NaidanPersistenceModeV1;
  readonly retiredFileSystemIds: readonly FileSystemId[];
  readonly sequence: number;
};
export type NaidanPersistenceControlV1 = NaidanPersistenceControlCoreV1 & {
  readonly protection: NaidanControlProtectionV1;
};

export type NaidanPersistenceControlUnsignedProtectedV1 = NaidanPersistenceControlCoreV1 & {
  readonly protection: {
    readonly authenticationFileSystemId: FileSystemId;
    readonly nonce: string;
    readonly type: 'hizofs_aes_256_gcm';
  };
};

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

function canonicalInteger({ label, maximum, minimum, value }: { label: string; maximum: number; minimum: number; value: unknown }): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} is outside the canonical integer range`);
  }
  return value;
}

export function parseTransitionOperationId({ value }: { value: string }): TransitionOperationId {
  if (!NANO_ID_21.test(value)) throw new TypeError('Transition Operation ID must be a 21-character Nano ID');
  return value as TransitionOperationId;
}

export function parsePersistenceEndpoint({ value }: { value: unknown }): NaidanPersistenceEndpointV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('persistence endpoint must be an object');
  const type = (value as JsonObject).type;
  if (type === 'plain') {
    strictObject({ fields: FORMATS.persistenceEndpointPlain.fieldOrder, label: 'plain endpoint', value });
    return { type: 'plain' };
  }
  if (type === 'hizofs') {
    const object = strictObject({ fields: FORMATS.persistenceEndpointHizoFS.fieldOrder, label: 'HizoFS endpoint', value });
    return {
      fileSystemId: parsePortableFileSystemId({ value: stringValue({ label: 'File System ID', value: object.fileSystemId }) }),
      type: 'hizofs',
    };
  }
  throw new TypeError('persistence endpoint type is unsupported');
}

function parsePhase({ value }: { value: unknown }): NaidanTransitionPhaseV1 {
  const object = strictObject({ fields: FORMATS.transitionPhase.fieldOrder, label: 'transition phase', value });
  if (object.type !== 'building_target' && object.type !== 'cleaning_up_source') throw new TypeError('transition phase type is unsupported');
  return { source: parsePersistenceEndpoint({ value: object.source }), target: parsePersistenceEndpoint({ value: object.target }), type: object.type };
}

function parseMode({ value }: { value: unknown }): NaidanPersistenceModeV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('persistence mode must be an object');
  const type = (value as JsonObject).type;
  if (type === 'plain') {
    strictObject({ fields: FORMATS.persistenceModePlain.fieldOrder, label: 'plain mode', value });
    return { type: 'plain' };
  }
  if (type === 'hizofs') {
    const object = strictObject({ fields: FORMATS.persistenceModeHizoFS.fieldOrder, label: 'HizoFS mode', value });
    return {
      activeFileSystemId: parsePortableFileSystemId({ value: stringValue({ label: 'active File System ID', value: object.activeFileSystemId }) }),
      type: 'hizofs',
    };
  }
  if (type === 'transitioning') {
    const object = strictObject({ fields: FORMATS.persistenceModeTransitioning.fieldOrder, label: 'transitioning mode', value });
    const operation = object.operation;
    if (operation !== 'encrypt' && operation !== 'decrypt' && operation !== 're_encrypt') throw new TypeError('transition operation is unsupported');
    return {
      operation,
      operationId: parseTransitionOperationId({ value: stringValue({ label: 'Transition Operation ID', value: object.operationId }) }),
      phase: parsePhase({ value: object.phase }),
      type: 'transitioning',
    };
  }
  throw new TypeError('persistence mode type is unsupported');
}

function parseProtection({ value }: { value: unknown }): NaidanControlProtectionV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('control protection must be an object');
  const type = (value as JsonObject).type;
  if (type === 'plain_sha256') {
    const object = strictObject({ fields: FORMATS.plainControlProtection.fieldOrder, label: 'plain control protection', value });
    const digest = stringValue({ label: 'plain control digest', value: object.digest });
    if (decodePersistenceControlBase64Url({ maximumDecodedBytes: 32, value: digest }).byteLength !== 32) throw new RangeError('plain control digest must decode to 32 bytes');
    return { digest, type };
  }
  if (type === 'hizofs_aes_256_gcm') {
    const object = strictObject({ fields: FORMATS.hizoFSControlProtection.fieldOrder, label: 'HizoFS control protection', value });
    const nonce = stringValue({ label: 'control nonce', value: object.nonce });
    const authenticatorTag = stringValue({ label: 'control authenticator tag', value: object.authenticatorTag });
    if (decodePersistenceControlBase64Url({ maximumDecodedBytes: 12, value: nonce }).byteLength !== 12) throw new RangeError('control nonce must decode to 12 bytes');
    if (decodePersistenceControlBase64Url({ maximumDecodedBytes: 16, value: authenticatorTag }).byteLength !== 16) throw new RangeError('control authenticator tag must decode to 16 bytes');
    return {
      authenticationFileSystemId: parsePortableFileSystemId({ value: stringValue({ label: 'authentication File System ID', value: object.authenticationFileSystemId }) }),
      authenticatorTag,
      nonce,
      type,
    };
  }
  throw new TypeError('control protection type is unsupported');
}

function endpointId({ endpoint }: { endpoint: NaidanPersistenceEndpointV1 }): FileSystemId | undefined {
  switch (endpoint.type) {
  case 'plain': return undefined;
  case 'hizofs': return endpoint.fileSystemId;
  default: {
    const unhandled: never = endpoint;
    throw new Error(`unhandled persistence endpoint: ${String(unhandled)}`);
  }
  }
}

export function persistenceControlAuthenticationFileSystemId({ mode }: { mode: NaidanPersistenceModeV1 }): FileSystemId | undefined {
  switch (mode.type) {
  case 'plain': return undefined;
  case 'hizofs': return mode.activeFileSystemId;
  case 'transitioning': {
    const { operation, phase } = mode;
    switch (operation) {
    case 'encrypt':
      if (phase.source.type !== 'plain' || phase.target.type !== 'hizofs') throw new TypeError('encrypt transition must be plain to HizoFS');
      return phase.target.fileSystemId;
    case 'decrypt':
      if (phase.source.type !== 'hizofs' || phase.target.type !== 'plain') throw new TypeError('decrypt transition must be HizoFS to plain');
      return phase.source.fileSystemId;
    case 're_encrypt':
      if (phase.source.type !== 'hizofs' || phase.target.type !== 'hizofs' || phase.source.fileSystemId === phase.target.fileSystemId) {
        throw new TypeError('re-encrypt transition must use distinct HizoFS endpoints');
      }
      switch (phase.type) {
      case 'building_target': return phase.source.fileSystemId;
      case 'cleaning_up_source': return phase.target.fileSystemId;
      default: {
        const unhandled: never = phase.type;
        throw new Error(`unhandled transition phase: ${String(unhandled)}`);
      }
      }
    default: {
      const unhandled: never = operation;
      throw new Error(`unhandled transition operation: ${String(unhandled)}`);
    }
    }
  }
  default: {
    const unhandled: never = mode;
    throw new Error(`unhandled persistence mode: ${String(unhandled)}`);
  }
  }
}

function validateModeAndRetiredIds({ control }: { control: NaidanPersistenceControlCoreV1 }): FileSystemId | undefined {
  const expectedAuthentication = persistenceControlAuthenticationFileSystemId({ mode: control.mode });
  const liveIds = new Set<string>();
  switch (control.mode.type) {
  case 'plain': break;
  case 'hizofs':
    liveIds.add(control.mode.activeFileSystemId);
    break;
  case 'transitioning': {
    const source = endpointId({ endpoint: control.mode.phase.source });
    const target = endpointId({ endpoint: control.mode.phase.target });
    if (source !== undefined) liveIds.add(source);
    if (target !== undefined) liveIds.add(target);
    break;
  }
  default: {
    const unhandled: never = control.mode;
    throw new Error(`unhandled persistence mode: ${String(unhandled)}`);
  }
  }
  let previous: string | undefined;
  for (const id of control.retiredFileSystemIds) {
    parsePortableFileSystemId({ value: id });
    if (previous !== undefined && previous >= id) throw new TypeError('retired File System IDs must be strict ascending ASCII');
    if (liveIds.has(id)) throw new TypeError('active or transition File System ID cannot be retired');
    previous = id;
  }
  return expectedAuthentication;
}

function validateCore({ control }: { control: NaidanPersistenceControlCoreV1 }): FileSystemId | undefined {
  if (control.format !== 'naidan-persistence-control' || control.formatVersion !== 1) throw new TypeError('Persistence Control format/version is unsupported');
  canonicalInteger({ label: 'Persistence Control copy', maximum: 1, minimum: 0, value: control.copy });
  canonicalInteger({ label: 'Persistence Control sequence', maximum: Number.MAX_SAFE_INTEGER, minimum: 1, value: control.sequence });
  return validateModeAndRetiredIds({ control });
}

export function validatePersistenceControl({ control }: { control: NaidanPersistenceControlV1 }): void {
  const expectedAuthentication = validateCore({ control });
  switch (control.protection.type) {
  case 'plain_sha256':
    if (expectedAuthentication !== undefined) throw new TypeError('HizoFS and transition modes require HizoFS protection');
    if (decodePersistenceControlBase64Url({ maximumDecodedBytes: 32, value: control.protection.digest }).byteLength !== 32) throw new RangeError('plain control digest must decode to 32 bytes');
    return;
  case 'hizofs_aes_256_gcm':
    if (expectedAuthentication === undefined) throw new TypeError('stable plain mode requires plain SHA-256 protection');
    if (control.protection.authenticationFileSystemId !== expectedAuthentication) throw new TypeError('authentication File System ID does not match mode authority');
    if (decodePersistenceControlBase64Url({ maximumDecodedBytes: 12, value: control.protection.nonce }).byteLength !== 12) throw new RangeError('control nonce must decode to 12 bytes');
    if (decodePersistenceControlBase64Url({ maximumDecodedBytes: 16, value: control.protection.authenticatorTag }).byteLength !== 16) throw new RangeError('control authenticator tag must decode to 16 bytes');
    return;
  default: {
    const unhandled: never = control.protection;
    throw new Error(`unhandled control protection: ${String(unhandled)}`);
  }
  }
}

export function encodePersistenceEndpoint({ endpoint }: { endpoint: NaidanPersistenceEndpointV1 }): string {
  switch (endpoint.type) {
  case 'plain': return '{"type":"plain"}';
  case 'hizofs': return `{"type":"hizofs","fileSystemId":${encodePersistenceControlAsciiString({ value: endpoint.fileSystemId })}}`;
  default: {
    const unhandled: never = endpoint;
    throw new Error(`unhandled persistence endpoint: ${String(unhandled)}`);
  }
  }
}

function encodeMode({ mode }: { mode: NaidanPersistenceModeV1 }): string {
  switch (mode.type) {
  case 'plain': return '{"type":"plain"}';
  case 'hizofs': return `{"type":"hizofs","activeFileSystemId":${encodePersistenceControlAsciiString({ value: mode.activeFileSystemId })}}`;
  case 'transitioning': return `{"type":"transitioning","operationId":${encodePersistenceControlAsciiString({ value: mode.operationId })},"operation":${encodePersistenceControlAsciiString({ value: mode.operation })},"phase":{"type":${encodePersistenceControlAsciiString({ value: mode.phase.type })},"source":${encodePersistenceEndpoint({ endpoint: mode.phase.source })},"target":${encodePersistenceEndpoint({ endpoint: mode.phase.target })}}}`;
  default: {
    const unhandled: never = mode;
    throw new Error(`unhandled persistence mode: ${String(unhandled)}`);
  }
  }
}

function encodeProtection({ protection }: { protection: NaidanControlProtectionV1 }): string {
  switch (protection.type) {
  case 'plain_sha256': return `{"type":"plain_sha256","digest":${encodePersistenceControlAsciiString({ value: protection.digest })}}`;
  case 'hizofs_aes_256_gcm': return `{"type":"hizofs_aes_256_gcm","authenticationFileSystemId":${encodePersistenceControlAsciiString({ value: protection.authenticationFileSystemId })},"nonce":${encodePersistenceControlAsciiString({ value: protection.nonce })},"authenticatorTag":${encodePersistenceControlAsciiString({ value: protection.authenticatorTag })}}`;
  default: {
    const unhandled: never = protection;
    throw new Error(`unhandled control protection: ${String(unhandled)}`);
  }
  }
}

function encodeCoreFields({ control }: { control: NaidanPersistenceControlCoreV1 }): readonly string[] {
  return [
    '"format":"naidan-persistence-control"',
    '"formatVersion":1',
    `"copy":${control.copy}`,
    `"sequence":${control.sequence}`,
    `"mode":${encodeMode({ mode: control.mode })}`,
    `"retiredFileSystemIds":[${control.retiredFileSystemIds.map(value => encodePersistenceControlAsciiString({ value })).join(',')}]`,
  ];
}

export function encodePersistenceControlCore({ control }: { control: NaidanPersistenceControlCoreV1 }): Uint8Array {
  validateCore({ control });
  return encodePersistenceControlUtf8({ value: `{${encodeCoreFields({ control }).join(',')}}\n` });
}

export function encodePersistenceControl({ control }: { control: NaidanPersistenceControlV1 }): Uint8Array {
  validatePersistenceControl({ control });
  return encodePersistenceControlUtf8({ value: `{${[...encodeCoreFields({ control }), `"protection":${encodeProtection({ protection: control.protection })}`].join(',')}}\n` });
}

export function encodeUnsignedProtectedPersistenceControl({
  control,
}: {
  control: NaidanPersistenceControlUnsignedProtectedV1;
}): Uint8Array {
  const expectedAuthentication = validateCore({ control });
  if (expectedAuthentication === undefined) throw new TypeError('unsigned HizoFS protection cannot encode stable plain mode');
  if (control.protection.authenticationFileSystemId !== expectedAuthentication) {
    throw new TypeError('authentication File System ID does not match mode authority');
  }
  if (decodePersistenceControlBase64Url({ maximumDecodedBytes: 12, value: control.protection.nonce }).byteLength !== 12) {
    throw new RangeError('control nonce must decode to 12 bytes');
  }
  const protection = `{"type":"hizofs_aes_256_gcm","authenticationFileSystemId":${encodePersistenceControlAsciiString({ value: control.protection.authenticationFileSystemId })},"nonce":${encodePersistenceControlAsciiString({ value: control.protection.nonce })}}`;
  return encodePersistenceControlUtf8({ value: `{${[...encodeCoreFields({ control }), `"protection":${protection}`].join(',')}}
` });
}

export function decodePersistenceControl({ bytes }: { bytes: Uint8Array }): NaidanPersistenceControlV1 {
  const parsed = decodePersistenceControlCanonicalJson({
    bytes,
    maximumBytes: CONSTANTS.limits.persistenceControlJsonBytes,
    maximumDepth: CONSTANTS.limits.controlJsonNestingDepth,
  });
  const object = strictObject({ fields: FORMATS.persistenceControl.fieldOrder, label: 'Persistence Control', value: parsed });
  if (object.format !== 'naidan-persistence-control' || object.formatVersion !== 1) throw new TypeError('Persistence Control format/version is unsupported');
  if (!Array.isArray(object.retiredFileSystemIds)) throw new TypeError('retired File System IDs must be an array');
  const control: NaidanPersistenceControlV1 = {
    copy: canonicalInteger({ label: 'Persistence Control copy', maximum: 1, minimum: 0, value: object.copy }) as 0 | 1,
    format: 'naidan-persistence-control',
    formatVersion: 1,
    mode: parseMode({ value: object.mode }),
    protection: parseProtection({ value: object.protection }),
    retiredFileSystemIds: object.retiredFileSystemIds.map(value => parsePortableFileSystemId({ value: stringValue({ label: 'retired File System ID', value }) })),
    sequence: canonicalInteger({ label: 'Persistence Control sequence', maximum: Number.MAX_SAFE_INTEGER, minimum: 1, value: object.sequence }),
  };
  validatePersistenceControl({ control });
  const canonical = encodePersistenceControl({ control });
  if (canonical.byteLength !== bytes.byteLength || canonical.some((byte, index) => byte !== bytes[index])) throw new TypeError('Persistence Control bytes are not canonical');
  return control;
}

export function persistenceControlSemanticallyEquals({ left, right }: { left: NaidanPersistenceControlV1; right: NaidanPersistenceControlV1 }): boolean {
  return encodeMode({ mode: left.mode }) === encodeMode({ mode: right.mode })
    && left.retiredFileSystemIds.length === right.retiredFileSystemIds.length
    && left.retiredFileSystemIds.every((value, index) => value === right.retiredFileSystemIds[index]);
}

export const TEST_ONLY = {
};
