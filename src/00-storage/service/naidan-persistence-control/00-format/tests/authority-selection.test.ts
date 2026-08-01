import { describe, expect, it } from 'vitest';
import { parsePortableFileSystemId } from '@/00-storage/service/hizofs/compatibility';
import {
  PersistenceControlSelectionError,
  selectPersistenceControlAuthority,
  type NaidanPersistenceControlV1,
  type PersistenceControlCandidate,
} from '@/00-storage/service/naidan-persistence-control/00-format';

const DIGEST = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ID = parsePortableFileSystemId({ value: '0123456789_ABCDEFGHIJ' });

function control({ copy, sequence }: { copy: 0 | 1; sequence: number }): NaidanPersistenceControlV1 {
  return {
    copy,
    format: 'naidan-persistence-control',
    formatVersion: 1,
    mode: { type: 'plain' },
    protection: { digest: DIGEST, type: 'plain_sha256' },
    retiredFileSystemIds: [],
    sequence,
  };
}

function candidate({ copy, sequence, state }: { copy: 0 | 1; sequence: number; state: 'proof_invalid' | 'proof_valid' | 'protection_unresolved' }): PersistenceControlCandidate {
  const value = control({ copy, sequence });
  if (state === 'proof_invalid') return { control: value, copy, reason: 'digest mismatch', state };
  return { control: value, copy, state };
}

function selectionCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof PersistenceControlSelectionError ? error.code : undefined;
  }
}

describe('Naidan Persistence Control A/B authority selection', () => {
  it('selects the highest proof-valid sequence', () => {
    const selected = selectPersistenceControlAuthority({ candidates: [candidate({ copy: 0, sequence: 3, state: 'proof_valid' }), candidate({ copy: 1, sequence: 4, state: 'proof_valid' })] });
    expect(selected.copy).toBe(1);
    expect(selected.redundancy).toBe('converged');
  });

  it('reports one valid copy as degraded authority', () => {
    const selected = selectPersistenceControlAuthority({ candidates: [candidate({ copy: 0, sequence: 3, state: 'proof_valid' }), candidate({ copy: 1, sequence: 4, state: 'proof_invalid' })] });
    expect(selected.copy).toBe(0);
    expect(selected.redundancy).toBe('degraded');
  });

  it('reports two proof-valid but semantically different copies as degraded', () => {
    const oldState = control({ copy: 0, sequence: 3 });
    const newState = { ...control({ copy: 1, sequence: 4 }), retiredFileSystemIds: [ID] };
    const selected = selectPersistenceControlAuthority({
      candidates: [
        { control: oldState, copy: 0, state: 'proof_valid' },
        { control: newState, copy: 1, state: 'proof_valid' },
      ],
    });
    expect(selected.copy).toBe(1);
    expect(selected.redundancy).toBe('degraded');
  });

  it('blocks lower routing behind a higher unresolved candidate', () => {
    expect(selectionCode(() => selectPersistenceControlAuthority({ candidates: [candidate({ copy: 0, sequence: 8, state: 'protection_unresolved' }), candidate({ copy: 1, sequence: 7, state: 'proof_valid' })] }))).toBe('higher_protection_unresolved');
  });

  it('allows a lower unresolved candidate when a higher authority is proof-valid', () => {
    const selected = selectPersistenceControlAuthority({ candidates: [candidate({ copy: 0, sequence: 8, state: 'proof_valid' }), candidate({ copy: 1, sequence: 7, state: 'protection_unresolved' })] });
    expect(selected.copy).toBe(0);
  });

  it('rejects same-sequence unresolved evidence as sequence reuse corruption', () => {
    expect(selectionCode(() => selectPersistenceControlAuthority({ candidates: [candidate({ copy: 0, sequence: 8, state: 'proof_valid' }), candidate({ copy: 1, sequence: 8, state: 'protection_unresolved' })] }))).toBe('sequence_reuse_corruption');
  });

  it('rejects same-sequence proof-invalid evidence as sequence reuse corruption', () => {
    expect(selectionCode(() => selectPersistenceControlAuthority({ candidates: [candidate({ copy: 0, sequence: 8, state: 'proof_valid' }), candidate({ copy: 1, sequence: 8, state: 'proof_invalid' })] }))).toBe('sequence_reuse_corruption');
  });

  it('rejects same-sequence proof-valid copies as split-brain corruption', () => {
    expect(selectionCode(() => selectPersistenceControlAuthority({ candidates: [candidate({ copy: 0, sequence: 8, state: 'proof_valid' }), candidate({ copy: 1, sequence: 8, state: 'proof_valid' })] }))).toBe('sequence_reuse_corruption');
  });

  it('does not infer plain authority when both copies are invalid', () => {
    expect(selectionCode(() => selectPersistenceControlAuthority({ candidates: [{ copy: 0, reason: 'missing', state: 'structurally_invalid' }, candidate({ copy: 1, sequence: 2, state: 'proof_invalid' })] }))).toBe('no_proof_valid_authority');
  });

  it('rejects persisted copy identity mismatch', () => {
    const mismatched: PersistenceControlCandidate = { control: control({ copy: 1, sequence: 2 }), copy: 0, state: 'proof_valid' };
    expect(selectionCode(() => selectPersistenceControlAuthority({ candidates: [mismatched, candidate({ copy: 1, sequence: 1, state: 'proof_valid' })] }))).toBe('copy_identity_mismatch');
  });

  it('does not use endpoint existence as an implicit authority substitute', () => {
    expect(ID).toHaveLength(21);
    expect(selectionCode(() => selectPersistenceControlAuthority({ candidates: [{ copy: 0, reason: 'missing', state: 'structurally_invalid' }, { copy: 1, reason: 'missing', state: 'structurally_invalid' }] }))).toBe('no_proof_valid_authority');
  });
});
