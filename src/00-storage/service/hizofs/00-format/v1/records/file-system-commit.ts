import {
  assertHomeRecordReferenceValid,
  createHomeRecordReference,
  decodeOptionalHomeRecordReference,
  decodeRequiredHomeRecordReference,
  encodeOptionalHomeRecordReference,
  encodeHomeRecordReference,
  sameRecordReferenceFields,
  type HomeRecordReference,
} from '@/00-storage/service/hizofs/00-format/v1/binary/record-reference';
import { readU64Be, writeU64Be } from '@/00-storage/service/hizofs/00-format/v1/binary/scalars';
import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';
import { parseMutationId, type MutationId } from '@/00-storage/service/hizofs/00-format/v1/identifiers';
import {
  createCommitSequence,
  createInodeNumber,
  createSubvolumeId,
  type CommitSequence,
  type InodeNumber,
  type SubvolumeId,
} from '@/00-storage/service/hizofs/00-format/v1/scalars';

const SIZE = HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes.fileSystemCommitPayload;
const RECORD_KINDS = HIZOFS_V1_FORMAT_CONSTANTS.recordKinds;

export type FileSystemCommitPayload = Readonly<{
  commitSequence: CommitSequence;
  mutationId: MutationId;
  nestedSubvolumeTableRootHomeRef: HomeRecordReference | null;
  nextInodeNumber: InodeNumber;
  nextSubvolumeId: SubvolumeId;
  rootDirectoryInodeNumber: InodeNumber;
  rootInodeTableRootHomeRef: HomeRecordReference;
}>;

function validateReferenceKind({ expectedKind, label, reference }: {
  expectedKind: number;
  label: string;
  reference: HomeRecordReference;
}): void {
  if (reference.recordKind !== expectedKind) throw new TypeError(`${label} has the wrong record kind`);
}

function validatePayload({ payload }: { payload: FileSystemCommitPayload }): void {
  parseMutationId({ bytes: payload.mutationId });
  if (payload.commitSequence < 1n) throw new RangeError('Commit Sequence must be at least 1');
  if (payload.rootDirectoryInodeNumber < 1n) throw new RangeError('root directory Inode Number must be at least 1');
  if (payload.nextInodeNumber < 2n) throw new RangeError('next Inode Number must be at least 2');
  if (payload.nextSubvolumeId < 2n) throw new RangeError('next Subvolume ID must be at least 2');
  validateReferenceKind({
    expectedKind: RECORD_KINDS.inode_table_page,
    label: 'root Inode Table reference',
    reference: payload.rootInodeTableRootHomeRef,
  });
  if (payload.nestedSubvolumeTableRootHomeRef !== null) {
    validateReferenceKind({
      expectedKind: RECORD_KINDS.nested_subvolume_table_page,
      label: 'nested Subvolume Table reference',
      reference: payload.nestedSubvolumeTableRootHomeRef,
    });
  }
}

export function encodeFileSystemCommitPayload({ payload }: { payload: FileSystemCommitPayload }): Uint8Array {
  validatePayload({ payload });
  const bytes = new Uint8Array(SIZE);
  writeU64Be({ bytes, offset: 0, value: payload.commitSequence });
  bytes.set(payload.mutationId, 8);
  writeU64Be({ bytes, offset: 24, value: payload.rootDirectoryInodeNumber });
  bytes.set(encodeHomeRecordReference({ reference: payload.rootInodeTableRootHomeRef }), 32);
  bytes.set(encodeOptionalHomeRecordReference({ reference: payload.nestedSubvolumeTableRootHomeRef }), 64);
  writeU64Be({ bytes, offset: 96, value: payload.nextInodeNumber });
  writeU64Be({ bytes, offset: 104, value: payload.nextSubvolumeId });
  return bytes;
}

