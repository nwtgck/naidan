import { HIZOFS_V1_FORMAT_CONSTANTS } from './format-constants';
import {
  encodeHomeRecordReference,
  encodeOptionalHomeRecordReference,
  encodeOptionalPhysicalRecordReference,
  type HomeRecordReference,
  type PhysicalRecordReference,
} from './binary/record-reference';
import type { SuperblockHeaderV1, SuperblockPlaintextV1 } from './binary/superblock';
import { createPublicationSequence, type CommitSequence, type FeatureBits, type PublicationSequence, type UnlockSequence } from './scalars';
import type { MutationId, PublicationId } from './identifiers';

export type SuperblockCopyState = 'normal' | 'superblock_redundancy_degraded';

export type SuperblockLogicalState = Readonly<{
  activeCommitHomeRef: HomeRecordReference;
  activeCommitSequence: CommitSequence;
  activeMutationId: MutationId;
  fallbackCommitHomeRef: HomeRecordReference | null;
  minimumUnlockSequence: UnlockSequence;
  relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
  requiredFeatureBits: FeatureBits;
}>;

export type HistoricalRootFeatureState = 'supported_or_absent' | 'unsupported';

export type OpenedSuperblockCopies = Readonly<{
  authenticatedLogicalStates: readonly SuperblockLogicalState[];
  copyState: SuperblockCopyState;
  historicalRootFeatureState: HistoricalRootFeatureState;
  logicalState: SuperblockLogicalState;
  maximumStructurallyObservedPublicationSequence: PublicationSequence;
  selectedCopy: 0 | 1;
  selectedPublicationId: PublicationId;
  selectedPublicationSequence: PublicationSequence;
}>;

export type AuthenticatedSuperblockCopy = Readonly<{
  header: SuperblockHeaderV1;
  logicalState: SuperblockLogicalState;
  physicalCopy: 0 | 1;
  plaintext: SuperblockPlaintextV1;
}>;

export type SuperblockCopyReadResult =
  | Readonly<{ kind: 'invalid'; structurallyObservedPublicationSequence?: PublicationSequence }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ copy: AuthenticatedSuperblockCopy; kind: 'valid' }>;

export type SuperblockAuthoritySelection =
  | Readonly<{ allCopiesMissing: boolean; type: 'no_authenticated_copy' }>
  | Readonly<{ type: 'sequence_reuse_conflict' }>
  | Readonly<{ type: 'unsupported_required_feature' }>
  | Readonly<{
    copies: readonly AuthenticatedSuperblockCopy[];
    opened: OpenedSuperblockCopies;
    type: 'selected';
  }>;

export type SuperblockPublicationPhase = 'first_authority_verified' | 'first_write_started' | 'prepared' | 'second_copy_converged';

export type SuperblockMutationPublicationFailureOutcome =
  | 'not_published'
  | 'outcome_resolution_required'
  | 'committed_redundancy_degraded';

export type SuperblockRelocationPublicationFailureOutcome =
  | 'not_published'
  | 'outcome_resolution_required'
  | 'published_redundancy_degraded';

export type SuperblockUnlockFloorPublicationFailureOutcome = SuperblockRelocationPublicationFailureOutcome;

export type SuperblockPublicationAuthorityResolution = 'not_published' | 'publication_conflict' | 'published';

