import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';
import {
  parseFileSystemId,
  parseMutationId,
  parsePublicationId,
  type FileSystemId,
  type MutationId,
  type PublicationId,
} from '@/00-storage/service/hizofs/00-format/v1/identifiers';
import {
  createCommitSequence,
  createFeatureBits,
  createPublicationSequence,
  createUnlockSequence,
  type CommitSequence,
  type FeatureBits,
  type PublicationSequence,
  type UnlockSequence,
} from '@/00-storage/service/hizofs/00-format/v1/scalars';
import { assertFixedAscii, writeFixedAscii } from './fixed-ascii';
import {
  decodeOptionalHomeRecordReference,
  decodeOptionalPhysicalRecordReference,
  decodeRequiredHomeRecordReference,
  encodeHomeRecordReference,
  encodeOptionalHomeRecordReference,
  encodeOptionalPhysicalRecordReference,
  type HomeRecordReference,
  type PhysicalRecordReference,
} from './record-reference';
import { readU16Be, readU32Be, readU64Be, writeU16Be, writeU32Be, writeU64Be } from './scalars';

const CONSTANTS = HIZOFS_V1_FORMAT_CONSTANTS;
const HEADER_SIZE = CONSTANTS.fixedSizes.superblockHeader;
const PLAINTEXT_SIZE = CONSTANTS.fixedSizes.superblockPlaintext;
const MAGIC = CONSTANTS.magic.superblock;
const FALLBACK_PRESENT = CONSTANTS.flags.superblockFallbackCommitPresent;
const RELOCATION_PRESENT = CONSTANTS.flags.superblockRelocationIndexRootPresent;
const KNOWN_FLAGS = FALLBACK_PRESENT | RELOCATION_PRESENT;
const COMMIT_KIND = CONSTANTS.recordKinds.file_system_commit;
const RELOCATION_KIND = CONSTANTS.recordKinds.relocation_index_page;

export type SuperblockHeaderV1 = Readonly<{
  activeCommitSequence: CommitSequence;
  copy: 0 | 1;
  fileSystemId: FileSystemId;
  flags: number;
  nonce: Uint8Array;
  publicationSequence: PublicationSequence;
}>;

export type SuperblockPlaintextV1 = Readonly<{
  activeCommitHomeRef: HomeRecordReference;
  activeMutationId: MutationId;
  fallbackCommitHomeRef: HomeRecordReference | null;
  minimumUnlockSequence: UnlockSequence;
  publicationId: PublicationId;
  relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
  requiredFeatureBits: FeatureBits;
}>;

function validateHeader({ header }: { header: SuperblockHeaderV1 }): void {
  if (header.copy !== 0 && header.copy !== 1) throw new RangeError('Superblock copy must be 0 or 1');
  if ((header.flags & ~KNOWN_FLAGS) !== 0) throw new TypeError('Superblock has unknown flags');
  if (header.publicationSequence === 0n) throw new RangeError('Superblock publication sequence must be nonzero');
  if (header.activeCommitSequence === 0n) throw new RangeError('Superblock active Commit sequence must be nonzero');
  if (header.nonce.byteLength !== CONSTANTS.crypto.nonceBytes) throw new RangeError('Superblock nonce must be exactly 12 bytes');
  parseFileSystemId({ value: header.fileSystemId });
}

function validatePlaintext({ flags, plaintext }: { flags: number; plaintext: SuperblockPlaintextV1 }): void {
  parseMutationId({ bytes: plaintext.activeMutationId });
  parsePublicationId({ bytes: plaintext.publicationId });
  if ((flags & ~KNOWN_FLAGS) !== 0) throw new TypeError('Superblock has unknown flags');
  if (plaintext.activeCommitHomeRef.recordKind !== COMMIT_KIND) throw new TypeError('Superblock active reference must identify a File System Commit');
  if (plaintext.fallbackCommitHomeRef !== null && plaintext.fallbackCommitHomeRef.recordKind !== COMMIT_KIND) {
    throw new TypeError('Superblock fallback reference must identify a File System Commit');
  }
  if ((plaintext.fallbackCommitHomeRef !== null) !== ((flags & FALLBACK_PRESENT) !== 0)) {
    throw new TypeError('Superblock fallback flag does not match the fallback reference');
  }
  if (plaintext.relocationIndexRootPhysicalRef !== null && plaintext.relocationIndexRootPhysicalRef.recordKind !== RELOCATION_KIND) {
    throw new TypeError('Superblock relocation root must identify a Relocation Index Page');
  }
  if ((plaintext.relocationIndexRootPhysicalRef !== null) !== ((flags & RELOCATION_PRESENT) !== 0)) {
    throw new TypeError('Superblock relocation flag does not match the relocation reference');
  }
  if (plaintext.minimumUnlockSequence === 0n) throw new RangeError('Superblock minimum Unlock sequence must be nonzero');
}

export function createSuperblockHeader({
  activeCommitSequence,
  copy,
  fileSystemId,
  flags,
  nonce,
  publicationSequence,
}: {
  activeCommitSequence: CommitSequence;
  copy: 0 | 1;
  fileSystemId: FileSystemId;
  flags: number;
  nonce: Uint8Array;
  publicationSequence: PublicationSequence;
}): SuperblockHeaderV1 {
  const header: SuperblockHeaderV1 = {
    activeCommitSequence: createCommitSequence({ value: activeCommitSequence }),
    copy,
    fileSystemId: parseFileSystemId({ value: fileSystemId }),
    flags,
    nonce: Uint8Array.from(nonce),
    publicationSequence: createPublicationSequence({ value: publicationSequence }),
  };
  validateHeader({ header });
  return header;
}

