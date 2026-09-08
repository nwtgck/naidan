import type { ModelSupportInvestigationConfiguration } from './investigation-config';
import type { ModelSupportInvestigationTargetExecution } from './run-investigation-targets-sequentially';
import type { InvestigationReplayMetadataSidecar } from './collect-replay-metadata';
import type {
  ModelSupportInvestigationRecovery,
  ModelSupportInvestigationRun,
} from '@/features/transformers-js/model-support-investigation/types';

export interface InvestigationSessionSnapshot {
  batchId: string;
  targets: string[];
  configuration: ModelSupportInvestigationConfiguration;
  executions: ModelSupportInvestigationTargetExecution[];
  runs: Array<[string, ModelSupportInvestigationRun]>;
  recoveries: Array<[string, ModelSupportInvestigationRecovery | undefined]>;
  replayMetadata: Array<[string, InvestigationReplayMetadataSidecar[]]>;
  selectedTarget: string | undefined;
}

// Deliberately tab-memory only: no OPFS, localStorage, IndexedDB, or implicit
// persistence. Keep the previous batch while a new batch is being investigated.
// Immutable Blob snapshots are shared by structured clone rather than expanded
// into byte arrays. Bound history so retained model metadata cannot grow forever.
const sessions: InvestigationSessionSnapshot[] = [];
const MAX_RETAINED_SESSIONS = 2;

export function rememberInvestigationSession({ snapshot }: {
  snapshot: InvestigationSessionSnapshot;
}): void {
  const captured = structuredClone(snapshot);
  const previous = sessions.findIndex(session => session.batchId === snapshot.batchId);
  if (previous >= 0) sessions.splice(previous, 1);
  sessions.unshift(captured);
  sessions.splice(MAX_RETAINED_SESSIONS);
}

export function recallInvestigationSession({ seededTarget }: {
  seededTarget: string | undefined;
}): InvestigationSessionSnapshot | undefined {
  const session = sessions.find(item => seededTarget === undefined || item.targets.includes(seededTarget));
  return session === undefined ? undefined : structuredClone(session);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
  clear: (): void => {
    sessions.splice(0);
  },
};
