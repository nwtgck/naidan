import {
  HIZOFS_CONVENTIONAL_SUFFIX,
  HIZOFS_V1_FORMAT_CONSTANTS,
  decodeLowercaseHex,
  decodeUtf8Strict,
  encodeLowercaseHex,
  encodeUtf8Strict,
  parseFileSystemId,
  type FileSystemId,
} from '@/00-storage/service/hizofs/00-format';

export type { FileSystemId } from '@/00-storage/service/hizofs/00-format';

export const PORTABLE_HIZOFS_CONTAINER_SUFFIX = HIZOFS_CONVENTIONAL_SUFFIX;

export function encodePortableFileSystemIdHex({ id }: { id: FileSystemId }): string {
  parseFileSystemId({ value: id });
  return encodeLowercaseHex({ bytes: encodeUtf8Strict({ label: 'File System ID', value: id }) });
}

export function parsePortableFileSystemIdHex({ value }: { value: string }): FileSystemId {
  const bytes = decodeLowercaseHex({
    expectedBytes: HIZOFS_V1_FORMAT_CONSTANTS.limits.fileSystemIdCharacters,
    value,
  });
  return parseFileSystemId({ value: decodeUtf8Strict({ bytes, label: 'File System ID' }) });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
