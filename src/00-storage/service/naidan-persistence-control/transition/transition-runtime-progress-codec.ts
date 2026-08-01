import {
  decodePersistenceControlBase64Url,
  decodePersistenceControlCanonicalJson,
  decodePersistenceControlUtf8,
  encodePersistenceControlAsciiString,
  encodePersistenceControlBase64Url,
  encodePersistenceControlUtf8,
} from '@/00-storage/service/hizofs/compatibility';
import {
  encodePersistenceEndpoint,
  NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS,
  parsePersistenceEndpoint,
  parseTransitionOperationId,
  type NaidanPersistenceEndpointV1,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import { validateTransitionNamespaceEntryName } from '@/00-storage/service/naidan-persistence-control/transition/namespace-contracts';
import type {
  TransitionNamespaceActiveFile,
  TransitionNamespaceCopyCursor,
  TransitionNamespaceDirectoryFrame,
  TransitionNamespaceMetadata,
  TransitionNamespacePath,
} from '@/00-storage/service/naidan-persistence-control/transition/namespace-copy';
import type { TransitionRuntimeProgress } from '@/00-storage/service/naidan-persistence-control/transition/transition-coordinator';
import type { TransitionNamespaceVerificationCursor } from '@/00-storage/service/naidan-persistence-control/transition/namespace-verification';

const CONSTANTS = NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS;
const UINT64_MAXIMUM = (1n << 64n) - 1n;
type JsonObject = Record<string, unknown>;

function strictObject({ fields, label, value }: {
  fields: readonly string[];
  label: string;
  value: unknown;
}): JsonObject {
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

function parseUnsignedDecimal({ label, value }: { label: string; value: unknown }): bigint {
  const text = stringValue({ label, value });
  if (!/^(0|[1-9][0-9]*)$/u.test(text)) throw new TypeError(`${label} must be canonical unsigned decimal`);
  const parsed = BigInt(text);
  if (parsed > UINT64_MAXIMUM) throw new RangeError(`${label} exceeds UInt64`);
  return parsed;
}

function parseSignedDecimalOrAbsent({ label, value }: { label: string; value: unknown }): bigint | undefined {
  const text = stringValue({ label, value });
  if (text === '') return undefined;
  if (!/^(0|-?[1-9][0-9]*)$/u.test(text)) throw new TypeError(`${label} must be canonical signed decimal or null`);
  return BigInt(text);
}

function encodeDecimal({ value }: { value: bigint }): string {
  return encodePersistenceControlAsciiString({ value: value.toString() });
}

function encodeUnsignedDecimal({ label, value }: { label: string; value: bigint }): string {
  if (value < 0n || value > UINT64_MAXIMUM) throw new RangeError(`${label} is outside UInt64`);
  return encodeDecimal({ value });
}

function encodeOptionalDecimal({ value }: { value: bigint | undefined }): string {
  return value === undefined ? encodePersistenceControlAsciiString({ value: '' }) : encodeDecimal({ value });
}

function parseMetadata({ value }: { value: unknown }): TransitionNamespaceMetadata {
  const object = strictObject({ fields: ['createdAt', 'modifiedAt'], label: 'transition metadata', value });
  return {
    createdAt: parseSignedDecimalOrAbsent({ label: 'created timestamp', value: object.createdAt }),
    modifiedAt: parseSignedDecimalOrAbsent({ label: 'modified timestamp', value: object.modifiedAt }),
  };
}

function encodeMetadata({ metadata }: { metadata: TransitionNamespaceMetadata }): string {
  return `{"createdAt":${encodeOptionalDecimal({ value: metadata.createdAt })},"modifiedAt":${encodeOptionalDecimal({ value: metadata.modifiedAt })}}`;
}


function parseFilenameText({ label, value }: { label: string; value: unknown }): string {
  const encoded = stringValue({ label, value });
  const name = decodePersistenceControlUtf8({
    bytes: decodePersistenceControlBase64Url({ maximumDecodedBytes: CONSTANTS.limits.portableProgressBytes, value: encoded }),
  });
  validateTransitionNamespaceEntryName({ name });
  return name;
}

function encodeFilenameText({ name }: { name: string }): string {
  validateTransitionNamespaceEntryName({ name });
  return encodePersistenceControlAsciiString({
    value: encodePersistenceControlBase64Url({ bytes: encodePersistenceControlUtf8({ value: name }) }),
  });
}

function parsePath({ label, value }: { label: string; value: unknown }): TransitionNamespacePath {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (value.length > CONSTANTS.limits.portableProgressPathComponents) throw new RangeError(`${label} exceeds the component bound`);
  return value.map((component, index) => {
    return parseFilenameText({ label: `${label}[${index}]`, value: component });
  });
}

function encodePath({ path }: { path: TransitionNamespacePath }): string {
  if (path.length > CONSTANTS.limits.portableProgressPathComponents) throw new RangeError('transition path exceeds the component bound');
  return `[${path.map((name) => {
    return encodeFilenameText({ name });
  }).join(',')}]`;
}

function parseDirectoryFrame({ value }: { value: unknown }): TransitionNamespaceDirectoryFrame {
  const object = strictObject({ fields: ['afterName', 'path'], label: 'transition directory frame', value });
  const afterNameText = stringValue({ label: 'directory frame afterName', value: object.afterName });
  const afterName = afterNameText === '' ? undefined : parseFilenameText({ label: 'directory frame afterName', value: afterNameText });
  return { afterName, path: parsePath({ label: 'directory frame path', value: object.path }) };
}

function encodeDirectoryFrame({ frame }: { frame: TransitionNamespaceDirectoryFrame }): string {
  return `{"afterName":${frame.afterName === undefined ? encodePersistenceControlAsciiString({ value: '' }) : encodeFilenameText({ name: frame.afterName })},"path":${encodePath({ path: frame.path })}}`;
}

function parseDirectories({ value }: { value: unknown }): readonly TransitionNamespaceDirectoryFrame[] {
  if (!Array.isArray(value)) throw new TypeError('transition directory frames must be an array');
  if (value.length > CONSTANTS.limits.portableProgressDirectoryFrames) throw new RangeError('transition directory frames exceed the bound');
  return value.map((entry) => parseDirectoryFrame({ value: entry }));
}

function encodeDirectories({ directories }: { directories: readonly TransitionNamespaceDirectoryFrame[] }): string {
  if (directories.length > CONSTANTS.limits.portableProgressDirectoryFrames) throw new RangeError('transition directory frames exceed the bound');
  return `[${directories.map((frame) => encodeDirectoryFrame({ frame })).join(',')}]`;
}

function parseActiveFile({ value }: { value: unknown }): TransitionNamespaceActiveFile | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('transition active file must be an object');
  if (Object.keys(value as JsonObject).length === 0) return undefined;
  const object = strictObject({ fields: ['metadata', 'offset', 'path', 'size'], label: 'transition active file', value });
  const offset = parseUnsignedDecimal({ label: 'active file offset', value: object.offset });
  const size = parseUnsignedDecimal({ label: 'active file size', value: object.size });
  if (offset > size) throw new RangeError('active file offset exceeds its captured size');
  return {
    metadata: parseMetadata({ value: object.metadata }),
    offset,
    path: parsePath({ label: 'active file path', value: object.path }),
    size,
  };
}

function encodeActiveFile({ activeFile }: { activeFile: TransitionNamespaceActiveFile | undefined }): string {
  if (activeFile === undefined) return '{}';
  if (activeFile.offset < 0n || activeFile.offset > activeFile.size || activeFile.size > UINT64_MAXIMUM) {
    throw new RangeError('active file offset or size is outside the canonical range');
  }
  return `{"metadata":${encodeMetadata({ metadata: activeFile.metadata })},"offset":${encodeUnsignedDecimal({ label: 'active file offset', value: activeFile.offset })},"path":${encodePath({ path: activeFile.path })},"size":${encodeUnsignedDecimal({ label: 'active file size', value: activeFile.size })}}`;
}

function validateCursorShape({ activeFile, directories, state }: {
  activeFile: TransitionNamespaceActiveFile | undefined;
  directories: readonly TransitionNamespaceDirectoryFrame[];
  state: 'complete' | 'copying' | 'verifying';
}): void {
  switch (state) {
  case 'complete':
    if (activeFile !== undefined || directories.length !== 0) throw new TypeError('complete transition cursor must not retain traversal state');
    break;
  case 'copying':
  case 'verifying':
    if (directories.length === 0) throw new TypeError('active transition cursor must retain at least one directory frame');
    break;
  default: state satisfies never;
  }
}

function parseCopyCursor({ value }: { value: unknown }): TransitionNamespaceCopyCursor {
  const object = strictObject({ fields: ['activeFile', 'completedBytes', 'completedEntries', 'directories', 'state'], label: 'transition copy cursor', value });
  const activeFile = parseActiveFile({ value: object.activeFile });
  const directories = parseDirectories({ value: object.directories });
  if (object.state !== 'copying' && object.state !== 'complete') throw new TypeError('transition copy cursor state is unsupported');
  validateCursorShape({ activeFile, directories, state: object.state });
  return {
    activeFile,
    completedBytes: parseUnsignedDecimal({ label: 'completed bytes', value: object.completedBytes }),
    completedEntries: parseUnsignedDecimal({ label: 'completed entries', value: object.completedEntries }),
    directories,
    state: object.state,
  };
}

function encodeCopyCursor({ cursor }: { cursor: TransitionNamespaceCopyCursor }): string {
  validateCursorShape({ activeFile: cursor.activeFile, directories: cursor.directories, state: cursor.state });
  return `{"activeFile":${encodeActiveFile({ activeFile: cursor.activeFile })},"completedBytes":${encodeUnsignedDecimal({ label: 'completed bytes', value: cursor.completedBytes })},"completedEntries":${encodeUnsignedDecimal({ label: 'completed entries', value: cursor.completedEntries })},"directories":${encodeDirectories({ directories: cursor.directories })},"state":${encodePersistenceControlAsciiString({ value: cursor.state })}}`;
}

function parseVerificationCursor({ value }: { value: unknown }): TransitionNamespaceVerificationCursor {
  const object = strictObject({ fields: ['activeFile', 'directories', 'state', 'verifiedBytes', 'verifiedEntries'], label: 'transition verification cursor', value });
  const activeFile = parseActiveFile({ value: object.activeFile });
  const directories = parseDirectories({ value: object.directories });
  if (object.state !== 'verifying' && object.state !== 'complete') throw new TypeError('transition verification cursor state is unsupported');
  validateCursorShape({ activeFile, directories, state: object.state });
  return {
    activeFile,
    directories,
    state: object.state,
    verifiedBytes: parseUnsignedDecimal({ label: 'verified bytes', value: object.verifiedBytes }),
    verifiedEntries: parseUnsignedDecimal({ label: 'verified entries', value: object.verifiedEntries }),
  };
}

function encodeVerificationCursor({ cursor }: { cursor: TransitionNamespaceVerificationCursor }): string {
  validateCursorShape({ activeFile: cursor.activeFile, directories: cursor.directories, state: cursor.state });
  return `{"activeFile":${encodeActiveFile({ activeFile: cursor.activeFile })},"directories":${encodeDirectories({ directories: cursor.directories })},"state":${encodePersistenceControlAsciiString({ value: cursor.state })},"verifiedBytes":${encodeUnsignedDecimal({ label: 'verified bytes', value: cursor.verifiedBytes })},"verifiedEntries":${encodeUnsignedDecimal({ label: 'verified entries', value: cursor.verifiedEntries })}}`;
}

function parseAuthorityIdentity({ value }: { value: unknown }): string {
  const identity = stringValue({ label: 'source authority identity', value });
  if (identity.length === 0 || identity.length > CONSTANTS.limits.authorityIdentityCharacters) throw new RangeError('source authority identity is outside the bound');
  encodePersistenceControlAsciiString({ value: identity });
  return identity;
}

function encodeCommon({ operationId, source, sourceAuthorityIdentity, stage, target }: Pick<TransitionRuntimeProgress, 'operationId' | 'source' | 'sourceAuthorityIdentity' | 'stage' | 'target'>): string {
  const identity = parseAuthorityIdentity({ value: sourceAuthorityIdentity });
  return `"operationId":${encodePersistenceControlAsciiString({ value: operationId })},"source":${encodePersistenceEndpoint({ endpoint: source })},"sourceAuthorityIdentity":${encodePersistenceControlAsciiString({ value: identity })},"stage":${encodePersistenceControlAsciiString({ value: stage })},"target":${encodePersistenceEndpoint({ endpoint: target })}`;
}

export function encodeTransitionRuntimeProgress({ progress }: { progress: TransitionRuntimeProgress }): Uint8Array {
  const json = (() => {
    switch (progress.stage) {
    case 'copying': return `{${encodeCommon(progress)},"copyCursor":${encodeCopyCursor({ cursor: progress.copyCursor })}}\n`;
    case 'verifying': return `{${encodeCommon(progress)},"verificationCursor":${encodeVerificationCursor({ cursor: progress.verificationCursor })}}\n`;
    default: return progress satisfies never;
    }
  })();
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > CONSTANTS.limits.portableProgressBytes) throw new RangeError('transition runtime progress exceeds the byte bound');
  return bytes;
}

