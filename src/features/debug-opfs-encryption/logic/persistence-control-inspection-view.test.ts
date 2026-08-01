import { describe, expect, it } from 'vitest';
import { parsePortableFileSystemId } from '@/00-storage/service/hizofs/compatibility';
import {
  parseTransitionOperationId,
  type NaidanPersistenceControlV1,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import type { PersistenceControlInspection } from '@/00-storage/service/naidan-persistence-control/inspection/persistence-control-inspection-types';
import { createPersistenceControlInspectionView } from './persistence-control-inspection-view';

const ACTIVE_FILE_SYSTEM_ID = parsePortableFileSystemId({ value: '0123456789_ABCDEFGHIJ' });
const TARGET_FILE_SYSTEM_ID = parsePortableFileSystemId({ value: 'KLMNOPQRST_0123456789' });
const RETIRED_FILE_SYSTEM_ID = parsePortableFileSystemId({ value: 'RETIRED_FS_0123456789' });
const TRANSITION_OPERATION_ID = parseTransitionOperationId({ value: 'transition_op_0000001' });

function plainControl(): NaidanPersistenceControlV1 {
  return {
    copy: 1,
    format: 'naidan-persistence-control',
    formatVersion: 1,
    mode: { type: 'plain' },
    protection: { digest: 'plain-digest-base64url', type: 'plain_sha256' },
    retiredFileSystemIds: [],
    sequence: 9,
  };
}

function transitioningControl(): NaidanPersistenceControlV1 {
  return {
    copy: 0,
    format: 'naidan-persistence-control',
    formatVersion: 1,
    mode: {
      operation: 're_encrypt',
      operationId: TRANSITION_OPERATION_ID,
      phase: {
        source: { fileSystemId: ACTIVE_FILE_SYSTEM_ID, type: 'hizofs' },
        target: { fileSystemId: TARGET_FILE_SYSTEM_ID, type: 'hizofs' },
        type: 'building_target',
      },
      type: 'transitioning',
    },
    protection: {
      authenticationFileSystemId: ACTIVE_FILE_SYSTEM_ID,
      authenticatorTag: 'persisted-authenticator-tag',
      nonce: 'persisted-nonce',
      type: 'hizofs_aes_256_gcm',
    },
    retiredFileSystemIds: [RETIRED_FILE_SYSTEM_ID],
    sequence: 12,
  };
}

function hizofsControl(): NaidanPersistenceControlV1 {
  return {
    copy: 1,
    format: 'naidan-persistence-control',
    formatVersion: 1,
    mode: { activeFileSystemId: ACTIVE_FILE_SYSTEM_ID, type: 'hizofs' },
    protection: {
      authenticationFileSystemId: ACTIVE_FILE_SYSTEM_ID,
      authenticatorTag: 'previous-authenticator-tag',
      nonce: 'previous-nonce',
      type: 'hizofs_aes_256_gcm',
    },
    retiredFileSystemIds: [],
    sequence: 11,
  };
}

function rejectedInspection(): PersistenceControlInspection {
  const control = plainControl();
  return {
    copies: [
      {
        authenticationFileSystemId: undefined,
        control: undefined,
        copy: 0,
        mode: undefined,
        physicalPath: ['persistence-control', 'state-0.json'],
        protection: undefined,
        reason: 'missing',
        retiredFileSystemIds: [],
        selected: false,
        sequence: undefined,
        state: 'structurally_invalid',
      },
      {
        authenticationFileSystemId: undefined,
        control,
        copy: 1,
        mode: { type: 'plain' },
        physicalPath: ['hizofs', 'state-1.json'],
        protection: 'plain_sha256',
        reason: 'plain digest mismatch',
        retiredFileSystemIds: [],
        selected: false,
        sequence: 9,
        state: 'proof_invalid',
      },
    ],
    observedSequences: [undefined, 9],
    selection: {
      code: 'no_proof_valid_authority',
      message: 'no proof-valid Persistence Control authority exists',
      state: 'rejected',
    },
  };
}

function selectedInspection(): PersistenceControlInspection {
  const selectedControl = transitioningControl();
  const siblingControl = hizofsControl();
  return {
    copies: [
      {
        authenticationFileSystemId: ACTIVE_FILE_SYSTEM_ID,
        control: selectedControl,
        copy: 0,
        mode: selectedControl.mode,
        physicalPath: ['persistence-control', 'state-0.json'],
        protection: 'hizofs_aes_256_gcm',
        reason: undefined,
        retiredFileSystemIds: [RETIRED_FILE_SYSTEM_ID],
        selected: true,
        sequence: 12,
        state: 'proof_valid',
      },
      {
        authenticationFileSystemId: ACTIVE_FILE_SYSTEM_ID,
        control: siblingControl,
        copy: 1,
        mode: siblingControl.mode,
        physicalPath: ['hizofs', 'state-1.json'],
        protection: 'hizofs_aes_256_gcm',
        reason: undefined,
        retiredFileSystemIds: [],
        selected: false,
        sequence: 11,
        state: 'proof_valid',
      },
    ],
    observedSequences: [12, 11],
    selection: { copy: 0, redundancy: 'degraded', sequence: 12, state: 'selected' },
  };
}

describe('Persistence Control debug inspection view', () => {
  it('preserves physical copy states, exact persisted DTOs, and rejected authority selection', () => {
    const inspection = rejectedInspection();
    const view = createPersistenceControlInspectionView({ inspection });
    expect(view.selectionSummary).toBe('no_proof_valid_authority: no proof-valid Persistence Control authority exists');
    expect(view.observedSequences).toEqual(['unobserved', '9']);
    expect(view.copyRows[0]).toMatchObject({ control: undefined, controlJson: 'unavailable', state: 'structurally_invalid' });
    expect(view.copyRows[1]).toMatchObject({
      control: inspection.copies[1].control,
      controlJson: JSON.stringify(inspection.copies[1].control, undefined, 2),
      modeJson: JSON.stringify({ type: 'plain' }, undefined, 2),
      modeSummary: 'plain',
      reason: 'plain digest mismatch',
      state: 'proof_invalid',
    });
  });

  it('preserves selected transition ownership and every persisted protection field', () => {
    const inspection = selectedInspection();
    const view = createPersistenceControlInspectionView({ inspection });
    expect(view.selectionSummary).toBe('copy 0, sequence 12, degraded');
    expect(view.observedSequences).toEqual(['12', '11']);
    expect(view.copyRows[0]).toMatchObject({
      authenticationFileSystemId: ACTIVE_FILE_SYSTEM_ID,
      control: inspection.copies[0].control,
      controlJson: JSON.stringify(inspection.copies[0].control, undefined, 2),
      modeSummary: 're_encrypt:transition_op_0000001:building_target:hizofs:0123456789_ABCDEFGHIJ->hizofs:KLMNOPQRST_0123456789',
      protection: 'hizofs_aes_256_gcm',
      retiredFileSystemIds: [RETIRED_FILE_SYSTEM_ID],
      selected: true,
      state: 'proof_valid',
    });
    expect(view.copyRows[0]?.controlJson).toContain('"authenticatorTag": "persisted-authenticator-tag"');
    expect(view.copyRows[0]?.controlJson).toContain('"nonce": "persisted-nonce"');
  });
});
