import { persistenceControlSemanticallyEquals, type NaidanPersistenceControlV1 } from './canonical-json/persistence-control';

export type PersistenceControlCopy = 0 | 1;

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

function structuralSequence({ candidate }: { candidate: PersistenceControlCandidate }): number | undefined {
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

  const firstStructuralSequence = structuralSequence({ candidate: candidates[0] });
  const secondStructuralSequence = structuralSequence({ candidate: candidates[1] });
  if (firstStructuralSequence !== undefined && firstStructuralSequence === secondStructuralSequence) {
    throw new PersistenceControlSelectionError({
      code: 'sequence_reuse_corruption',
      message: 'Persistence Control copies reuse the same structural sequence',
    });
  }

  const proofValid = candidates.filter((candidate): candidate is Extract<PersistenceControlCandidate, { state: 'proof_valid' }> => candidate.state === 'proof_valid');
  const selected = proofValid.toSorted((left, right) => right.control.sequence - left.control.sequence)[0];
  const highestObservedSequence = Math.max(...candidates.map(candidate => structuralSequence({ candidate }) ?? 0));
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
