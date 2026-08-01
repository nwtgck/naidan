import {
  decodePersistenceControlCanonicalJson,
  encodePersistenceControlAsciiString,
  encodePersistenceControlUtf8,
} from '@/00-storage/service/hizofs/compatibility';
import { NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS } from '@/00-storage/service/naidan-persistence-control/00-format/transition-progress-format-constants';

export type NativePlainTransitionTargetLifecycle =
  | 'preparing'
  | 'active'
  | 'sealed'
  | 'published';

export type NativePlainTransitionTargetCheckpointV1 = Readonly<{
  lifecycle: NativePlainTransitionTargetLifecycle;
}>;

const CONSTANTS = NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS.plainTargetCheckpoint;
type JsonObject = Record<string, unknown>;

function strictObject({ fields, label, value }: {
  fields: readonly string[];
  label: string;
  value: unknown;
}): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const object = value as JsonObject;
  const keys = Object.keys(object);
  if (keys.length !== fields.length || keys.some((key, index) => key !== fields[index])) {
    throw new TypeError(`${label} fields are unknown, missing, or out of canonical order`);
  }
  return object;
}

function parseLifecycle({ value }: { value: unknown }): NativePlainTransitionTargetLifecycle {
  switch (value) {
  case 'preparing':
  case 'active':
  case 'sealed':
  case 'published': return value;
  default: throw new TypeError('native plain transition target lifecycle is unsupported');
  }
}

export function encodeNativePlainTransitionTargetCheckpoint({ checkpoint }: {
  checkpoint: NativePlainTransitionTargetCheckpointV1;
}): Uint8Array {
  const lifecycle = parseLifecycle({ value: checkpoint.lifecycle });
  return encodePersistenceControlUtf8({
    value: `{"format":${encodePersistenceControlAsciiString({ value: CONSTANTS.format })},"formatVersion":${CONSTANTS.formatVersion},"lifecycle":${encodePersistenceControlAsciiString({ value: lifecycle })}}\n`,
  });
}

export function decodeNativePlainTransitionTargetCheckpoint({ bytes }: {
  bytes: Uint8Array;
}): NativePlainTransitionTargetCheckpointV1 {
  const object = strictObject({
    fields: ['format', 'formatVersion', 'lifecycle'],
    label: 'native plain transition target checkpoint',
    value: decodePersistenceControlCanonicalJson({
      bytes,
      maximumBytes: CONSTANTS.maximumBytes,
      maximumDepth: CONSTANTS.maximumDepth,
    }),
  });
  if (object.format !== CONSTANTS.format || object.formatVersion !== CONSTANTS.formatVersion) {
    throw new TypeError('native plain transition target checkpoint format/version is unsupported');
  }
  const checkpoint = { lifecycle: parseLifecycle({ value: object.lifecycle }) } as const;
  const canonical = encodeNativePlainTransitionTargetCheckpoint({ checkpoint });
  if (canonical.byteLength !== bytes.byteLength || canonical.some((value, index) => value !== bytes[index])) {
    throw new TypeError('native plain transition target checkpoint is not canonical');
  }
  return checkpoint;
}

export const TEST_ONLY = {
  parseLifecycle,
};
