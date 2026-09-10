import { z } from 'zod';
import type { GenerationCaptureClient, GenerationCaptureClientLifetime, GenerationCaptureReadResult } from '@/features/transformers-js/worker/generation-capture-protocol';
import type { TransformersJsWorkerClient } from '@/features/transformers-js/types';
import { createProductionProviderCaptureOwner, type ProductionProviderCaptureRequestIdentity } from './production-provider-capture-owner';

type Collection =
  | { status: 'not-requested' | 'pending' }
  | { status: 'returned'; result: GenerationCaptureReadResult }
  | { status: 'failed'; reason: 'take-failed' }
  | { status: 'unavailable'; reason: 'session-inactive' | 'host-state-unavailable' };

export interface ProductionProviderNativeCollectionSnapshot {
  readonly format: 'production-provider-native-collection-v1';
  readonly runId: string;
  readonly maximumWorkerEpochs: number;
  readonly phase: 'not-requested' | 'collecting' | 'finished';
  readonly unrecordedWorkerCreations: number;
  readonly incompleteReasons: readonly 'epoch-limit'[];
  readonly epochs: readonly {
    readonly workerEpoch: number;
    readonly lifetime: { status: 'observed'; value: GenerationCaptureClientLifetime } | { status: 'unavailable' };
    readonly collection: Collection;
  }[];
}

const detachReasonSchema = z.enum(['normal-completion', 'run-deadline', 'collection-deadline', 'user-requested', 'disposed']);
export type NativeCollectionDetachReason = z.infer<typeof detachReasonSchema>;
export interface NativeCollectionCutoff {
  readonly format: 'production-provider-native-cutoff-v1';
  readonly runId: string;
  readonly reason: NativeCollectionDetachReason;
  readonly phaseAtCutoff: ProductionProviderNativeCollectionSnapshot['phase'];
  readonly maximumWorkerEpochs: number;
  readonly unrecordedWorkerCreations: number;
  readonly incompleteReasons: readonly 'epoch-limit'[];
  readonly epochs: readonly Readonly<{
    workerEpoch: number;
    lifetime: Readonly<{ status: 'observed'; session: 'active' | 'inactive'; issuedCallCount: number; loadRequestCount: number }> | Readonly<{ status: 'unavailable' }>;
    // Returned is not synonymous with captured. No result payload or arbitrary
    // error/name/text is inspected to construct this retention-only summary.
    collectionStatus: Collection['status'];
  }>[];
}
export type NativeCollectionView = Readonly<
  { status: 'retained'; capture: ProductionProviderNativeCollectionSnapshot }
  | { status: 'released'; cutoff: NativeCollectionCutoff }
>;
export type DetachedNativeCollection = Readonly<
  { status: 'detached'; capture: ProductionProviderNativeCollectionSnapshot; cutoff: NativeCollectionCutoff }
  | { status: 'already-detached'; cutoff: NativeCollectionCutoff }
>;

/**
 * Own the finite native-record ledger beside the real Provider script. Collection
 * is a separate phase, never a generation callback, retry, or settlement barrier.
 * This memory-only owner has no Download, storage, timer or archive capability.
 */