export function encodeSuperblockHeader({ header }: { header: SuperblockHeaderV1 }): Uint8Array {
  validateHeader({ header });
  const bytes = new Uint8Array(HEADER_SIZE);
  writeFixedAscii({ bytes, offset: 0, value: MAGIC });
  writeU16Be({ bytes, offset: 8, value: CONSTANTS.formatVersion });
  writeU16Be({ bytes, offset: 10, value: HEADER_SIZE });
  bytes[12] = header.copy;
  bytes[13] = header.flags;
  writeU64Be({ bytes, offset: 16, value: header.publicationSequence });
  writeU64Be({ bytes, offset: 24, value: header.activeCommitSequence });
  writeU32Be({ bytes, offset: 32, value: PLAINTEXT_SIZE });
  bytes[36] = CONSTANTS.limits.fileSystemIdCharacters;
  writeFixedAscii({ bytes, offset: 37, value: header.fileSystemId });
  bytes.set(header.nonce, 58);
  return bytes;
}

export function decodeSuperblockHeader({ bytes }: { bytes: Uint8Array }): SuperblockHeaderV1 {
  if (bytes.byteLength !== HEADER_SIZE) throw new RangeError(`Superblock Header must be exactly ${HEADER_SIZE} bytes`);
  assertFixedAscii({ bytes, offset: 0, value: MAGIC });
  if (readU16Be({ bytes, offset: 8 }) !== CONSTANTS.formatVersion) throw new TypeError('Superblock format version is unsupported');
  if (readU16Be({ bytes, offset: 10 }) !== HEADER_SIZE) throw new TypeError('Superblock Header length is invalid');
  if (bytes[14] !== 0 || bytes[15] !== 0) throw new TypeError('Superblock reserved bytes must be zero');
  if (readU32Be({ bytes, offset: 32 }) !== PLAINTEXT_SIZE) throw new TypeError('Superblock plaintext length is invalid');
  if (bytes[36] !== CONSTANTS.limits.fileSystemIdCharacters) throw new TypeError('Superblock File System ID length is invalid');
  for (let index = 70; index < 80; index += 1) if (bytes[index] !== 0) throw new TypeError('Superblock reserved bytes must be zero');
  const copy = bytes[12];
  const flags = bytes[13];
  if ((copy !== 0 && copy !== 1) || flags === undefined) throw new TypeError('Superblock copy/flags are invalid');
  const header: SuperblockHeaderV1 = {
    activeCommitSequence: createCommitSequence({ value: readU64Be({ bytes, offset: 24 }) }),
    copy,
    fileSystemId: parseFileSystemId({ value: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(37, 58)) }),
    flags,
    nonce: bytes.slice(58, 70),
    publicationSequence: createPublicationSequence({ value: readU64Be({ bytes, offset: 16 }) }),
  };
  validateHeader({ header });
  return header;
}

export function encodeSuperblockPlaintext({ flags, plaintext }: { flags: number; plaintext: SuperblockPlaintextV1 }): Uint8Array {
  validatePlaintext({ flags, plaintext });
  const bytes = new Uint8Array(PLAINTEXT_SIZE);
  bytes.set(encodeHomeRecordReference({ reference: plaintext.activeCommitHomeRef }), 0);
  bytes.set(encodeOptionalHomeRecordReference({ reference: plaintext.fallbackCommitHomeRef }), 32);
  bytes.set(encodeOptionalPhysicalRecordReference({ reference: plaintext.relocationIndexRootPhysicalRef }), 64);
  bytes.set(plaintext.activeMutationId, 96);
  bytes.set(plaintext.publicationId, 112);
  writeU64Be({ bytes, offset: 128, value: plaintext.minimumUnlockSequence });
  writeU64Be({ bytes, offset: 136, value: plaintext.requiredFeatureBits });
  return bytes;
}

export function decodeSuperblockPlaintext({ bytes, flags }: { bytes: Uint8Array; flags: number }): SuperblockPlaintextV1 {
  if (bytes.byteLength !== PLAINTEXT_SIZE) throw new RangeError(`Superblock plaintext must be exactly ${PLAINTEXT_SIZE} bytes`);
  const plaintext: SuperblockPlaintextV1 = {
    activeCommitHomeRef: decodeRequiredHomeRecordReference({ bytes: bytes.subarray(0, 32) }),
    activeMutationId: parseMutationId({ bytes: bytes.subarray(96, 112) }),
    fallbackCommitHomeRef: decodeOptionalHomeRecordReference({ bytes: bytes.subarray(32, 64) }),
    minimumUnlockSequence: createUnlockSequence({ value: readU64Be({ bytes, offset: 128 }) }),
    publicationId: parsePublicationId({ bytes: bytes.subarray(112, 128) }),
    relocationIndexRootPhysicalRef: decodeOptionalPhysicalRecordReference({ bytes: bytes.subarray(64, 96) }),
    requiredFeatureBits: createFeatureBits({ value: readU64Be({ bytes, offset: 136 }) }),
  };
  validatePlaintext({ flags, plaintext });
  return plaintext;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
