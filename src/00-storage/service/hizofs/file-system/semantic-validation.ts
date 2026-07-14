import type {
  HizoFSDirectoryEntryDto,
  HizoFSDirectoryInodeDto,
  HizoFSFileChunkDto,
  HizoFSFileInodeDto,
  HizoFSSymlinkInodeDto,
} from '@/00-storage/00-dto/hizofs.dto';
import { validateHizoFSStableId } from '@/00-storage/service/hizofs/id';
import { validateHizoFSObjectId } from '@/00-storage/service/hizofs/object-store/object-id';
import { compareHizoFSStrings } from './ordering';

export function assertHizoFSNonNegativeSafeInteger({ value, fieldName }: {
  value: number;
  fieldName: string;
}): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }
}

export function assertHizoFSPositiveSafeInteger({ value, fieldName }: {
  value: number;
  fieldName: string;
}): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive safe integer`);
  }
}

export function assertHizoFSObjectId({ value, fieldName }: {
  value: string;
  fieldName: string;
}): void {
  try {
    validateHizoFSObjectId({ objectId: value });
  } catch (error) {
    throw new Error(`${fieldName} is not a valid HizoFS object ID`, { cause: error });
  }
}

export function assertHizoFSEntryName({ name }: {
  name: string;
}): void {
  if (
    name.length === 0
    || name === '.'
    || name === '..'
    || name.includes('/')
    || name.includes('\0')
  ) {
    throw new Error(`Invalid HizoFS directory entry name: ${name}`);
  }
}

export function assertHizoFSDirectoryEntries({ entries }: {
  entries: readonly HizoFSDirectoryEntryDto[];
}): void {
  let previousName: string | undefined;
  for (const entry of entries) {
    assertHizoFSEntryName({ name: entry.name });
    validateHizoFSStableId({
      value: entry.nodeId,
      fieldName: 'HizoFS directory entry nodeId',
    });
    if (
      previousName !== undefined
      && compareHizoFSStrings({ left: previousName, right: entry.name }) >= 0
    ) {
      throw new Error('HizoFS directory entries must be strictly sorted and unique');
    }
    previousName = entry.name;
  }
}

function assertTimestamp({ value, fieldName }: {
  value: number | null;
  fieldName: string;
}): void {
  if (value !== null) {
    assertHizoFSNonNegativeSafeInteger({ value, fieldName });
  }
}

export function assertHizoFSFileInode({ inode, binaryPayload }: {
  inode: HizoFSFileInodeDto;
  binaryPayload: Uint8Array;
}): void {
  validateHizoFSStableId({ value: inode.nodeId, fieldName: 'HizoFS file nodeId' });
  assertHizoFSNonNegativeSafeInteger({ value: inode.revision, fieldName: 'File revision' });
  assertTimestamp({ value: inode.createdAt, fieldName: 'File createdAt' });
  assertTimestamp({ value: inode.modifiedAt, fieldName: 'File modifiedAt' });
  assertHizoFSNonNegativeSafeInteger({ value: inode.size, fieldName: 'File size' });

  switch (inode.storage.type) {
  case 'inline':
    if (binaryPayload.byteLength !== inode.size) {
      throw new Error('HizoFS inline file payload length does not match its size');
    }
    break;
  case 'extents':
    if (binaryPayload.byteLength !== 0) {
      throw new Error('HizoFS extent-backed file inode must not contain inline bytes');
    }
    assertHizoFSPositiveSafeInteger({
      value: inode.storage.chunkSize,
      fieldName: 'File chunkSize',
    });
    assertHizoFSObjectId({
      value: inode.storage.extentIndexRootObjectId,
      fieldName: 'File extentIndexRootObjectId',
    });
    break;
  default: {
    const _ex: never = inode.storage;
    throw new Error(`Unhandled HizoFS file storage: ${String(_ex)}`);
  }
  }
}

export function assertHizoFSDirectoryInode({ inode }: {
  inode: HizoFSDirectoryInodeDto;
}): void {
  validateHizoFSStableId({ value: inode.nodeId, fieldName: 'HizoFS directory nodeId' });
  assertHizoFSNonNegativeSafeInteger({ value: inode.revision, fieldName: 'Directory revision' });
  assertTimestamp({ value: inode.createdAt, fieldName: 'Directory createdAt' });
  assertTimestamp({ value: inode.modifiedAt, fieldName: 'Directory modifiedAt' });
  switch (inode.storage.type) {
  case 'inline':
    assertHizoFSDirectoryEntries({ entries: inode.storage.entries });
    break;
  case 'indexed':
    assertHizoFSObjectId({
      value: inode.storage.directoryIndexRootObjectId,
      fieldName: 'Directory index root object ID',
    });
    break;
  default: {
    const _ex: never = inode.storage;
    throw new Error(`Unhandled HizoFS directory storage: ${String(_ex)}`);
  }
  }
}

export function assertHizoFSSymlinkInode({ inode }: {
  inode: HizoFSSymlinkInodeDto;
}): void {
  validateHizoFSStableId({ value: inode.nodeId, fieldName: 'HizoFS symlink nodeId' });
  assertHizoFSNonNegativeSafeInteger({ value: inode.revision, fieldName: 'Symlink revision' });
  assertTimestamp({ value: inode.createdAt, fieldName: 'Symlink createdAt' });
  assertTimestamp({ value: inode.modifiedAt, fieldName: 'Symlink modifiedAt' });
  if (inode.target.includes('\0')) {
    throw new Error('HizoFS symlink target must not contain a null character');
  }
}

export function assertHizoFSFileChunk({ chunk, binaryPayload, chunkSize }: {
  chunk: HizoFSFileChunkDto;
  binaryPayload: Uint8Array;
  chunkSize: number;
}): void {
  const { ...unhandledChunk } = chunk;
  unhandledChunk satisfies Record<PropertyKey, never>;
  if (binaryPayload.byteLength === 0 || binaryPayload.byteLength > chunkSize) {
    throw new Error('HizoFS file chunk payload length is invalid');
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
