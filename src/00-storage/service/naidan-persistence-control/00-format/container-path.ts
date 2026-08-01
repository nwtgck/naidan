import {
  PORTABLE_HIZOFS_CONTAINER_SUFFIX,
  encodePortableFileSystemIdHex,
  parsePortableFileSystemIdHex,
  type FileSystemId,
} from '@/00-storage/service/hizofs/compatibility';
import { NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS } from './format-constants';

const STORAGE = NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage;
const CONTAINER_PREFIX = STORAGE.containerNamePrefix;

export function fileSystemIdToNaidanContainerToken({ id }: { id: FileSystemId }): string {
  return `${CONTAINER_PREFIX}${encodePortableFileSystemIdHex({ id })}${PORTABLE_HIZOFS_CONTAINER_SUFFIX}`;
}

export function parseNaidanContainerToken({ value }: { value: string }): FileSystemId {
  if (!value.startsWith(CONTAINER_PREFIX) || !value.endsWith(PORTABLE_HIZOFS_CONTAINER_SUFFIX)) {
    throw new TypeError('Naidan HizoFS container token has an invalid prefix or suffix');
  }
  const hex = value.slice(CONTAINER_PREFIX.length, -PORTABLE_HIZOFS_CONTAINER_SUFFIX.length);
  const id = parsePortableFileSystemIdHex({ value: hex });
  if (fileSystemIdToNaidanContainerToken({ id }) !== value) {
    throw new TypeError('Naidan HizoFS container token is not canonical');
  }
  if (STORAGE.containerNameEncoding !== 'fs-_plus_lowercase_hex_of_file_system_id_ascii21_plus_.hizofs') {
    throw new Error('unsupported Naidan HizoFS container-name profile');
  }
  return id;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
