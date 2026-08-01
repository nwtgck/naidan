import type { RecordFrameHeaderV1 } from '@/00-storage/service/hizofs/00-format/v1/binary/record-frame-header';
import type {
  HomeRecordReference,
  PhysicalRecordReference,
} from '@/00-storage/service/hizofs/00-format/v1/binary/record-reference';
import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';
import type { MutationId, SegmentId } from '@/00-storage/service/hizofs/00-format/v1/identifiers';
import { compareUnsignedBytes } from '@/00-storage/service/hizofs/00-format/v1/ordering/unsigned-bytes';
import type { FileExtentLeafEntry } from '@/00-storage/service/hizofs/00-format/v1/pages/fixed-pages';
import type { FileSystemCommitPayload } from '@/00-storage/service/hizofs/00-format/v1/records/file-system-commit';
import type { CommitSequence, FileOffset } from '@/00-storage/service/hizofs/00-format/v1/scalars';

export function validateActiveCommitAuthority({
  activeCommitSequence,
  activeMutationId,
  commit,
}: {
  activeCommitSequence: CommitSequence;
  activeMutationId: MutationId;
  commit: FileSystemCommitPayload;
}): void {
  if (commit.commitSequence !== activeCommitSequence) {
    throw new TypeError('active Commit Sequence does not match the Superblock authority');
  }
  if (compareUnsignedBytes({ left: commit.mutationId, right: activeMutationId }) !== 0) {
    throw new TypeError('active Commit Mutation ID does not match the Superblock authority');
  }
}

export function validateFallbackCommitAuthority({
  activeCommitSequence,
  commit,
}: {
  activeCommitSequence: CommitSequence;
  commit: FileSystemCommitPayload;
}): void {
  if (activeCommitSequence < 2n || commit.commitSequence + 1n !== activeCommitSequence) {
    throw new TypeError('fallback Commit Sequence must be exactly active minus one');
  }
}

export function validateExtentAgainstReferencedData({
  entry,
  fileDataPlaintextLength,
  inodeFileSize,
}: {
  entry: FileExtentLeafEntry;
  fileDataPlaintextLength: number;
  inodeFileSize: FileOffset;
}): void {
  if (!Number.isInteger(fileDataPlaintextLength) || fileDataPlaintextLength < 1
    || fileDataPlaintextLength > HIZOFS_V1_FORMAT_CONSTANTS.limits.fileDataPlaintextBytes) {
    throw new RangeError('authenticated File Data plaintext length is invalid');
  }
  if (entry.dataOffset + entry.byteLength > fileDataPlaintextLength) {
    throw new RangeError('extent data range exceeds the authenticated File Data payload');
  }
  if (entry.fileOffset + BigInt(entry.byteLength) > inodeFileSize) {
    throw new RangeError('extent range exceeds the inode fileSize');
  }
}

function assertSameHomeIdentity({
  header,
  homeReference,
}: {
  header: RecordFrameHeaderV1;
  homeReference: HomeRecordReference;
}): void {
  if (compareUnsignedBytes({ left: header.homeSegmentId, right: homeReference.segmentId }) !== 0
    || header.homeOffset !== homeReference.byteOffset) {
    throw new TypeError('authenticated frame home identity does not match the Home Record Reference');
  }
}

export function validatePhysicalOnlyRecordIdentity({
  authenticatedHeader,
  physicalOffset,
  physicalSegmentId,
}: {
  authenticatedHeader: RecordFrameHeaderV1;
  physicalOffset: bigint;
  physicalSegmentId: SegmentId;
}): void {
  if (authenticatedHeader.recordKind !== HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page
    || authenticatedHeader.flags !== HIZOFS_V1_FORMAT_CONSTANTS.flags.recordPhysicalOnly) {
    throw new TypeError('physical-only Record Frame must be a Relocation Index page');
  }
  if (compareUnsignedBytes({ left: authenticatedHeader.homeSegmentId, right: physicalSegmentId }) !== 0
    || authenticatedHeader.homeOffset !== physicalOffset) {
    throw new TypeError('physical-only Record Frame home identity must equal its physical location');
  }
}


export function validateRelocationMapping({
  authenticatedHeader,
  homeReference,
  mappedPhysicalReference,
}: {
  authenticatedHeader: RecordFrameHeaderV1;
  homeReference: HomeRecordReference;
  mappedPhysicalReference: PhysicalRecordReference;
}): void {
  if (homeReference.recordKind === HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page) {
    throw new TypeError('Relocation Index pages are bootstrap physical records and must not be relocated');
  }
  if (mappedPhysicalReference.recordKind !== homeReference.recordKind
    || mappedPhysicalReference.frameLength !== homeReference.frameLength) {
    throw new TypeError('relocation mapping changes logical record kind or frame length');
  }
  if (authenticatedHeader.recordKind !== homeReference.recordKind
    || authenticatedHeader.frameLength !== homeReference.frameLength) {
    throw new TypeError('authenticated relocated frame does not match the logical Home Record Reference');
  }
  if (authenticatedHeader.flags !== 0) {
    throw new TypeError('relocation mapping target must be an ordinary logical record');
  }
  assertSameHomeIdentity({ header: authenticatedHeader, homeReference });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
