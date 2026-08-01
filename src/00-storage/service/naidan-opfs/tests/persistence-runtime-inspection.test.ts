import { describe, expect, it } from 'vitest';
import type {
  PersistenceControlCopyInspection,
  PersistenceControlInspection,
} from '@/00-storage/service/naidan-persistence-control/inspection';
import {
  TEST_ONLY as PERSISTENCE_RUNTIME_TEST_ONLY,
  type OpfsEncryptionInspection,
} from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import {
  persistenceControlAuthenticationFileSystemId,
  type NaidanPersistenceControlV1,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import { projectPersistenceRuntimeInspection } from '@/00-storage/service/naidan-opfs/persistence-runtime-inspection';

function encryptedControl() {
  const inspection = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
    fileSystemId: 'selected-file-system',
  });
  const control = inspection.control;
  if (control.mode.type !== 'hizofs') {
    throw new Error('Expected HizoFS Persistence Control mode');
  }
  return { ...control, mode: control.mode };
}

function copy({
  control = undefined,
  copy: copyIdentity,
  selected = false,
  sequence = undefined,
  state,
}: {
  control?: NaidanPersistenceControlV1;
  copy: 0 | 1;
  selected?: boolean;
  sequence?: number;
  state: PersistenceControlCopyInspection['state'];
}): PersistenceControlCopyInspection {
  return {
    authenticationFileSystemId: control === undefined
      ? undefined
      : persistenceControlAuthenticationFileSystemId({ mode: control.mode }),
    control,
    copy: copyIdentity,
    mode: control?.mode,
    physicalPath: ['persistence-control', `copy-${String(copyIdentity)}`],
    protection: control?.protection.type,
    reason: state === 'structurally_invalid' || state === 'proof_invalid' ? 'rejected' : undefined,
    retiredFileSystemIds: control?.retiredFileSystemIds ?? [],
    selected,
    sequence,
    state,
  };
}

describe('projectPersistenceRuntimeInspection', () => {
  it('projects unresolved protection without exposing a selected File System ID', () => {
    const control = encryptedControl();
    const inspection: PersistenceControlInspection = {
      copies: [
        copy({ control, copy: 0, sequence: 2, state: 'protection_unresolved' }),
        copy({ copy: 1, state: 'structurally_invalid' }),
      ],
      observedSequences: [2, undefined],
      selection: {
        code: 'higher_protection_unresolved',
        message: 'credential required',
        state: 'rejected',
      },
    };

    const projected = projectPersistenceRuntimeInspection({ inspection });

    expect(projected.type).toBe('credential_required');
    if (projected.type !== 'credential_required') throw new Error('Expected credential-required inspection');
    const { blockingReason, candidates, requiredAction, type, ...unhandledProjected } = projected;
    unhandledProjected satisfies Record<PropertyKey, never>;
    expect({ blockingReason, candidates, requiredAction, type }).toEqual({
      blockingReason: 'protection_unresolved',
      requiredAction: 'unlock',
      candidates: [
        { copy: 0, sequence: 2, state: 'protection_unresolved' },
        { copy: 1, sequence: undefined, state: 'structurally_invalid' },
      ],
      type: 'credential_required',
    });
    expect('mode' in projected).toBe(false);
  });

  it('projects an unresolved transition as a proof-bound convergence action', () => {
    const transition = PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
      operation: 'decrypt',
      phase: 'building_target',
      sourceFileSystemId: 'selected-file-system',
      targetFileSystemId: undefined,
    });
    const control = transition.control;
    const inspection: PersistenceControlInspection = {
      copies: [
        copy({ control, copy: 0, sequence: 3, state: 'protection_unresolved' }),
        copy({ copy: 1, state: 'structurally_invalid' }),
      ],
      observedSequences: [3, undefined],
      selection: {
        code: 'higher_protection_unresolved',
        message: 'credential required',
        state: 'rejected',
      },
    };

    expect(projectPersistenceRuntimeInspection({ inspection })).toMatchObject({
      requiredAction: 'converge_transition',
      type: 'credential_required',
    });
  });

  it('projects only a proof-valid selected HizoFS authority as encrypted', () => {
    const control = encryptedControl();
    const inspection: PersistenceControlInspection = {
      copies: [
        copy({ control, copy: 0, selected: true, sequence: control.sequence, state: 'proof_valid' }),
        copy({ copy: 1, state: 'structurally_invalid' }),
      ],
      observedSequences: [control.sequence, undefined],
      selection: {
        copy: 0,
        redundancy: 'degraded',
        sequence: control.sequence,
        state: 'selected',
      },
    };

    expect(projectPersistenceRuntimeInspection({ inspection })).toEqual({
      control,
      mode: control.mode,
      type: 'encrypted',
    });
  });

  it('fails closed when selection is not bound to the selected candidate', () => {
    const control = encryptedControl();
    const inspection: PersistenceControlInspection = {
      copies: [
        copy({ control, copy: 0, selected: false, sequence: control.sequence, state: 'proof_valid' }),
        copy({ copy: 1, state: 'structurally_invalid' }),
      ],
      observedSequences: [control.sequence, undefined],
      selection: {
        copy: 0,
        redundancy: 'degraded',
        sequence: control.sequence,
        state: 'selected',
      },
    };

    const projected: OpfsEncryptionInspection = projectPersistenceRuntimeInspection({ inspection });
    expect(projected.type).toBe('recovery_required');
  });

  it('does not reinterpret proof failure as credential-required', () => {
    const inspection: PersistenceControlInspection = {
      copies: [
        copy({ copy: 0, state: 'structurally_invalid' }),
        copy({ copy: 1, state: 'structurally_invalid' }),
      ],
      observedSequences: [undefined, undefined],
      selection: {
        code: 'no_proof_valid_authority',
        message: 'no valid authority',
        state: 'rejected',
      },
    };

    expect(projectPersistenceRuntimeInspection({ inspection }).type).toBe('recovery_required');
  });
});
