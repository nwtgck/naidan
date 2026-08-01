import type { PersistenceControlInspection } from '@/00-storage/service/naidan-persistence-control/inspection';
import { exactObject } from '@/utils/exact-object';
import type {
  OpfsCredentialRequiredCandidate,
  OpfsEncryptionInspection,
} from './persistence-runtime-contract';

function credentialCandidate({ candidate }: {
  candidate: PersistenceControlInspection['copies'][number];
}): OpfsCredentialRequiredCandidate {
  const {
    authenticationFileSystemId: _authenticationFileSystemId,
    control: _control,
    copy,
    mode: _mode,
    physicalPath: _physicalPath,
    protection: _protection,
    reason: _reason,
    retiredFileSystemIds: _retiredFileSystemIds,
    selected: _selected,
    sequence,
    state,
    ...unhandledCandidate
  } = candidate;
  unhandledCandidate satisfies Record<PropertyKey, never>;
  return exactObject<OpfsCredentialRequiredCandidate>()({ copy, sequence, state });
}

function recoveryRequired({ cause, message }: {
  cause?: unknown;
  message: string;
}): Extract<OpfsEncryptionInspection, { type: 'recovery_required' }> {
  return {
    error: cause === undefined ? new Error(message) : new Error(message, { cause }),
    type: 'recovery_required',
  };
}

/**
 * Projects the lossless low-level inspection into the application startup
 * contract without turning structurally decoded bytes into routing authority.
 * Only a proof-valid selected copy may expose its persisted mode.
 */
export function projectPersistenceRuntimeInspection({ inspection }: {
  inspection: PersistenceControlInspection;
}): OpfsEncryptionInspection {
  const { copies, observedSequences: _observedSequences, selection, ...unhandledInspection } = inspection;
  unhandledInspection satisfies Record<PropertyKey, never>;

  switch (selection.state) {
  case 'rejected': {
    const { code, message, state: _state, ...unhandledSelection } = selection;
    unhandledSelection satisfies Record<PropertyKey, never>;
    switch (code) {
    case 'higher_protection_unresolved':
      if (!copies.some(copy => copy.state === 'protection_unresolved')) {
        return recoveryRequired({
          message: 'Persistence Control reported unresolved protection without an unresolved candidate',
        });
      }
      return exactObject<Extract<OpfsEncryptionInspection, { type: 'credential_required' }>>()({
        blockingReason: 'protection_unresolved',
        candidates: [
          credentialCandidate({ candidate: copies[0] }),
          credentialCandidate({ candidate: copies[1] }),
        ],
        type: 'credential_required',
      });
    case 'copy_identity_mismatch':
    case 'no_proof_valid_authority':
    case 'sequence_reuse_corruption':
      return recoveryRequired({ message, cause: selection });
    default: {
      const _ex: never = code;
      throw new Error(`Unhandled Persistence Control selection error: ${String(_ex)}`);
    }
    }
  }
  case 'selected': {
    const { copy, redundancy: _redundancy, sequence, state: _state, ...unhandledSelection } = selection;
    unhandledSelection satisfies Record<PropertyKey, never>;
    const candidate = copies[copy];
    if (
      candidate.copy !== copy
      || candidate.sequence !== sequence
      || candidate.state !== 'proof_valid'
      || candidate.selected !== true
      || candidate.control === undefined
    ) {
      return recoveryRequired({
        message: 'Selected Persistence Control inspection is not bound to its proof-valid candidate',
      });
    }
    const control = candidate.control;
    switch (control.mode.type) {
    case 'plain':
      return { type: 'plain' };
    case 'hizofs':
      return exactObject<Extract<OpfsEncryptionInspection, { type: 'encrypted' }>>()({
        control,
        mode: control.mode,
        type: 'encrypted',
      });
    case 'transitioning':
      return exactObject<Extract<OpfsEncryptionInspection, { type: 'transitioning' }>>()({
        control,
        mode: control.mode,
        type: 'transitioning',
      });
    default: return control.mode satisfies never;
    }
  }
  default: return selection satisfies never;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
