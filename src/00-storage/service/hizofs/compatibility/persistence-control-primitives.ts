import {
  decodeBase64UrlUnpadded,
  encodeBase64UrlUnpadded,
  decodeRestrictedCanonicalJson,
  decodeUtf8Strict,
  encodeCanonicalAsciiString,
  encodeFilenameComponent,
  encodeSymlinkTarget,
  encodeUtf8Strict,
  parseFileSystemId,
  type FileSystemId,
} from '@/00-storage/service/hizofs/00-format';

export type { FileSystemId } from '@/00-storage/service/hizofs/00-format';

export function encodePersistenceControlBase64Url({ bytes }: { bytes: Uint8Array }): string {
  return encodeBase64UrlUnpadded({ bytes });
}

export function decodePersistenceControlBase64Url({ maximumDecodedBytes, value }: { maximumDecodedBytes: number; value: string }): Uint8Array {
  return decodeBase64UrlUnpadded({ maximumDecodedBytes, value });
}

export function decodePersistenceControlCanonicalJson({ bytes, maximumBytes, maximumDepth }: { bytes: Uint8Array; maximumBytes: number; maximumDepth: number }): unknown {
  return decodeRestrictedCanonicalJson({ bytes, maximumBytes, maximumDepth });
}

export function encodePersistenceControlAsciiString({ value }: { value: string }): string {
  return encodeCanonicalAsciiString({ value });
}

export function encodePortableFilenameComponent({ value }: { value: string }): Uint8Array {
  return encodeFilenameComponent({ value });
}

export function encodePortableSymlinkTarget({ value }: { value: string }): Uint8Array {
  return encodeSymlinkTarget({ value });
}

export function decodePersistenceControlUtf8({ bytes }: { bytes: Uint8Array }): string {
  return decodeUtf8Strict({ bytes, label: 'persistence control UTF-8' });
}

export function encodePersistenceControlUtf8({ value }: { value: string }): Uint8Array {
  return encodeUtf8Strict({ value });
}

export function parsePortableFileSystemId({ value }: { value: string }): FileSystemId {
  return parseFileSystemId({ value });
}

export const TEST_ONLY = {
};
