import type {
  EncryptedOpfsDirectoryEntryDto,
  EncryptedOpfsDirectoryInodeDto,
  EncryptedOpfsFileChunkDto,
  EncryptedOpfsFileInodeDto,
  EncryptedOpfsSymlinkInodeDto,
} from '@/00-storage/00-dto/encrypted-opfs.dto';
import { validateEncryptedOpfsStableId } from '@/00-storage/service/encrypted-opfs/id';
import { decodeEncryptedOpfsObjectId } from '@/00-storage/service/encrypted-opfs/object-store/object-id';
import { compareEncryptedOpfsStrings } from './ordering';

export function assertEncryptedOpfsNonNegativeSafeInteger({ value, fieldName }: {
  value: number;
  fieldName: string;
}): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }
}

export function assertEncryptedOpfsPositiveSafeInteger({ value, fieldName }: {
  value: number;
  fieldName: string;
}): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive safe integer`);
  }
}

export function assertEncryptedOpfsObjectId({ value, fieldName }: {
  value: string;
  fieldName: string;
}): void {
  try {
    decodeEncryptedOpfsObjectId({ objectId: value });
  } catch (error) {
    throw new Error(`${fieldName} is not a valid EncryptedOpfs object ID`, { cause: error });
  }
}

export function assertEncryptedOpfsEntryName({ name }: {
  name: string;
}): void {
  if (
    name.length === 0
    || name === '.'
    || name === '..'
    || name.includes('/')
    || name.includes('\0')
  ) {
    throw new Error(`Invalid EncryptedOpfs directory entry name: ${name}`);
  }
}

export function assertEncryptedOpfsDirectoryEntries({ entries }: {
  entries: readonly EncryptedOpfsDirectoryEntryDto[];
}): void {
  let previousName: string | undefined;
  for (const entry of entries) {
    assertEncryptedOpfsEntryName({ name: entry.name });
    validateEncryptedOpfsStableId({
      value: entry.nodeId,
      fieldName: 'EncryptedOpfs directory entry nodeId',
    });
    if (
      previousName !== undefined
      && compareEncryptedOpfsStrings({ left: previousName, right: entry.name }) >= 0
    ) {
      throw new Error('EncryptedOpfs directory entries must be strictly sorted and unique');
    }
    previousName = entry.name;
  }
}

function assertTimestamp({ value, fieldName }: {
  value: number | null;
  fieldName: string;
}): void {
  if (value !== null) {
    assertEncryptedOpfsNonNegativeSafeInteger({ value, fieldName });
  }
}

export function assertEncryptedOpfsFileInode({ inode, binaryPayload }: {
  inode: EncryptedOpfsFileInodeDto;
  binaryPayload: Uint8Array;
}): void {
  validateEncryptedOpfsStableId({ value: inode.nodeId, fieldName: 'EncryptedOpfs file nodeId' });
  assertEncryptedOpfsNonNegativeSafeInteger({ value: inode.revision, fieldName: 'File revision' });
  assertTimestamp({ value: inode.createdAt, fieldName: 'File createdAt' });
  assertTimestamp({ value: inode.modifiedAt, fieldName: 'File modifiedAt' });
  assertEncryptedOpfsNonNegativeSafeInteger({ value: inode.size, fieldName: 'File size' });

  switch (inode.storage.type) {
  case 'inline':
    if (binaryPayload.byteLength !== inode.size) {
      throw new Error('EncryptedOpfs inline file payload length does not match its size');
    }
    break;
  case 'extents':
    if (binaryPayload.byteLength !== 0) {
      throw new Error('EncryptedOpfs extent-backed file inode must not contain inline bytes');
    }
    assertEncryptedOpfsPositiveSafeInteger({
      value: inode.storage.chunkSize,
      fieldName: 'File chunkSize',
    });
    assertEncryptedOpfsObjectId({
      value: inode.storage.extentIndexRootObjectId,
      fieldName: 'File extentIndexRootObjectId',
    });
    break;
  default: {
    const _ex: never = inode.storage;
    throw new Error(`Unhandled EncryptedOpfs file storage: ${String(_ex)}`);
  }
  }
}

export function assertEncryptedOpfsDirectoryInode({ inode }: {
  inode: EncryptedOpfsDirectoryInodeDto;
}): void {
  validateEncryptedOpfsStableId({ value: inode.nodeId, fieldName: 'EncryptedOpfs directory nodeId' });
  assertEncryptedOpfsNonNegativeSafeInteger({ value: inode.revision, fieldName: 'Directory revision' });
  assertTimestamp({ value: inode.createdAt, fieldName: 'Directory createdAt' });
  assertTimestamp({ value: inode.modifiedAt, fieldName: 'Directory modifiedAt' });
  switch (inode.storage.type) {
  case 'inline':
    assertEncryptedOpfsDirectoryEntries({ entries: inode.storage.entries });
    break;
  case 'indexed':
    assertEncryptedOpfsObjectId({
      value: inode.storage.directoryIndexRootObjectId,
      fieldName: 'Directory index root object ID',
    });
    break;
  default: {
    const _ex: never = inode.storage;
    throw new Error(`Unhandled EncryptedOpfs directory storage: ${String(_ex)}`);
  }
  }
}

export function assertEncryptedOpfsSymlinkInode({ inode }: {
  inode: EncryptedOpfsSymlinkInodeDto;
}): void {
  validateEncryptedOpfsStableId({ value: inode.nodeId, fieldName: 'EncryptedOpfs symlink nodeId' });
  assertEncryptedOpfsNonNegativeSafeInteger({ value: inode.revision, fieldName: 'Symlink revision' });
  assertTimestamp({ value: inode.createdAt, fieldName: 'Symlink createdAt' });
  assertTimestamp({ value: inode.modifiedAt, fieldName: 'Symlink modifiedAt' });
  if (inode.target.includes('\0')) {
    throw new Error('EncryptedOpfs symlink target must not contain a null character');
  }
}

export function assertEncryptedOpfsFileChunk({ chunk, binaryPayload, chunkSize }: {
  chunk: EncryptedOpfsFileChunkDto;
  binaryPayload: Uint8Array;
  chunkSize: number;
}): void {
  validateEncryptedOpfsStableId({ value: chunk.nodeId, fieldName: 'EncryptedOpfs chunk nodeId' });
  assertEncryptedOpfsNonNegativeSafeInteger({ value: chunk.chunkIndex, fieldName: 'Chunk index' });
  if (binaryPayload.byteLength === 0 || binaryPayload.byteLength > chunkSize) {
    throw new Error('EncryptedOpfs file chunk payload length is invalid');
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
