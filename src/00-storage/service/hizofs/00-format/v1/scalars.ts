import { HIZOFS_V1_FORMAT_CONSTANTS } from './format-constants';

declare const uint64Brand: unique symbol;
declare const timestampMillisecondsBrand: unique symbol;
declare const commitSequenceBrand: unique symbol;
declare const publicationSequenceBrand: unique symbol;
declare const unlockSequenceBrand: unique symbol;
declare const inodeNumberBrand: unique symbol;
declare const inodeRevisionBrand: unique symbol;
declare const subvolumeIdBrand: unique symbol;
declare const fileOffsetBrand: unique symbol;
declare const featureBitsBrand: unique symbol;

export type UInt64 = bigint & { readonly [uint64Brand]: true };
export type TimestampMilliseconds = bigint & { readonly [timestampMillisecondsBrand]: true };
export type CommitSequence = UInt64 & { readonly [commitSequenceBrand]: true };
export type PublicationSequence = UInt64 & { readonly [publicationSequenceBrand]: true };
export type UnlockSequence = UInt64 & { readonly [unlockSequenceBrand]: true };
export type InodeNumber = UInt64 & { readonly [inodeNumberBrand]: true };
export type InodeRevision = UInt64 & { readonly [inodeRevisionBrand]: true };
export type SubvolumeId = UInt64 & { readonly [subvolumeIdBrand]: true };
export type FileOffset = UInt64 & { readonly [fileOffsetBrand]: true };
export type FeatureBits = UInt64 & { readonly [featureBitsBrand]: true };

export const UINT64_MAXIMUM = (1n << 64n) - 1n;
export const TIMESTAMP_MILLISECONDS_MINIMUM = BigInt(HIZOFS_V1_FORMAT_CONSTANTS.limits.timestampMillisecondsMinimum);
export const TIMESTAMP_MILLISECONDS_MAXIMUM = BigInt(HIZOFS_V1_FORMAT_CONSTANTS.limits.timestampMillisecondsMaximum);

export function createUInt64({ value }: { value: bigint }): UInt64 {
  if (value < 0n || value > UINT64_MAXIMUM) throw new RangeError('UInt64 is outside 0..2^64-1');
  return value as UInt64;
}

function createPositiveUInt64<T extends UInt64>({ label, value }: { label: string; value: bigint }): T {
  const parsed = createUInt64({ value });
  if (parsed < 1n) throw new RangeError(`${label} must be at least 1`);
  return parsed as T;
}

export function createCommitSequence({ value }: { value: bigint }): CommitSequence {
  return createPositiveUInt64<CommitSequence>({ label: 'Commit Sequence', value });
}
export function createPublicationSequence({ value }: { value: bigint }): PublicationSequence {
  return createPositiveUInt64<PublicationSequence>({ label: 'Publication Sequence', value });
}
export function createUnlockSequence({ value }: { value: bigint }): UnlockSequence {
  return createPositiveUInt64<UnlockSequence>({ label: 'Unlock Sequence', value });
}
export function createInodeNumber({ value }: { value: bigint }): InodeNumber {
  return createPositiveUInt64<InodeNumber>({ label: 'Inode Number', value });
}
export function createInodeRevision({ value }: { value: bigint }): InodeRevision {
  return createPositiveUInt64<InodeRevision>({ label: 'Inode Revision', value });
}
export function createSubvolumeId({ value }: { value: bigint }): SubvolumeId {
  return createPositiveUInt64<SubvolumeId>({ label: 'Subvolume ID', value });
}
export function createFileOffset({ value }: { value: bigint }): FileOffset {
  return createUInt64({ value }) as FileOffset;
}
export function createFeatureBits({ value }: { value: bigint }): FeatureBits {
  return createUInt64({ value }) as FeatureBits;
}

export function createTimestampMilliseconds({ value }: { value: bigint }): TimestampMilliseconds {
  if (value < TIMESTAMP_MILLISECONDS_MINIMUM || value > TIMESTAMP_MILLISECONDS_MAXIMUM) {
    throw new RangeError('timestamp milliseconds is outside the HizoFS V1 range');
  }
  return value as TimestampMilliseconds;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
