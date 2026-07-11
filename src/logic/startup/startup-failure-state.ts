import type { Component } from 'vue';
import type { StartupState } from './types';
import type { OpfsEncryptionStartupGate } from './opfs-encryption-startup-gate';

function createOpfsApplicationFailureState({
  gate,
  error,
  mainApp,
}: {
  gate: OpfsEncryptionStartupGate,
  error: unknown,
  mainApp: Component | undefined,
}): StartupState {
  gate.reportApplicationFailure({ error });
  return {
    kind: 'opfs-encryption-main-failed',
    gate,
    error,
    mainApp,
  };
}

/**
 * Preserves the encrypted-startup presentation boundary when application
 * preparation fails after cryptographic unlock. At that point the storage is
 * no longer a normal foundation failure: hiding the lock presentation would
 * expose a partially mounted app and remove the raw OPFS recovery path.
 */
export function resolveStartupFailureState({
  state,
  error,
}: {
  state: StartupState,
  error: unknown,
}): StartupState {
  switch (state.kind) {
  case 'initializing-foundation':
    return {
      kind: 'foundation-failed',
      error,
    };
  case 'opfs-encryption-required': {
    const phase = state.gate.phase.value;
    switch (phase) {
    case 'preparing_application':
    case 'application_failed':
      return createOpfsApplicationFailureState({
        gate: state.gate,
        error,
        mainApp: undefined,
      });
    case 'locked':
    case 'unlocking':
      return {
        kind: 'foundation-failed',
        error,
      };
    default: {
      const _ex: never = phase;
      return _ex;
    }
    }
  }
  case 'starting-main-after-opfs-unlock':
    return createOpfsApplicationFailureState({
      gate: state.gate,
      error,
      mainApp: undefined,
    });
  case 'rendering-main-after-opfs-unlock':
    return createOpfsApplicationFailureState({
      gate: state.gate,
      error,
      mainApp: state.mainApp,
    });
  case 'starting-main':
  case 'rendering-main':
  case 'ready':
    return {
      kind: 'main-failed',
      error,
    };
  case 'foundation-failed':
  case 'main-failed':
  case 'opfs-encryption-main-failed':
    return state;
  default: {
    const _ex: never = state;
    return _ex;
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
