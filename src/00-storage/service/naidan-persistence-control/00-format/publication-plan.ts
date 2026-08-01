import type { PersistenceControlCopy } from './authority-selection';

export type PersistenceControlPublicationPlan = {
  readonly authorityCommitPoint: {
    readonly copy: PersistenceControlCopy;
    readonly sequence: number;
  };
  readonly convergence: {
    readonly copy: PersistenceControlCopy;
    readonly sequence: number;
  };
  readonly observedSequenceFloor: number;
};

export type PersistenceControlPublicationPlanErrorCode =
  | 'bootstrap_has_observed_candidate'
  | 'invalid_observed_sequence'
  | 'selected_authority_not_observed'
  | 'sequence_exhausted';

export class PersistenceControlPublicationPlanError extends Error {
  public constructor({ code, message }: { code: PersistenceControlPublicationPlanErrorCode; message: string }) {
    super(message);
    this.code = code;
    this.name = 'PersistenceControlPublicationPlanError';
  }

  public readonly code: PersistenceControlPublicationPlanErrorCode;
}

function validateObservedSequence({ sequence }: { sequence: number | undefined }): number | undefined {
  if (sequence === undefined) return undefined;
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > Number.MAX_SAFE_INTEGER) {
    throw new PersistenceControlPublicationPlanError({ code: 'invalid_observed_sequence', message: 'observed Persistence Control sequence is invalid' });
  }
  return sequence;
}

export function planPersistenceControlPublication({
  observedSequences,
  selectedAuthority,
}: {
  observedSequences: readonly [number | undefined, number | undefined];
  selectedAuthority: { readonly copy: PersistenceControlCopy; readonly sequence: number } | undefined;
}): PersistenceControlPublicationPlan {
  const validated = observedSequences.map(sequence => validateObservedSequence({ sequence }));
  const observedSequenceFloor = Math.max(...validated.map(sequence => sequence ?? 0));
  if (selectedAuthority === undefined && observedSequenceFloor !== 0) {
    throw new PersistenceControlPublicationPlanError({
      code: 'bootstrap_has_observed_candidate',
      message: 'initial Persistence Control bootstrap cannot ignore an observed candidate',
    });
  }
  if (selectedAuthority !== undefined) {
    const selectedSequence = validateObservedSequence({ sequence: selectedAuthority.sequence });
    if (selectedSequence === undefined || validated[selectedAuthority.copy] !== selectedSequence) {
      throw new PersistenceControlPublicationPlanError({
        code: 'selected_authority_not_observed',
        message: 'selected Persistence Control authority is not the observed candidate for its copy',
      });
    }
  }
  if (observedSequenceFloor > Number.MAX_SAFE_INTEGER - 2) {
    throw new PersistenceControlPublicationPlanError({
      code: 'sequence_exhausted',
      message: 'Persistence Control sequence cannot reserve two fresh publications',
    });
  }

  const firstCopy: PersistenceControlCopy = selectedAuthority === undefined ? 0 : selectedAuthority.copy === 0 ? 1 : 0;
  const secondCopy: PersistenceControlCopy = firstCopy === 0 ? 1 : 0;
  return {
    authorityCommitPoint: { copy: firstCopy, sequence: observedSequenceFloor + 1 },
    convergence: { copy: secondCopy, sequence: observedSequenceFloor + 2 },
    observedSequenceFloor,
  };
}

export const TEST_ONLY = {
};
