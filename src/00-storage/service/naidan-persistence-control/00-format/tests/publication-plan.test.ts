import { describe, expect, it } from 'vitest';
import {
  PersistenceControlPublicationPlanError,
  planPersistenceControlPublication,
} from '@/00-storage/service/naidan-persistence-control/00-format';

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof PersistenceControlPublicationPlanError ? error.code : undefined;
  }
}

describe('Naidan Persistence Control publication plan', () => {
  it('bootstraps copy 0 sequence 1 then copy 1 sequence 2', () => {
    expect(planPersistenceControlPublication({ observedSequences: [undefined, undefined], selectedAuthority: undefined })).toEqual({
      authorityCommitPoint: { copy: 0, sequence: 1 },
      convergence: { copy: 1, sequence: 2 },
      observedSequenceFloor: 0,
    });
  });

  it('publishes the alternate copy before convergence', () => {
    expect(planPersistenceControlPublication({ observedSequences: [5, 4], selectedAuthority: { copy: 0, sequence: 5 } })).toEqual({
      authorityCommitPoint: { copy: 1, sequence: 6 },
      convergence: { copy: 0, sequence: 7 },
      observedSequenceFloor: 5,
    });
    expect(planPersistenceControlPublication({ observedSequences: [6, 8], selectedAuthority: { copy: 1, sequence: 8 } }).authorityCommitPoint.copy).toBe(0);
  });

  it('uses torn and proof-invalid observed sequences in the floor', () => {
    const plan = planPersistenceControlPublication({ observedSequences: [5, 99], selectedAuthority: { copy: 0, sequence: 5 } });
    expect(plan.observedSequenceFloor).toBe(99);
    expect(plan.authorityCommitPoint.sequence).toBe(100);
    expect(plan.convergence.sequence).toBe(101);
  });

  it('never reuses an observed sequence', () => {
    const plan = planPersistenceControlPublication({ observedSequences: [10, 10], selectedAuthority: { copy: 0, sequence: 10 } });
    expect(plan.authorityCommitPoint.sequence).toBe(11);
    expect(plan.convergence.sequence).toBe(12);
  });

  it('binds the selected authority sequence to the observed copy', () => {
    expect(errorCode(() => planPersistenceControlPublication({
      observedSequences: [5, 9],
      selectedAuthority: { copy: 0, sequence: 4 },
    }))).toBe('selected_authority_not_observed');
  });

  it('rejects bootstrap when any candidate was structurally observed', () => {
    expect(errorCode(() => planPersistenceControlPublication({ observedSequences: [undefined, 1], selectedAuthority: undefined }))).toBe('bootstrap_has_observed_candidate');
  });

  it('rejects malformed and exhausted sequence floors before the first write', () => {
    expect(errorCode(() => planPersistenceControlPublication({ observedSequences: [0, undefined], selectedAuthority: { copy: 0, sequence: 0 } }))).toBe('invalid_observed_sequence');
    expect(errorCode(() => planPersistenceControlPublication({ observedSequences: [Number.MAX_SAFE_INTEGER - 1, undefined], selectedAuthority: { copy: 0, sequence: Number.MAX_SAFE_INTEGER - 1 } }))).toBe('sequence_exhausted');
  });
});
