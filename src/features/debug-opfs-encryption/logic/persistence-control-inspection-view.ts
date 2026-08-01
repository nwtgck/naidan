import type {
  PersistenceControlCopyInspection,
  PersistenceControlInspection,
  PersistenceControlModeInspection,
} from '@/00-storage/service/naidan-persistence-control/inspection/persistence-control-inspection-types';
import { exactObject } from '@/utils/exact-object';

/**
 * Persistence Control Inspector is a storage-authority audit surface. It reads
 * the exact inspection DTO intentionally: a normal UI mapper could omit or
 * normalize fields and make an A/B authority or transition review incomplete.
 */

export type PersistenceControlInspectionCopyRow = {
  readonly authenticationFileSystemId: string | undefined;
  readonly control: PersistenceControlCopyInspection['control'];
  readonly controlJson: string;
  readonly copy: 0 | 1;
  readonly mode: PersistenceControlModeInspection | undefined;
  readonly modeJson: string;
  readonly modeSummary: string;
  readonly physicalPath: string;
  readonly protection: PersistenceControlCopyInspection['protection'];
  readonly reason: string | undefined;
  readonly retiredFileSystemIds: readonly string[];
  readonly selected: boolean;
  readonly sequence: string;
  readonly state: PersistenceControlCopyInspection['state'];
};

export type PersistenceControlInspectionView = {
  readonly copyRows: readonly PersistenceControlInspectionCopyRow[];
  readonly observedSequences: readonly [string, string];
  readonly selectionSummary: string;
};

function endpointSummary({ endpoint }: {
  endpoint: Extract<PersistenceControlModeInspection, { type: 'transitioning' }>['phase']['source'];
}): string {
  const { fileSystemId, type, ...unhandledEndpoint } = endpoint;
  unhandledEndpoint satisfies Record<PropertyKey, never>;
  switch (type) {
  case 'plain': return 'plain';
  case 'hizofs': return `hizofs:${fileSystemId}`;
  default: return type satisfies never;
  }
}

function modeSummary({ mode }: { mode: PersistenceControlModeInspection | undefined }): string {
  if (mode === undefined) return 'unavailable';
  switch (mode.type) {
  case 'plain': {
    const { type: _type, ...unhandledMode } = mode;
    unhandledMode satisfies Record<PropertyKey, never>;
    return 'plain';
  }
  case 'hizofs': {
    const { activeFileSystemId, type: _type, ...unhandledMode } = mode;
    unhandledMode satisfies Record<PropertyKey, never>;
    return `hizofs:${activeFileSystemId}`;
  }
  case 'transitioning': {
    const { operation, operationId, phase, type: _type, ...unhandledMode } = mode;
    unhandledMode satisfies Record<PropertyKey, never>;
    const { source, target, type: phaseType, ...unhandledPhase } = phase;
    unhandledPhase satisfies Record<PropertyKey, never>;
    return `${operation}:${operationId}:${phaseType}:${endpointSummary({ endpoint: source })}->${endpointSummary({ endpoint: target })}`;
  }
  default: return mode satisfies never;
  }
}

function selectionSummary({ selection }: { selection: PersistenceControlInspection['selection'] }): string {
  switch (selection.state) {
  case 'selected': {
    const { copy, redundancy, sequence, state: _state, ...unhandledSelection } = selection;
    unhandledSelection satisfies Record<PropertyKey, never>;
    return `copy ${copy}, sequence ${sequence}, ${redundancy}`;
  }
  case 'rejected': {
    const { code, message, state: _state, ...unhandledSelection } = selection;
    unhandledSelection satisfies Record<PropertyKey, never>;
    return `${code}: ${message}`;
  }
  default: return selection satisfies never;
  }
}

function observedSequence({ sequence }: { sequence: number | undefined }): string {
  return sequence === undefined ? 'unobserved' : String(sequence);
}

function copyRow({ inspectionCopy }: {
  inspectionCopy: PersistenceControlCopyInspection;
}): PersistenceControlInspectionCopyRow {
  const {
    authenticationFileSystemId,
    control,
    copy,
    mode,
    physicalPath,
    protection,
    reason,
    retiredFileSystemIds,
    selected,
    sequence,
    state,
    ...unhandledInspectionCopy
  } = inspectionCopy;
  unhandledInspectionCopy satisfies Record<PropertyKey, never>;
  return exactObject<PersistenceControlInspectionCopyRow>()({
    authenticationFileSystemId,
    control,
    controlJson: control === undefined ? 'unavailable' : JSON.stringify(control, undefined, 2),
    copy,
    mode,
    modeJson: mode === undefined ? 'unavailable' : JSON.stringify(mode, undefined, 2),
    modeSummary: modeSummary({ mode }),
    physicalPath: physicalPath.join('/'),
    protection,
    reason,
    retiredFileSystemIds: [...retiredFileSystemIds],
    selected,
    sequence: observedSequence({ sequence }),
    state,
  });
}

export function createPersistenceControlInspectionView({ inspection }: {
  inspection: PersistenceControlInspection;
}): PersistenceControlInspectionView {
  const { copies, observedSequences, selection, ...unhandledInspection } = inspection;
  unhandledInspection satisfies Record<PropertyKey, never>;
  return exactObject<PersistenceControlInspectionView>()({
    copyRows: copies.map(inspectionCopy => copyRow({ inspectionCopy })),
    observedSequences: [
      observedSequence({ sequence: observedSequences[0] }),
      observedSequence({ sequence: observedSequences[1] }),
    ],
    selectionSummary: selectionSummary({ selection }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