export function decodeTransitionRuntimeProgress({ bytes }: { bytes: Uint8Array }): TransitionRuntimeProgress {
  const value = decodePersistenceControlCanonicalJson({
    bytes,
    maximumBytes: CONSTANTS.limits.portableProgressBytes,
    maximumDepth: CONSTANTS.limits.portableProgressJsonDepth,
  });
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('transition runtime progress must be an object');
  const stage = (value as JsonObject).stage;
  const object = (() => {
    switch (stage) {
    case 'copying': return strictObject({ fields: ['operationId', 'source', 'sourceAuthorityIdentity', 'stage', 'target', 'copyCursor'], label: 'copying transition runtime progress', value });
    case 'verifying': return strictObject({ fields: ['operationId', 'source', 'sourceAuthorityIdentity', 'stage', 'target', 'verificationCursor'], label: 'verifying transition runtime progress', value });
    default: throw new TypeError('transition runtime progress stage is unsupported');
    }
  })();
  const common = {
    operationId: parseTransitionOperationId({ value: stringValue({ label: 'transition operation ID', value: object.operationId }) }),
    source: parsePersistenceEndpoint({ value: object.source }),
    sourceAuthorityIdentity: parseAuthorityIdentity({ value: object.sourceAuthorityIdentity }),
    target: parsePersistenceEndpoint({ value: object.target }),
  } satisfies Readonly<{
    operationId: TransitionRuntimeProgress['operationId'];
    source: NaidanPersistenceEndpointV1;
    sourceAuthorityIdentity: string;
    target: NaidanPersistenceEndpointV1;
  }>;
  const progress: TransitionRuntimeProgress = (() => {
    switch (stage) {
    case 'copying': return { ...common, copyCursor: parseCopyCursor({ value: object.copyCursor }), stage };
    case 'verifying': return { ...common, stage, verificationCursor: parseVerificationCursor({ value: object.verificationCursor }) };
    default: return stage satisfies never;
    }
  })();
  const canonical = encodeTransitionRuntimeProgress({ progress });
  if (canonical.byteLength !== bytes.byteLength || canonical.some((byte, index) => byte !== bytes[index])) {
    throw new TypeError('transition runtime progress is not canonical JSON');
  }
  return progress;
}

export const TEST_ONLY = {
};
