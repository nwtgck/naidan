import {
  decodePersistenceControl,
  persistenceControlSemanticallyEquals,
  type NaidanPersistenceControlCoreV1,
  type NaidanPersistenceControlV1,
  type NaidanPersistenceModeV1,
} from './canonical-json/persistence-control';

export type PersistenceControlCopy = 0 | 1;

export type PersistenceControlSemanticState = {
  readonly mode: NaidanPersistenceModeV1;
  readonly retiredFileSystemIds: NaidanPersistenceControlCoreV1['retiredFileSystemIds'];
};

export type StructurallyClassifiedPersistenceControl =
  | { readonly copy: PersistenceControlCopy; readonly reason: string; readonly state: 'structurally_invalid' }
  | { readonly control: NaidanPersistenceControlV1; readonly copy: PersistenceControlCopy; readonly state: 'structurally_valid' };

export type PersistenceControlCandidate =
  | { readonly copy: PersistenceControlCopy; readonly reason: string; readonly state: 'structurally_invalid' }
  | { readonly control: NaidanPersistenceControlV1; readonly copy: PersistenceControlCopy; readonly state: 'protection_unresolved' }
  | { readonly control: NaidanPersistenceControlV1; readonly copy: PersistenceControlCopy; readonly reason: string; readonly state: 'proof_invalid' }
  | { readonly control: NaidanPersistenceControlV1; readonly copy: PersistenceControlCopy; readonly state: 'proof_valid' };

export type SelectedPersistenceControlAuthority = {
  readonly control: NaidanPersistenceControlV1;
  readonly copy: PersistenceControlCopy;
  readonly redundancy: 'converged' | 'degraded';
};

export class PersistenceControlSelectionError extends Error {
  public constructor({ code, message }: { code: PersistenceControlSelectionErrorCode; message: string }) {
    super(message);
    this.code = code;
    this.name = 'PersistenceControlSelectionError';
  }

  public readonly code: PersistenceControlSelectionErrorCode;
}

export type PersistenceControlSelectionErrorCode =
  | 'copy_identity_mismatch'
  | 'higher_protection_unresolved'
  | 'no_proof_valid_authority'
  | 'sequence_reuse_corruption';

export function structurallyObservedPersistenceControlSequence({ candidate }: {
  candidate: PersistenceControlCandidate;
}): number | undefined {
  switch (candidate.state) {
  case 'structurally_invalid': return undefined;
  case 'protection_unresolved':
  case 'proof_invalid':
  case 'proof_valid': return candidate.control.sequence;
  default: {
    const unhandled: never = candidate;
    throw new Error(`unhandled Persistence Control candidate: ${String(unhandled)}`);
  }
  }
}

function structuralFailureReason({ cause }: { cause: unknown }): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

export function classifyPersistenceControlStructure({ bytes, copy }: {
  bytes: Uint8Array | undefined;
  copy: PersistenceControlCopy;
}): StructurallyClassifiedPersistenceControl {
  if (bytes === undefined) return { copy, reason: 'missing', state: 'structurally_invalid' };
  try {
    return { control: decodePersistenceControl({ bytes }), copy, state: 'structurally_valid' };
  } catch (cause: unknown) {
    return { copy, reason: structuralFailureReason({ cause }), state: 'structurally_invalid' };
  }
}

export function persistenceControlCandidatesAreBootstrapAbsent({ candidates }: {
  candidates: readonly [PersistenceControlCandidate, PersistenceControlCandidate];
}): boolean {
  return candidates.every(candidate => (
    candidate.state === 'structurally_invalid' && candidate.reason === 'missing'
  ));
}

export function createPersistenceControlCore({ copy, semanticState, sequence }: {
  copy: PersistenceControlCopy;
  semanticState: PersistenceControlSemanticState;
  sequence: number;
}): NaidanPersistenceControlCoreV1 {
  return {
    copy,
    format: 'naidan-persistence-control',
    formatVersion: 1,
    mode: semanticState.mode,
    retiredFileSystemIds: semanticState.retiredFileSystemIds,
    sequence,
  };
}