export function createProductionProviderGenerationCaptureOwner({
  runId, modelId, plan, traceLimits, maximumWorkerEpochs: rawMaximumWorkerEpochs,
  createCaptureClient, createUnrecordedWorkerClient,
}: {
  runId: string;
  modelId: string;
  plan: Parameters<typeof createProductionProviderCaptureOwner>[0]['plan'];
  traceLimits: Parameters<typeof createProductionProviderCaptureOwner>[0]['traceLimits'];
  maximumWorkerEpochs: number;
  createCaptureClient: ({ runId, workerEpoch, getActiveRequest }: {
    runId: string;
    workerEpoch: number;
    getActiveRequest: () => ProductionProviderCaptureRequestIdentity | undefined;
  }) => GenerationCaptureClient;
  createUnrecordedWorkerClient: () => TransformersJsWorkerClient;
}) {
  const maximumWorkerEpochs = z.number().int().min(1).max(8).parse(rawMaximumWorkerEpochs);
  const epochs: Array<{ workerEpoch: number; client: GenerationCaptureClient | undefined; collection: Collection }> = [];
  let unrecordedWorkerCreations = 0;
  let phase: ProductionProviderNativeCollectionSnapshot['phase'] = 'not-requested';
  let collectionPromise: Promise<void> | undefined;
  let adoption: 'open' | 'closed' = 'open';
  let cutoff: NativeCollectionCutoff | undefined;
  function canAdoptNative(): boolean {
    switch (adoption) {
    case 'open': return true;
    case 'closed': return false;
    default: { const exhaustive: never = adoption; throw new Error('Unhandled native adoption: ' + exhaustive); }
    }
  }
  const provider: ReturnType<typeof createProductionProviderCaptureOwner> = createProductionProviderCaptureOwner({
    runId, modelId, plan, traceLimits,
    createWorkerClient() {
      if (!canAdoptNative()) {
        // A late ordinary service restart remains service-owned. It cannot
        // reacquire recording authority or mutate the already fixed cutoff.
        return createUnrecordedWorkerClient();
      }
      if (epochs.length >= maximumWorkerEpochs) {
        // Recording capacity is not permission to stop or alter Production's
        // normal restart. The service still owns/disposes this unrecorded client.
        unrecordedWorkerCreations = Math.min(Number.MAX_SAFE_INTEGER, unrecordedWorkerCreations + 1);
        return createUnrecordedWorkerClient();
      }
      const workerEpoch = epochs.length + 1;
      const client = createCaptureClient({ runId, workerEpoch, getActiveRequest: () => provider.getActiveRequest() });
      epochs.push({ workerEpoch, client, collection: { status: 'not-requested' } });
      return client.client;
    },
  });

  function readLifetime({ epoch }: { epoch: typeof epochs[number] }): ProductionProviderNativeCollectionSnapshot['epochs'][number]['lifetime'] {
    try {
      if (epoch.client === undefined) return { status: 'unavailable' };
      const value = epoch.client.getCaptureLifetime();
      if (value.runId !== runId || value.workerEpoch !== epoch.workerEpoch) return { status: 'unavailable' };
      return { status: 'observed', value };
    } catch {
      // Do not export arbitrary thrown values, or lose the Provider trace just
      // because a native-record observer could not report its host lifetime.
      return { status: 'unavailable' };
    }
  }

  function nativeSnapshot(): ProductionProviderNativeCollectionSnapshot {
    return {
      format: 'production-provider-native-collection-v1', runId, maximumWorkerEpochs, phase, unrecordedWorkerCreations,
      incompleteReasons: unrecordedWorkerCreations === 0 ? [] : ['epoch-limit'],
      epochs: epochs.map(epoch => ({
        workerEpoch: epoch.workerEpoch, lifetime: readLifetime({ epoch }), collection: { ...epoch.collection },
      })),
    };
  }

  function collectNative(): Promise<void> {
    if (!canAdoptNative()) return Promise.reject(new Error('Native capture collection has been released'));
    if (collectionPromise !== undefined) return collectionPromise;
    const run = provider.snapshot().run;
    switch (run.status) {
    case 'not-started': case 'running':
      return Promise.reject(new Error('Native capture collection requires the Provider script to have stopped'));
    case 'completed': case 'stopped': break;
    default: {
      const exhaustive: never = run;
      throw new Error('Unhandled Provider capture state: ' + String(exhaustive));
    }
    }
    phase = 'collecting';
    collectionPromise = (async () => {
      for (const epoch of epochs) {
        if (!canAdoptNative()) return;
        const lifetime = readLifetime({ epoch });
        if (!canAdoptNative()) return;
        switch (lifetime.status) {
        case 'unavailable':
          epoch.collection = { status: 'unavailable', reason: 'host-state-unavailable' };
          continue;
        case 'observed':
          switch (lifetime.value.session) {
          case 'inactive':
            epoch.collection = { status: 'unavailable', reason: 'session-inactive' };
            continue;
          case 'active': break;
          default: {
            const exhaustive: never = lifetime.value.session;
            throw new Error('Unhandled Worker session: ' + String(exhaustive));
          }
          }
          break;
        default: {
          const exhaustive: never = lifetime;
          throw new Error('Unhandled Worker lifetime: ' + String(exhaustive));
        }
        }
        epoch.collection = { status: 'pending' };
        try {
          if (epoch.client === undefined) return;
          const result = await epoch.client.takeGenerationCapture();
          if (!canAdoptNative()) return;
          epoch.collection = { status: 'returned', result };
        } catch {
          if (!canAdoptNative()) return;
          // The Worker may have completed its one-shot take before the reply
          // was lost. Retrying is not recovery and would erase this distinction.
          epoch.collection = { status: 'failed', reason: 'take-failed' };
        }
      }
      if (canAdoptNative()) phase = 'finished';
    })();
    return collectionPromise;
  }

  function cutoffLifetime({ lifetime }: {
    lifetime: ProductionProviderNativeCollectionSnapshot['epochs'][number]['lifetime'];
  }): NativeCollectionCutoff['epochs'][number]['lifetime'] {
    switch (lifetime.status) {
    case 'unavailable': return Object.freeze({ status: 'unavailable' });
    case 'observed': {
      // Only count host-issued records; never enumerate their strings or raw
      // native values. A malformed observer is not evidence of an empty ledger.
      try {
        const session = Object.getOwnPropertyDescriptor(lifetime.value, 'session');
        const issued = Object.getOwnPropertyDescriptor(lifetime.value, 'issuedCalls');
        const loads = Object.getOwnPropertyDescriptor(lifetime.value, 'loadRequests');
        if (session === undefined || !('value' in session) || (session.value !== 'active' && session.value !== 'inactive')
          || issued === undefined || !('value' in issued) || !Array.isArray(issued.value)
          || loads === undefined || !('value' in loads) || !Array.isArray(loads.value)) return Object.freeze({ status: 'unavailable' });
        return Object.freeze({ status: 'observed', session: session.value, issuedCallCount: issued.value.length, loadRequestCount: loads.value.length });
      } catch {
        return Object.freeze({ status: 'unavailable' });
      }
    }
    default: { const exhaustive: never = lifetime; throw new Error('Unhandled cutoff lifetime: ' + String(exhaustive)); }
    }
  }

  /**
   * Transfer this owner's raw ledger once. Previously returned snapshots and
   * the pending RPC's own transport storage are not revocable by this owner.
   */
  function detachNativeCollection({ reason: requestedReason }: { reason: NativeCollectionDetachReason }): DetachedNativeCollection {
    if (cutoff !== undefined) return Object.freeze({ status: 'already-detached', cutoff });
    if (!canAdoptNative()) throw new Error('Native capture release is already in progress');
    const reason = detachReasonSchema.parse(requestedReason);
    const providerState = provider.snapshot();
    switch (reason) {
    case 'normal-completion':
      if ((providerState.run.status !== 'completed' && providerState.run.status !== 'stopped') || phase !== 'finished') {
        throw new Error('Normal native capture release requires completed collection');
      }
      break;
    case 'run-deadline': case 'collection-deadline': case 'user-requested': case 'disposed':
      if (providerState.abortReason === undefined && providerState.disposal === 'not-requested') {
        throw new Error('Interrupted native capture release requires abort or disposal to be requested');
      }
      break;
    default: { const exhaustive: never = reason; throw new Error('Unhandled native cutoff reason: ' + exhaustive); }
    }
    adoption = 'closed';
    const capture = nativeSnapshot();
    cutoff = Object.freeze({
      format: 'production-provider-native-cutoff-v1', runId, reason, phaseAtCutoff: capture.phase,
      maximumWorkerEpochs, unrecordedWorkerCreations,
      incompleteReasons: Object.freeze([...capture.incompleteReasons]),
      epochs: Object.freeze(capture.epochs.map(epoch => Object.freeze({
        workerEpoch: epoch.workerEpoch, lifetime: cutoffLifetime({ lifetime: epoch.lifetime }), collectionStatus: epoch.collection.status,
      }))),
    });
    for (const epoch of epochs) {
      // The in-flight loop can still hold an epoch object. Clear that same
      // object, not merely a replacement outer array, before returning ownership.
      epoch.collection = { status: 'not-requested' };
      epoch.client = undefined;
    }
    epochs.length = 0;
    collectionPromise = undefined;
    return Object.freeze({ status: 'detached', capture, cutoff });
  }

  return {
    run: provider.run,
    abort: provider.abort,
    // Disposal starts synchronously and never waits for collection to finish.
    dispose: provider.dispose,
    collectNative,
    detachNativeCollection,
    getProgress: provider.getProgress,
    // The synchronous Provider projection does not inspect native lifetimes,
    // collect RPC results, encode evidence, or copy tensor bytes.
    snapshotProvider: provider.snapshot,
    snapshot() {
      let native: NativeCollectionView;
      switch (adoption) {
      case 'open': native = Object.freeze({ status: 'retained', capture: nativeSnapshot() }); break;
      case 'closed':
        if (cutoff === undefined) throw new Error('Native capture release is in progress');
        native = Object.freeze({ status: 'released', cutoff });
        break;
      default: { const exhaustive: never = adoption; throw new Error('Unhandled native retention: ' + exhaustive); }
      }
      return { provider: provider.snapshot(), native };
    },
  };
}

export const TEST_ONLY = {
};
