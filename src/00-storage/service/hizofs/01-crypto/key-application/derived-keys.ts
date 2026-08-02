import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  encodeRecordKeyContext,
  encodeSegmentFooterKeyContext,
  encodeSegmentHeaderKeyContext,
  encodeSuperblockKeyContext,
  encodeUnlockAuthenticatorKeyContext,
  parseFileSystemId,
  parseSegmentId,
  type FileSystemId,
  type SegmentId,
  type PublicationSequence,
  type UnlockSequence,
} from '@/00-storage/service/hizofs/00-format';
import { deriveRootKeyAesGcmKey, type FileSystemRootKey } from '@/00-storage/service/hizofs/01-crypto/secret-types';

function validateCopyAndSequence({ copy, label, sequence }: { copy: number; label: string; sequence: PublicationSequence | UnlockSequence }): void {
  if (copy !== 0 && copy !== 1) throw new RangeError(`${label} copy must be 0 or 1`);
  if (sequence < 1n) throw new RangeError(`${label} sequence must be at least 1`);
}

export async function deriveUnlockAuthenticatorKey({ copy, fileSystemId, rootKey, unlockSequence }: {
  copy: 0 | 1;
  fileSystemId: FileSystemId;
  rootKey: FileSystemRootKey;
  unlockSequence: UnlockSequence;
}): Promise<CryptoKey> {
  validateCopyAndSequence({ copy, label: 'Unlock', sequence: unlockSequence });
  parseFileSystemId({ value: fileSystemId });
  return await deriveRootKeyAesGcmKey({
    info: encodeUnlockAuthenticatorKeyContext({ copy, fileSystemId, unlockSequence }),
    rootKey,
  });
}

export async function deriveSuperblockKey({ copy, fileSystemId, publicationSequence, rootKey }: {
  copy: 0 | 1;
  fileSystemId: FileSystemId;
  publicationSequence: PublicationSequence;
  rootKey: FileSystemRootKey;
}): Promise<CryptoKey> {
  validateCopyAndSequence({ copy, label: 'Superblock publication', sequence: publicationSequence });
  parseFileSystemId({ value: fileSystemId });
  return await deriveRootKeyAesGcmKey({
    info: encodeSuperblockKeyContext({ copy, fileSystemId, publicationSequence }),
    rootKey,
  });
}

export async function deriveSegmentHeaderKey({ fileSystemId, physicalSegmentId, rootKey, segmentClass }: {
  fileSystemId: FileSystemId;
  physicalSegmentId: SegmentId;
  rootKey: FileSystemRootKey;
  segmentClass: number;
}): Promise<CryptoKey> {
  parseFileSystemId({ value: fileSystemId });
  parseSegmentId({ bytes: physicalSegmentId });
  const classes = HIZOFS_V1_FORMAT_CONSTANTS.container.segmentClasses;
  if (segmentClass !== classes.metadata && segmentClass !== classes.data) {
    throw new RangeError('segment class must be a registered V1 segment class');
  }
  return await deriveRootKeyAesGcmKey({
    info: encodeSegmentHeaderKeyContext({ fileSystemId, physicalSegmentId, segmentClass }),
    rootKey,
  });
}

export async function deriveRecordKey({ fileSystemId, homeSegmentId, rootKey }: {
  fileSystemId: FileSystemId;
  homeSegmentId: SegmentId;
  rootKey: FileSystemRootKey;
}): Promise<CryptoKey> {
  parseFileSystemId({ value: fileSystemId });
  parseSegmentId({ bytes: homeSegmentId });
  return await deriveRootKeyAesGcmKey({ info: encodeRecordKeyContext({ fileSystemId, homeSegmentId }), rootKey });
}

export async function deriveSegmentFooterKey({ fileSystemId, physicalSegmentId, rootKey }: {
  fileSystemId: FileSystemId;
  physicalSegmentId: SegmentId;
  rootKey: FileSystemRootKey;
}): Promise<CryptoKey> {
  parseFileSystemId({ value: fileSystemId });
  parseSegmentId({ bytes: physicalSegmentId });
  return await deriveRootKeyAesGcmKey({ info: encodeSegmentFooterKeyContext({ fileSystemId, physicalSegmentId }), rootKey });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
