import { describe, expect, it } from 'vitest';
import {
  createHomeRecordReference,
  createPhysicalRecordReference,
} from '@/00-storage/service/hizofs/00-format/v1/binary/record-reference';
import {
  createSuperblockHeader,
  decodeSuperblockHeader,
  decodeSuperblockPlaintext,
  encodeSuperblockHeader,
  encodeSuperblockPlaintext,
} from '@/00-storage/service/hizofs/00-format/v1/binary/superblock';
import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';
import { parseFileSystemId, parseMutationId, parsePublicationId, parseSegmentId } from '@/00-storage/service/hizofs/00-format/v1/identifiers';
import { createUInt64 } from '@/00-storage/service/hizofs/00-format/v1/scalars';

const segmentId = () => parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => index + 1) });
const homeCommit = (offset: bigint) => createHomeRecordReference({ fields: {
  byteOffset: createUInt64({ value: offset }),
  frameLength: 96,
  recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
  segmentId: segmentId(),
} });

describe('Superblock codecs', () => {
  it('round-trips exact header and plaintext with optional references', () => {
    const flags = HIZOFS_V1_FORMAT_CONSTANTS.flags.superblockFallbackCommitPresent
      | HIZOFS_V1_FORMAT_CONSTANTS.flags.superblockRelocationIndexRootPresent;
    const header = createSuperblockHeader({
      activeCommitSequence: createUInt64({ value: 7n }),
      copy: 1,
      fileSystemId: parseFileSystemId({ value: '0123456789_ABCDEFGHIJ' }),
      flags,
      nonce: Uint8Array.from({ length: 12 }, (_, index) => index + 1),
      publicationSequence: createUInt64({ value: 9n }),
    });
    expect(decodeSuperblockHeader({ bytes: encodeSuperblockHeader({ header }) })).toEqual(header);

    const plaintext = {
      activeCommitHomeRef: homeCommit(64n),
      activeMutationId: parseMutationId({ bytes: new Uint8Array(16).fill(3) }),
      fallbackCommitHomeRef: homeCommit(160n),
      minimumUnlockSequence: createUInt64({ value: 2n }),
      publicationId: parsePublicationId({ bytes: new Uint8Array(16).fill(4) }),
      relocationIndexRootPhysicalRef: createPhysicalRecordReference({ fields: {
        byteOffset: createUInt64({ value: 256n }),
        frameLength: 88,
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.relocation_index_page,
        segmentId: segmentId(),
      } }),
      requiredFeatureBits: createUInt64({ value: 0n }),
    };
    expect(decodeSuperblockPlaintext({ bytes: encodeSuperblockPlaintext({ flags, plaintext }), flags })).toEqual(plaintext);
  });

  it('rejects runtime-cast zero identities before writing', () => {
    expect(() => encodeSuperblockPlaintext({
      flags: 0,
      plaintext: {
        activeCommitHomeRef: homeCommit(64n),
        activeMutationId: new Uint8Array(16) as never,
        fallbackCommitHomeRef: null,
        minimumUnlockSequence: createUInt64({ value: 1n }),
        publicationId: parsePublicationId({ bytes: new Uint8Array(16).fill(4) }),
        relocationIndexRootPhysicalRef: null,
        requiredFeatureBits: createUInt64({ value: 0n }),
      },
    })).toThrow('all-zero'); // runtime-cast all-zero Mutation ID
  });

  it('rejects flag/reference mismatch and structural header corruption', () => {
    const plaintext = {
      activeCommitHomeRef: homeCommit(64n),
      activeMutationId: parseMutationId({ bytes: new Uint8Array(16).fill(3) }),
      fallbackCommitHomeRef: null,
      minimumUnlockSequence: createUInt64({ value: 1n }),
      publicationId: parsePublicationId({ bytes: new Uint8Array(16).fill(4) }),
      relocationIndexRootPhysicalRef: null,
      requiredFeatureBits: createUInt64({ value: 0n }),
    };
    expect(() => encodeSuperblockPlaintext({
      flags: HIZOFS_V1_FORMAT_CONSTANTS.flags.superblockFallbackCommitPresent,
      plaintext,
    })).toThrow('fallback flag');

    const header = createSuperblockHeader({
      activeCommitSequence: createUInt64({ value: 1n }),
      copy: 0,
      fileSystemId: parseFileSystemId({ value: '0123456789_ABCDEFGHIJ' }),
      flags: 0,
      nonce: new Uint8Array(12),
      publicationSequence: createUInt64({ value: 1n }),
    });
    const bytes = encodeSuperblockHeader({ header });
    bytes[79] = 1;
    expect(() => decodeSuperblockHeader({ bytes })).toThrow('reserved');
  });
});
