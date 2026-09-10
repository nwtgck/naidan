import type { ModelSupportInvestigationConfiguration } from './investigation-config';
import { promiseAllKeyed } from '@/utils/promise';
import type { ModelSupportInvestigationTargetExecution } from './run-investigation-targets-sequentially';
import type { InvestigationReplayMetadataSidecar } from './collect-replay-metadata';
import type { ProductionProviderNativeEvidenceSidecar } from './production-provider-native-evidence';
import { createInvestigationProviderRetentionBudget, investigationProviderRetentionLimits, measureInvestigationProviderRetention, type InvestigationProviderRetentionUsage } from './investigation-provider-retention';
import type {
  ModelSupportInvestigationRecovery,
  ModelSupportInvestigationRun,
} from '@/features/transformers-js/model-support-investigation/types';

interface InvestigationSessionIdentity {
  batchId: string;
  targets: string[];
  configuration: ModelSupportInvestigationConfiguration;
}

export type InvestigationSessionSnapshot = InvestigationSessionIdentity & ({
  // Explicitly replacing Results with Setup must survive closing the modal.
  // Setup retains choices, but owns no result or replay metadata from that batch.
  view: 'setup';
} | {
  view: 'results';
  executions: ModelSupportInvestigationTargetExecution[];
  runs: Array<[string, ModelSupportInvestigationRun]>;
  recoveries: Array<[string, ModelSupportInvestigationRecovery | undefined]>;
  replayMetadata: Array<[string, InvestigationReplayMetadataSidecar[]]>;
  nativeEvidence: Array<[string, ProductionProviderNativeEvidenceSidecar]>;
  reservedProviderRetention: InvestigationProviderRetentionUsage;
  selectedTarget: string | undefined;
});

// Deliberately tab-memory only: no OPFS, localStorage, IndexedDB, or implicit
// persistence. Keep the previous batch while a new batch is being investigated.
// Immutable Blob snapshots are shared by structured clone rather than expanded
// into byte arrays. Bound history so retained model metadata cannot grow forever.
const sessions: InvestigationSessionSnapshot[] = [];
const MAX_RETAINED_SESSIONS = 2;

function rememberInvestigationSession({ snapshot }: {
  snapshot: InvestigationSessionSnapshot;
}): void {
  switch (snapshot.view) {
  case 'setup': break;
  case 'results': {
    // Charge a batch once, regardless of how many views reopen it. Different
    // batches each own this finite logical allowance; history retains at most two.
    createInvestigationProviderRetentionBudget({
      limits: investigationProviderRetentionLimits,
      retained: measureInvestigationProviderRetention({ runs: new Map(snapshot.runs), nativeEvidence: new Map(snapshot.nativeEvidence) }),
    });
    createInvestigationProviderRetentionBudget({ limits: investigationProviderRetentionLimits,
      retained: snapshot.reservedProviderRetention });
    break;
  }
  default: { const exhaustive: never = snapshot; throw new Error('Unhandled retained view: ' + exhaustive); }
  }
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

// A retired view may still be completing Worker disposal when the modal is
// reopened. This registry tracks only teardown barriers, never a mutable
// "current view" that an old callback could accidentally update.
type InvestigationViewTeardown = { status: 'complete' } | { status: 'failed'; error: string };
const retiringViews = new Set<Promise<InvestigationViewTeardown>>();

function failedViewTeardown({ error }: { error: unknown }): InvestigationViewTeardown {
  return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
}

export function createInvestigationSessionView({ initialSnapshot }: {
  initialSnapshot: InvestigationSessionSnapshot | undefined;
}) {
  const inheritedTeardowns = [...retiringViews];
  const ready = Promise.all(inheritedTeardowns).then((results): InvestigationViewTeardown => (
    results.find(result => result.status === 'failed') ?? { status: 'complete' }
  ));
  let active = true;
  let retirement: Promise<InvestigationViewTeardown> | undefined;

  return {
    // View identity changes on reopen; Evidence batch/run identities do not.
    viewId: crypto.randomUUID(),
    initialSnapshot,
    initialReadiness: inheritedTeardowns.length === 0 ? 'ready' as const : 'waiting-for-teardown' as const,
    ready,
    isActive(): boolean {
      return active;
    },
    remember({ snapshot }: { snapshot: InvestigationSessionSnapshot }): void {
      if (active) rememberInvestigationSession({ snapshot });
    },
    retire({ dispose }: { dispose: () => Promise<void> }): Promise<InvestigationViewTeardown> {
      if (retirement !== undefined) return retirement;
      // Revoke writes synchronously, before Vue teardown or any awaited cleanup.
      active = false;
      const completion = Promise.withResolvers<InvestigationViewTeardown>();
      retirement = completion.promise;
      retiringViews.add(retirement);
      const barrier = retirement;
      const ownTeardown = (() => {
        try {
          return dispose().then(
            (): InvestigationViewTeardown => ({ status: 'complete' }),
            error => failedViewTeardown({ error }),
          );
        } catch (error) {
          return Promise.resolve(failedViewTeardown({ error }));
        }
      })();
      void promiseAllKeyed({ inherited: Promise.all(inheritedTeardowns), own: ownTeardown }).then(({ inherited, own }) => {
        const result = inherited.find(result => result.status === 'failed') ?? own;
        // Unknown teardown failure is not proof of physical termination. Keep
        // that terminal barrier until reload; every new view displays its cause.
        // Reopening a failed view must not retain duplicate inherited failures.
        switch (own.status) {
        case 'complete': retiringViews.delete(barrier); break;
        case 'failed': break;
        default: {
          const _ex: never = own;
          return _ex;
        }
        }
        completion.resolve(result);
      });
      return retirement;
    },
  };
}

export type InvestigationSessionView = ReturnType<typeof createInvestigationSessionView>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
  retiringViewCount: (): number => retiringViews.size,
  clear: (): void => {
    sessions.splice(0);
    retiringViews.clear();
  },
};