export function persistenceControlReadbackMatches(args: {
  actual: PersistenceControlCandidate;
  expected: NaidanPersistenceControlV1;
  physicalCopy: PersistenceControlCopy;
}): args is {
  actual: Extract<PersistenceControlCandidate, { state: 'proof_valid' }>;
  expected: NaidanPersistenceControlV1;
  physicalCopy: PersistenceControlCopy;
} {
  const { actual, expected, physicalCopy } = args;
  return actual.state === 'proof_valid'
    && actual.copy === physicalCopy
    && actual.control.copy === physicalCopy
    && actual.control.sequence === expected.sequence
    && persistenceControlSemanticallyEquals({ left: actual.control, right: expected });
}

export function persistenceControlPublicationOutcome({ desiredState, selectedAuthority }: {
  desiredState: PersistenceControlSemanticState;
  selectedAuthority: SelectedPersistenceControlAuthority;
}): 'committed_degraded' | 'committed_converged' | 'not_committed' {
  const desiredControl: NaidanPersistenceControlV1 = {
    ...selectedAuthority.control,
    mode: desiredState.mode,
    retiredFileSystemIds: desiredState.retiredFileSystemIds,
  };
  if (!persistenceControlSemanticallyEquals({
    left: selectedAuthority.control,
    right: desiredControl,
  })) return 'not_committed';
  switch (selectedAuthority.redundancy) {
  case 'converged': return 'committed_converged';
  case 'degraded': return 'committed_degraded';
  default: return selectedAuthority.redundancy satisfies never;
  }
}

function assertCopyIdentity({ candidate }: { candidate: PersistenceControlCandidate }): void {
  switch (candidate.state) {
  case 'structurally_invalid': return;
  case 'protection_unresolved':
  case 'proof_invalid':
  case 'proof_valid':
    if (candidate.control.copy !== candidate.copy) {
      throw new PersistenceControlSelectionError({
        code: 'copy_identity_mismatch',
        message: 'Persistence Control filename copy and persisted copy disagree',
      });
    }
    return;
  default: {
    const unhandled: never = candidate;
    throw new Error(`unhandled Persistence Control candidate: ${String(unhandled)}`);
  }
  }
}

export function selectPersistenceControlAuthority({
  candidates,
}: {
  candidates: readonly [PersistenceControlCandidate, PersistenceControlCandidate];
}): SelectedPersistenceControlAuthority {
  if (candidates[0].copy === candidates[1].copy) {
    throw new PersistenceControlSelectionError({ code: 'copy_identity_mismatch', message: 'Persistence Control candidates must represent distinct copies' });
  }
  for (const candidate of candidates) assertCopyIdentity({ candidate });

  const firstStructuralSequence = structurallyObservedPersistenceControlSequence({ candidate: candidates[0] });
  const secondStructuralSequence = structurallyObservedPersistenceControlSequence({ candidate: candidates[1] });
  if (firstStructuralSequence !== undefined && firstStructuralSequence === secondStructuralSequence) {
    throw new PersistenceControlSelectionError({
      code: 'sequence_reuse_corruption',
      message: 'Persistence Control copies reuse the same structural sequence',
    });
  }

  const proofValid = candidates.filter((candidate): candidate is Extract<PersistenceControlCandidate, { state: 'proof_valid' }> => candidate.state === 'proof_valid');
  const selected = proofValid.toSorted((left, right) => right.control.sequence - left.control.sequence)[0];
  const highestObservedSequence = Math.max(...candidates.map(candidate => (
    structurallyObservedPersistenceControlSequence({ candidate }) ?? 0
  )));
  const unresolvedAtHighest = candidates.some(candidate => candidate.state === 'protection_unresolved' && candidate.control.sequence === highestObservedSequence);
  if (unresolvedAtHighest && (selected === undefined || highestObservedSequence >= selected.control.sequence)) {
    throw new PersistenceControlSelectionError({
      code: 'higher_protection_unresolved',
      message: 'highest structurally canonical Persistence Control candidate has unresolved protection',
    });
  }
  if (selected === undefined) {
    throw new PersistenceControlSelectionError({
      code: 'no_proof_valid_authority',
      message: 'no proof-valid Persistence Control authority exists',
    });
  }

  const otherProofValid = proofValid.find(candidate => candidate.copy !== selected.copy);
  const redundancy = otherProofValid !== undefined && persistenceControlSemanticallyEquals({ left: selected.control, right: otherProofValid.control })
    ? 'converged'
    : 'degraded';
  return {
    control: selected.control,
    copy: selected.copy,
    redundancy,
  };
}

export const TEST_ONLY = {
};
