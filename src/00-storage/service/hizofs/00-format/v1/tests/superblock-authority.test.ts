import { describe, expect, it } from 'vitest';
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  assertMutationSuperblockPublicationTransition,
  createCommitSequence,
  createFeatureBits,
  createHomeRecordReference,
  createPublicationSequence,
  createSuperblockHeader,
  createUInt64,
  createUnlockSequence,
  parseFileSystemId,
  parseMutationId,
  parsePublicationId,
  parseSegmentId,
  resolveSuperblockPublicationAuthority,
  selectSuperblockAuthority,
  superblockFlagsForLogicalState,
  superblockMutationPublicationFailureOutcome,
  type AuthenticatedSuperblockCopy,
  type SuperblockLogicalState,
} from '@/00-storage/service/hizofs/00-format';

function logicalState({ requiredFeatureBits }: { requiredFeatureBits: bigint }): SuperblockLogicalState {
  return {
    activeCommitHomeRef: createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: 64n }),
      frameLength: 96,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
      segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(7) }),
    } }),
    activeCommitSequence: createCommitSequence({ value: 1n }),
    activeMutationId: parseMutationId({ bytes: new Uint8Array(16).fill(3) }),
    fallbackCommitHomeRef: null,
    minimumUnlockSequence: createUnlockSequence({ value: 1n }),
    relocationIndexRootPhysicalRef: null,
    requiredFeatureBits: createFeatureBits({ value: requiredFeatureBits }),
  };
}

function copy({ logicalState: state, physicalCopy, publicationSequence }: {
  logicalState: SuperblockLogicalState;
  physicalCopy: 0 | 1;
  publicationSequence: bigint;
}): AuthenticatedSuperblockCopy {
  const publicationId = parsePublicationId({ bytes: new Uint8Array(16).fill(Number(publicationSequence)) });
  return {
    header: createSuperblockHeader({
      activeCommitSequence: state.activeCommitSequence,
      copy: physicalCopy,
      fileSystemId: parseFileSystemId({ value: 'Zbcdefghij_klmnopq-12' }),
      flags: superblockFlagsForLogicalState({ logicalState: state }),
      nonce: new Uint8Array(12).fill(physicalCopy + 1),
      publicationSequence: createPublicationSequence({ value: publicationSequence }),
    }),
    logicalState: state,
    physicalCopy,
    plaintext: {
      activeCommitHomeRef: state.activeCommitHomeRef,
      activeMutationId: state.activeMutationId,
      fallbackCommitHomeRef: state.fallbackCommitHomeRef,
      minimumUnlockSequence: state.minimumUnlockSequence,
      publicationId,
      relocationIndexRootPhysicalRef: state.relocationIndexRootPhysicalRef,
      requiredFeatureBits: state.requiredFeatureBits,
    },
  };
}

describe('HizoFS V1 Superblock authority', () => {
  it('selects the highest sequence and preserves unsupported historical-root evidence', () => {
    const supported = logicalState({ requiredFeatureBits: 0n });
    const historical = logicalState({ requiredFeatureBits: 2n });
    const result = selectSuperblockAuthority({
      results: [
        { copy: copy({ logicalState: supported, physicalCopy: 0, publicationSequence: 4n }), kind: 'valid' },
        { copy: copy({ logicalState: historical, physicalCopy: 1, publicationSequence: 3n }), kind: 'valid' },
      ],
      supportedFeatureBits: createFeatureBits({ value: 1n }),
    });
    expect(result).toMatchObject({
      opened: {
        copyState: 'superblock_redundancy_degraded',
        historicalRootFeatureState: 'unsupported',
        selectedCopy: 0,
        selectedPublicationSequence: 4n,
      },
      type: 'selected',
    });
  });

  it('rejects same-sequence reuse and unsupported selected authority', () => {
    const state = logicalState({ requiredFeatureBits: 0n });
    expect(selectSuperblockAuthority({
      results: [
        { copy: copy({ logicalState: state, physicalCopy: 0, publicationSequence: 4n }), kind: 'valid' },
        { copy: copy({ logicalState: state, physicalCopy: 1, publicationSequence: 4n }), kind: 'valid' },
      ],
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    })).toEqual({ type: 'sequence_reuse_conflict' });
    expect(selectSuperblockAuthority({
      results: [{
        copy: copy({ logicalState: logicalState({ requiredFeatureBits: 2n }), physicalCopy: 0, publicationSequence: 4n }),
        kind: 'valid',
      }],
      supportedFeatureBits: createFeatureBits({ value: 1n }),
    })).toEqual({ type: 'unsupported_required_feature' });
  });

  it('owns publication transition and response-loss semantics', () => {
    const state = logicalState({ requiredFeatureBits: 0n });
    const selected = selectSuperblockAuthority({
      results: [{ copy: copy({ logicalState: state, physicalCopy: 0, publicationSequence: 4n }), kind: 'valid' }],
      supportedFeatureBits: createFeatureBits({ value: 0n }),
    });
    if (selected.type !== 'selected') throw new Error('expected selected Superblock authority');
    const intended: SuperblockLogicalState = {
      ...state,
      activeCommitSequence: createCommitSequence({ value: 2n }),
      activeMutationId: parseMutationId({ bytes: new Uint8Array(16).fill(5) }),
      fallbackCommitHomeRef: state.activeCommitHomeRef,
    };
    expect(() => assertMutationSuperblockPublicationTransition({
      base: selected.opened,
      firstPublicationSequence: createPublicationSequence({ value: 5n }),
      logicalState: intended,
      secondPublicationSequence: createPublicationSequence({ value: 6n }),
    })).not.toThrow();
    expect(resolveSuperblockPublicationAuthority({
      base: selected.opened,
      current: selected.opened,
      intendedLogicalState: intended,
    })).toBe('not_published');
    expect(superblockMutationPublicationFailureOutcome({ phase: 'first_authority_verified' }))
      .toBe('committed_redundancy_degraded');
  });
});