export function decodeFileSystemCommitPayload({ bytes }: { bytes: Uint8Array }): FileSystemCommitPayload {
  if (bytes.byteLength !== SIZE) throw new RangeError(`File System Commit payload must be exactly ${SIZE} bytes`);
  const payload: FileSystemCommitPayload = {
    commitSequence: createCommitSequence({ value: readU64Be({ bytes, offset: 0 }) }),
    mutationId: parseMutationId({ bytes: bytes.subarray(8, 24) }),
    rootDirectoryInodeNumber: createInodeNumber({ value: readU64Be({ bytes, offset: 24 }) }),
    rootInodeTableRootHomeRef: decodeRequiredHomeRecordReference({ bytes: bytes.subarray(32, 64) }),
    nestedSubvolumeTableRootHomeRef: decodeOptionalHomeRecordReference({ bytes: bytes.subarray(64, 96) }),
    nextInodeNumber: createInodeNumber({ value: readU64Be({ bytes, offset: 96 }) }),
    nextSubvolumeId: createSubvolumeId({ value: readU64Be({ bytes, offset: 104 }) }),
  };
  validatePayload({ payload });
  return payload;
}

export function createFileSystemCommitPayload({ payload }: { payload: FileSystemCommitPayload }): FileSystemCommitPayload {
  validatePayload({ payload });
  return {
    ...payload,
    commitSequence: createCommitSequence({ value: payload.commitSequence }),
    mutationId: parseMutationId({ bytes: payload.mutationId }),
    nextInodeNumber: createInodeNumber({ value: payload.nextInodeNumber }),
    nextSubvolumeId: createSubvolumeId({ value: payload.nextSubvolumeId }),
    rootDirectoryInodeNumber: createInodeNumber({ value: payload.rootDirectoryInodeNumber }),
  };
}

export function copyFileSystemCommitPayload({ payload }: { payload: FileSystemCommitPayload }): FileSystemCommitPayload {
  validatePayload({ payload });
  return {
    commitSequence: createCommitSequence({ value: payload.commitSequence }),
    mutationId: parseMutationId({ bytes: payload.mutationId }),
    nestedSubvolumeTableRootHomeRef: payload.nestedSubvolumeTableRootHomeRef === null
      ? null
      : createHomeRecordReference({ fields: payload.nestedSubvolumeTableRootHomeRef }),
    nextInodeNumber: createInodeNumber({ value: payload.nextInodeNumber }),
    nextSubvolumeId: createSubvolumeId({ value: payload.nextSubvolumeId }),
    rootDirectoryInodeNumber: createInodeNumber({ value: payload.rootDirectoryInodeNumber }),
    rootInodeTableRootHomeRef: createHomeRecordReference({ fields: payload.rootInodeTableRootHomeRef }),
  };
}

function bytesEqual({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function sameFileSystemCommitPayloadFields({ left, right }: {
  left: FileSystemCommitPayload;
  right: FileSystemCommitPayload;
}): boolean {
  // Preserve the fail-closed canonical-encoding boundary while avoiding two
  // throwaway 112-byte payload buffers on hot runtime authority comparisons.
  validatePayload({ payload: left });
  validatePayload({ payload: right });
  assertHomeRecordReferenceValid({ reference: left.rootInodeTableRootHomeRef });
  assertHomeRecordReferenceValid({ reference: right.rootInodeTableRootHomeRef });
  const leftNested = left.nestedSubvolumeTableRootHomeRef;
  const rightNested = right.nestedSubvolumeTableRootHomeRef;
  if (leftNested !== null) assertHomeRecordReferenceValid({ reference: leftNested });
  if (rightNested !== null) assertHomeRecordReferenceValid({ reference: rightNested });
  return left.commitSequence === right.commitSequence
    && bytesEqual({ left: left.mutationId, right: right.mutationId })
    && left.rootDirectoryInodeNumber === right.rootDirectoryInodeNumber
    && sameRecordReferenceFields({ left: left.rootInodeTableRootHomeRef, right: right.rootInodeTableRootHomeRef })
    && ((leftNested === null && rightNested === null)
      || (leftNested !== null && rightNested !== null && sameRecordReferenceFields({ left: leftNested, right: rightNested })))
    && left.nextInodeNumber === right.nextInodeNumber
    && left.nextSubvolumeId === right.nextSubvolumeId;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
