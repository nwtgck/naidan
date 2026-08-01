import type {
  CommitSequence,
  FileOffset,
  InodeNumber,
  PublicationSequence,
  SubvolumeId,
  UInt64,
  UnlockSequence,
} from '@/00-storage/service/hizofs/00-format';

declare const commitSequence: CommitSequence;
declare const fileOffset: FileOffset;
declare const inodeNumber: InodeNumber;
declare const publicationSequence: PublicationSequence;
declare const subvolumeId: SubvolumeId;
declare const uint64: UInt64;
declare const unlockSequence: UnlockSequence;

const acceptedCommitSequence: CommitSequence = commitSequence;
const acceptedFileOffset: FileOffset = fileOffset;
const acceptedInodeNumber: InodeNumber = inodeNumber;
const acceptedPublicationSequence: PublicationSequence = publicationSequence;
const acceptedSubvolumeId: SubvolumeId = subvolumeId;
const acceptedUnlockSequence: UnlockSequence = unlockSequence;

// @ts-expect-error Inode Numbers are not Publication Sequences.
const rejectedPublicationSequence: PublicationSequence = inodeNumber;
// @ts-expect-error Subvolume IDs are not Inode Numbers.
const rejectedInodeNumber: InodeNumber = subvolumeId;
// @ts-expect-error Generic u64 values are not File Offsets.
const rejectedFileOffset: FileOffset = uint64;
// @ts-expect-error Commit Sequences are not Unlock Sequences.
const rejectedUnlockSequence: UnlockSequence = commitSequence;

void [
  acceptedCommitSequence,
  acceptedFileOffset,
  acceptedInodeNumber,
  acceptedPublicationSequence,
  acceptedSubvolumeId,
  acceptedUnlockSequence,
  rejectedFileOffset,
  rejectedInodeNumber,
  rejectedPublicationSequence,
  rejectedUnlockSequence,
];

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
