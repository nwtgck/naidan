import type { FileSystemId } from '@/00-storage/service/hizofs/compatibility';
import {
  NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS,
  persistenceControlAuthenticationFileSystemId,
  PersistenceControlSelectionError,
  selectPersistenceControlAuthority,
  type NaidanPersistenceModeV1,
  type PersistenceControlCandidate,
  type PersistenceControlCopy,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import {
  readPersistenceControlCandidates,
  type PersistenceControlReadablePhysicalPort,
  type PersistenceControlProofAuthority,
} from '@/00-storage/service/naidan-persistence-control/store';
import { exactObject } from '@/utils/exact-object';

import type {
  PersistenceControlCopyInspection,
  PersistenceControlInspection,
  PersistenceControlModeInspection,
  PersistenceControlSelectionInspection,
} from './persistence-control-inspection-types';

/**
 * Persistence Control inspection is deliberately lossless after canonical
 * parsing. Non-secret persisted proof fields are audit evidence, so the exact
 * control DTO is retained alongside convenience summaries. Passphrases, root
 * keys, and proof-authority capabilities never enter this detached result.
 */

function inspectEndpoint({ endpoint }: {
  endpoint: Extract<NaidanPersistenceModeV1, { type: 'transitioning' }>['phase']['source'];
}): { readonly fileSystemId?: FileSystemId; readonly type: 'hizofs' | 'plain' } {
  switch (endpoint.type) {
  case 'plain': {
    const { type, ...unhandledEndpoint } = endpoint;
    unhandledEndpoint satisfies Record<PropertyKey, never>;
    return { type };
  }
  case 'hizofs': {
    const { fileSystemId, type, ...unhandledEndpoint } = endpoint;
    unhandledEndpoint satisfies Record<PropertyKey, never>;
    return { fileSystemId, type };
  }
  default: return endpoint satisfies never;
  }
}

function inspectMode({ mode }: { mode: NaidanPersistenceModeV1 }): PersistenceControlModeInspection {
  switch (mode.type) {
  case 'plain': {
    const { type, ...unhandledMode } = mode;
    unhandledMode satisfies Record<PropertyKey, never>;
    return { type };
  }
  case 'hizofs': {
    const { activeFileSystemId, type, ...unhandledMode } = mode;
    unhandledMode satisfies Record<PropertyKey, never>;
    return { activeFileSystemId, type };
  }
  case 'transitioning': {
    const { operation, operationId, phase, type, ...unhandledMode } = mode;
    unhandledMode satisfies Record<PropertyKey, never>;
    const { source, target, type: phaseType, ...unhandledPhase } = phase;
    unhandledPhase satisfies Record<PropertyKey, never>;
    return {
      operation,
      operationId,
      phase: {
        source: inspectEndpoint({ endpoint: source }),
        target: inspectEndpoint({ endpoint: target }),
        type: phaseType,
      },
      type,
    };
  }
  default: return mode satisfies never;
  }
}

function persistenceControlPhysicalPath({ copy }: { copy: PersistenceControlCopy }): readonly [string, string] {
  const storage = NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage;
  return [storage.collectionDirectoryName, storage.controlFiles[copy]];
}

function inspectCandidate({ candidate, selectedCopy }: {
  candidate: PersistenceControlCandidate;
  selectedCopy: PersistenceControlCopy | undefined;
}): PersistenceControlCopyInspection {
  switch (candidate.state) {
  case 'structurally_invalid': {
    const { copy, reason, state, ...unhandledCandidate } = candidate;
    unhandledCandidate satisfies Record<PropertyKey, never>;
    return exactObject<PersistenceControlCopyInspection>()({
      authenticationFileSystemId: undefined,
      control: undefined,
      copy,
      mode: undefined,
      physicalPath: persistenceControlPhysicalPath({ copy }),
      protection: undefined,
      reason,
      retiredFileSystemIds: [],
      selected: false,
      sequence: undefined,
      state,
    });
  }
  case 'proof_invalid': {
    const { control, copy, reason, state, ...unhandledCandidate } = candidate;
    unhandledCandidate satisfies Record<PropertyKey, never>;
    return exactObject<PersistenceControlCopyInspection>()({
      authenticationFileSystemId: persistenceControlAuthenticationFileSystemId({ mode: control.mode }),
      control,
      copy,
      mode: inspectMode({ mode: control.mode }),
      physicalPath: persistenceControlPhysicalPath({ copy }),
      protection: control.protection.type,
      reason,
      retiredFileSystemIds: [...control.retiredFileSystemIds],
      selected: copy === selectedCopy,
      sequence: control.sequence,
      state,
    });
  }
  case 'proof_valid':
  case 'protection_unresolved': {
    const { control, copy, state, ...unhandledCandidate } = candidate;
    unhandledCandidate satisfies Record<PropertyKey, never>;
    return exactObject<PersistenceControlCopyInspection>()({
      authenticationFileSystemId: persistenceControlAuthenticationFileSystemId({ mode: control.mode }),
      control,
      copy,
      mode: inspectMode({ mode: control.mode }),
      physicalPath: persistenceControlPhysicalPath({ copy }),
      protection: control.protection.type,
      reason: undefined,
      retiredFileSystemIds: [...control.retiredFileSystemIds],
      selected: copy === selectedCopy,
      sequence: control.sequence,
      state,
    });
  }
  default: return candidate satisfies never;
  }
}

export async function inspectPersistenceControl({ physical, proofAuthority }: {
  physical: PersistenceControlReadablePhysicalPort;
  proofAuthority: PersistenceControlProofAuthority;
}): Promise<PersistenceControlInspection> {
  const read = await readPersistenceControlCandidates({ physical, proofAuthority });
  const { candidates, observedSequences, ...unhandledRead } = read;
  unhandledRead satisfies Record<PropertyKey, never>;
  let selection: PersistenceControlSelectionInspection;
  let selectedCopy: PersistenceControlCopy | undefined;
  try {
    const selected = selectPersistenceControlAuthority({ candidates });
    const { control, copy, redundancy, ...unhandledSelected } = selected;
    unhandledSelected satisfies Record<PropertyKey, never>;
    selectedCopy = copy;
    selection = exactObject<Extract<PersistenceControlSelectionInspection, { state: 'selected' }>>()({
      copy,
      redundancy,
      sequence: control.sequence,
      state: 'selected',
    });
  } catch (cause: unknown) {
    if (!(cause instanceof PersistenceControlSelectionError)) throw cause;
    selection = exactObject<Extract<PersistenceControlSelectionInspection, { state: 'rejected' }>>()({
      code: cause.code,
      message: cause.message,
      state: 'rejected',
    });
  }
  return exactObject<PersistenceControlInspection>()({
    copies: [
      inspectCandidate({ candidate: candidates[0], selectedCopy }),
      inspectCandidate({ candidate: candidates[1], selectedCopy }),
    ],
    observedSequences,
    selection,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
