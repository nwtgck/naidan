import { HIZOFS_V1_FORMAT_CONSTANTS } from './format-constants';
import { parseSegmentIdLowercaseHex, segmentIdToLowercaseHex, type SegmentId } from './identifiers';

const CONTAINER = HIZOFS_V1_FORMAT_CONSTANTS.container;

export type SegmentClass = keyof typeof CONTAINER.segmentClassDirectories;

declare const segmentShardDirectoryNameBrand: unique symbol;
export type SegmentShardDirectoryName = string & { readonly [segmentShardDirectoryNameBrand]: true };

export const HIZOFS_CONVENTIONAL_SUFFIX = CONTAINER.conventionalSuffix;
export const HIZOFS_ENCRYPTED_FILE_SUFFIX = CONTAINER.encryptedFileSuffix;
export const HIZOFS_UNLOCK_ENVELOPE_FILES = CONTAINER.unlockEnvelopeFiles;
export const HIZOFS_SUPERBLOCK_FILES = CONTAINER.superblockFiles;

export function parseSegmentClassDirectoryName({ value }: { value: string }): SegmentClass {
  switch (value) {
  case CONTAINER.segmentClassDirectories.data:
    return 'data';
  case CONTAINER.segmentClassDirectories.metadata:
    return 'metadata';
  default:
    throw new TypeError('segment class directory must use a registry-owned canonical name');
  }
}

export function parseSegmentShardDirectoryName({ value }: { value: string }): SegmentShardDirectoryName {
  if (!/^[0-9a-f]{2}$/u.test(value)) {
    throw new TypeError('segment shard directory must be exactly two lowercase hexadecimal digits');
  }
  return value as SegmentShardDirectoryName;
}

export function segmentIdToShard({ id }: { id: SegmentId }): SegmentShardDirectoryName {
  const finalByte = id.at(-1);
  if (finalByte === undefined) throw new Error('Segment ID length invariant failed');
  return finalByte.toString(16).padStart(2, '0') as SegmentShardDirectoryName;
}

export function segmentIdToFilename({ id }: { id: SegmentId }): string {
  return `${segmentIdToLowercaseHex({ id })}${HIZOFS_ENCRYPTED_FILE_SUFFIX}`;
}

export function parseSegmentFilename({ value }: { value: string }): SegmentId {
  if (!value.endsWith(HIZOFS_ENCRYPTED_FILE_SUFFIX)) {
    throw new TypeError(`segment filename must use the ${HIZOFS_ENCRYPTED_FILE_SUFFIX} suffix`);
  }
  return parseSegmentIdLowercaseHex({ value: value.slice(0, -HIZOFS_ENCRYPTED_FILE_SUFFIX.length) });
}

export function segmentIdToRelativePath({ id, segmentClass }: { id: SegmentId; segmentClass: SegmentClass }): string {
  const classDirectory = CONTAINER.segmentClassDirectories[segmentClass];
  return `${CONTAINER.segmentDirectoryName}/${classDirectory}/${segmentIdToShard({ id })}/${segmentIdToFilename({ id })}`;
}

export function assertSegmentPathBinding({ id, relativePath, segmentClass }: {
  readonly id: SegmentId;
  readonly segmentClass: SegmentClass;
  readonly relativePath: string;
}): void {
  if (relativePath !== segmentIdToRelativePath({ id, segmentClass })) {
    throw new TypeError('segment path does not match the authenticated Segment ID and class');
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