function bytesEqual({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function superblockLogicalStateFrom({ header, plaintext }: {
  header: SuperblockHeaderV1;
  plaintext: SuperblockPlaintextV1;
}): SuperblockLogicalState {
  return {
    activeCommitHomeRef: plaintext.activeCommitHomeRef,
    activeCommitSequence: header.activeCommitSequence,
    activeMutationId: plaintext.activeMutationId,
    fallbackCommitHomeRef: plaintext.fallbackCommitHomeRef,
    minimumUnlockSequence: plaintext.minimumUnlockSequence,
    relocationIndexRootPhysicalRef: plaintext.relocationIndexRootPhysicalRef,
    requiredFeatureBits: plaintext.requiredFeatureBits,
  };
}

export function superblockLogicalStatesSemanticallyEqual({ left, right }: {
  left: SuperblockLogicalState;
  right: SuperblockLogicalState;
}): boolean {
  return left.activeCommitSequence === right.activeCommitSequence
    && bytesEqual({
      left: encodeHomeRecordReference({ reference: left.activeCommitHomeRef }),
      right: encodeHomeRecordReference({ reference: right.activeCommitHomeRef }),
    })
    && bytesEqual({ left: left.activeMutationId, right: right.activeMutationId })
    && bytesEqual({
      left: encodeOptionalHomeRecordReference({ reference: left.fallbackCommitHomeRef }),
      right: encodeOptionalHomeRecordReference({ reference: right.fallbackCommitHomeRef }),
    })
    && left.minimumUnlockSequence === right.minimumUnlockSequence
    && bytesEqual({
      left: encodeOptionalPhysicalRecordReference({ reference: left.relocationIndexRootPhysicalRef }),
      right: encodeOptionalPhysicalRecordReference({ reference: right.relocationIndexRootPhysicalRef }),
    })
    && left.requiredFeatureBits === right.requiredFeatureBits;
}

export function superblockFlagsForLogicalState({ logicalState }: { logicalState: SuperblockLogicalState }): number {
  let flags = 0;
  if (logicalState.fallbackCommitHomeRef !== null) {
    flags |= HIZOFS_V1_FORMAT_CONSTANTS.flags.superblockFallbackCommitPresent;
  }
  if (logicalState.relocationIndexRootPhysicalRef !== null) {
    flags |= HIZOFS_V1_FORMAT_CONSTANTS.flags.superblockRelocationIndexRootPresent;
  }
  return flags;
}

export function superblockRequiresUnsupportedFeatures({ logicalState, supportedFeatureBits }: {
  logicalState: SuperblockLogicalState;
  supportedFeatureBits: FeatureBits;
}): boolean {
  return (logicalState.requiredFeatureBits & ~supportedFeatureBits) !== 0n;
}

export function maximumStructurallyObservedSuperblockPublicationSequence({ results }: {
  results: readonly SuperblockCopyReadResult[];
}): bigint {
  let maximum = 0n;
  for (const result of results) {
    let observed: PublicationSequence | undefined;
    switch (result.kind) {
    case 'valid': observed = result.copy.header.publicationSequence; break;
    case 'invalid': observed = result.structurallyObservedPublicationSequence; break;
    case 'missing': observed = undefined; break;
    default: observed = result satisfies never;
    }
    if (observed !== undefined && observed > maximum) maximum = observed;
  }
  return maximum;
}

export function authenticatedSuperblockCopiesByDescendingSequence({ results }: {
  results: readonly SuperblockCopyReadResult[];
}): readonly AuthenticatedSuperblockCopy[] {
  return results
    .filter((result): result is Extract<SuperblockCopyReadResult, { kind: 'valid' }> => result.kind === 'valid')
    .map(({ copy }) => copy)
    .toSorted((left, right) => {
      if (left.header.publicationSequence === right.header.publicationSequence) return 0;
      return left.header.publicationSequence > right.header.publicationSequence ? -1 : 1;
    });
}

export function selectSuperblockAuthority({ results, supportedFeatureBits }: {
  results: readonly SuperblockCopyReadResult[];
  supportedFeatureBits: FeatureBits;
}): SuperblockAuthoritySelection {
  const copies = authenticatedSuperblockCopiesByDescendingSequence({ results });
  const selected = copies[0];
  if (selected === undefined) {
    return {
      allCopiesMissing: results.every(result => result.kind === 'missing'),
      type: 'no_authenticated_copy',
    };
  }
  if (copies.some(copy => copy !== selected
    && copy.header.publicationSequence === selected.header.publicationSequence)) {
    return { type: 'sequence_reuse_conflict' };
  }
  if (superblockRequiresUnsupportedFeatures({ logicalState: selected.logicalState, supportedFeatureBits })) {
    return { type: 'unsupported_required_feature' };
  }
  const sibling = copies[1];
  const maximumObservedSequence = createPublicationSequence({
    value: maximumStructurallyObservedSuperblockPublicationSequence({ results }),
  });
  return {
    copies,
    opened: {
      authenticatedLogicalStates: Object.freeze(copies.map(copy => copy.logicalState)),
      copyState: sibling !== undefined && superblockLogicalStatesSemanticallyEqual({
        left: selected.logicalState,
        right: sibling.logicalState,
      }) ? 'normal' : 'superblock_redundancy_degraded',
      historicalRootFeatureState: sibling !== undefined
        && superblockRequiresUnsupportedFeatures({ logicalState: sibling.logicalState, supportedFeatureBits })
        ? 'unsupported'
        : 'supported_or_absent',
      logicalState: selected.logicalState,
      maximumStructurallyObservedPublicationSequence: maximumObservedSequence,
      selectedCopy: selected.physicalCopy,
      selectedPublicationId: selected.plaintext.publicationId,
      selectedPublicationSequence: selected.header.publicationSequence,
    },
    type: 'selected',
  };
}

export function superblockOpenedAuthoritiesSemanticallyEqual({ left, right }: {
  left: OpenedSuperblockCopies;
  right: OpenedSuperblockCopies;
}): boolean {
  return left.selectedCopy === right.selectedCopy
    && left.historicalRootFeatureState === right.historicalRootFeatureState
    && left.selectedPublicationSequence === right.selectedPublicationSequence
    && bytesEqual({ left: left.selectedPublicationId, right: right.selectedPublicationId })
    && left.maximumStructurallyObservedPublicationSequence === right.maximumStructurallyObservedPublicationSequence
    && superblockLogicalStatesSemanticallyEqual({ left: left.logicalState, right: right.logicalState });
}

export function resolveSuperblockPublicationAuthority({ base, current, intendedLogicalState }: {
  base: OpenedSuperblockCopies;
  current: OpenedSuperblockCopies;
  intendedLogicalState: SuperblockLogicalState;
}): SuperblockPublicationAuthorityResolution {
  if (superblockLogicalStatesSemanticallyEqual({ left: current.logicalState, right: intendedLogicalState })) {
    return 'published';
  }
  if (superblockOpenedAuthoritiesSemanticallyEqual({ left: base, right: current })) return 'not_published';
  return 'publication_conflict';
}

function assertReservedPublicationSequences({ base, firstPublicationSequence, secondPublicationSequence }: {
  base: OpenedSuperblockCopies;
  firstPublicationSequence: PublicationSequence;
  secondPublicationSequence: PublicationSequence;
}): void {
  if (firstPublicationSequence !== base.maximumStructurallyObservedPublicationSequence + 1n
    || secondPublicationSequence !== base.maximumStructurallyObservedPublicationSequence + 2n) {
    throw new RangeError('reserved Publication Sequences must be exactly F + 1 and F + 2');
  }
}

export function assertMutationSuperblockPublicationTransition({ base, firstPublicationSequence, logicalState, secondPublicationSequence }: {
  base: OpenedSuperblockCopies;
  firstPublicationSequence: PublicationSequence;
  logicalState: SuperblockLogicalState;
  secondPublicationSequence: PublicationSequence;
}): void {
  assertReservedPublicationSequences({ base, firstPublicationSequence, secondPublicationSequence });
  if (logicalState.activeCommitSequence !== base.logicalState.activeCommitSequence + 1n) {
    throw new RangeError('mutation Commit Sequence must be exactly base + 1');
  }
  if (logicalState.fallbackCommitHomeRef === null
    || !bytesEqual({
      left: encodeHomeRecordReference({ reference: logicalState.fallbackCommitHomeRef }),
      right: encodeHomeRecordReference({ reference: base.logicalState.activeCommitHomeRef }),
    })) {
    throw new TypeError('mutation fallback Commit must be the previous authoritative active Commit');
  }
  if (bytesEqual({ left: logicalState.activeMutationId, right: base.logicalState.activeMutationId })) {
    throw new TypeError('mutation publication requires a fresh Mutation ID');
  }
}

export function sameSuperblockLogicalStateExceptRelocation({ left, right }: {
  left: SuperblockLogicalState;
  right: SuperblockLogicalState;
}): boolean {
  return superblockLogicalStatesSemanticallyEqual({
    left,
    right: { ...right, relocationIndexRootPhysicalRef: left.relocationIndexRootPhysicalRef },
  });
}

export function assertRelocationSuperblockPublicationTransition({ base, firstPublicationSequence, logicalState, secondPublicationSequence }: {
  base: OpenedSuperblockCopies;
  firstPublicationSequence: PublicationSequence;
  logicalState: SuperblockLogicalState;
  secondPublicationSequence: PublicationSequence;
}): void {
  assertReservedPublicationSequences({ base, firstPublicationSequence, secondPublicationSequence });
  if (!sameSuperblockLogicalStateExceptRelocation({ left: base.logicalState, right: logicalState })) {
    throw new TypeError('relocation publication must preserve Commit, Mutation, fallback, unlock, and feature authority');
  }
  if (bytesEqual({
    left: encodeOptionalPhysicalRecordReference({ reference: base.logicalState.relocationIndexRootPhysicalRef }),
    right: encodeOptionalPhysicalRecordReference({ reference: logicalState.relocationIndexRootPhysicalRef }),
  })) {
    throw new TypeError('relocation publication must change the authoritative Relocation Index root');
  }
}

export function sameSuperblockLogicalStateExceptMinimumUnlockSequence({ left, right }: {
  left: SuperblockLogicalState;
  right: SuperblockLogicalState;
}): boolean {
  return superblockLogicalStatesSemanticallyEqual({
    left,
    right: { ...right, minimumUnlockSequence: left.minimumUnlockSequence },
  });
}

export function assertUnlockFloorSuperblockPublicationTransition({ base, firstPublicationSequence, logicalState, secondPublicationSequence }: {
  base: OpenedSuperblockCopies;
  firstPublicationSequence: PublicationSequence;
  logicalState: SuperblockLogicalState;
  secondPublicationSequence: PublicationSequence;
}): void {
  assertReservedPublicationSequences({ base, firstPublicationSequence, secondPublicationSequence });
  if (!sameSuperblockLogicalStateExceptMinimumUnlockSequence({ left: base.logicalState, right: logicalState })) {
    throw new TypeError('credential floor publication must preserve Commit, Mutation, fallback, relocation, and feature authority');
  }
  if (logicalState.minimumUnlockSequence <= base.logicalState.minimumUnlockSequence) {
    throw new RangeError('credential floor publication must strictly increase minimum Unlock Sequence');
  }
}

function superblockPublicationFailureOutcome({ phase }: {
  phase: SuperblockPublicationPhase;
}): 'not_published' | 'outcome_resolution_required' | 'published_redundancy_degraded' {
  switch (phase) {
  case 'prepared': return 'not_published';
  case 'first_write_started': return 'outcome_resolution_required';
  case 'first_authority_verified': return 'published_redundancy_degraded';
  case 'second_copy_converged': throw new Error('converged publication cannot fail');
  default: return phase satisfies never;
  }
}

export function superblockMutationPublicationFailureOutcome({ phase }: {
  phase: SuperblockPublicationPhase;
}): SuperblockMutationPublicationFailureOutcome {
  const outcome = superblockPublicationFailureOutcome({ phase });
  switch (outcome) {
  case 'not_published': return 'not_published';
  case 'outcome_resolution_required': return 'outcome_resolution_required';
  case 'published_redundancy_degraded': return 'committed_redundancy_degraded';
  default: return outcome satisfies never;
  }
}

export function superblockRelocationPublicationFailureOutcome({ phase }: {
  phase: SuperblockPublicationPhase;
}): SuperblockRelocationPublicationFailureOutcome {
  return superblockPublicationFailureOutcome({ phase });
}

export function superblockUnlockFloorPublicationFailureOutcome({ phase }: {
  phase: SuperblockPublicationPhase;
}): SuperblockUnlockFloorPublicationFailureOutcome {
  return superblockPublicationFailureOutcome({ phase });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
