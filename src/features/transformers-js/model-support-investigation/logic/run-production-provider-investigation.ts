import { z } from 'zod';
import { exactObject } from '@/utils/exact-object';
import { createProductionProviderCapturePolicy } from './production-provider-capture-policy';
import { createProductionProviderCaptureEvidence } from './production-provider-capture-evidence';
import { createProductionProviderGenerationCaptureOwner, type DetachedNativeCollection, type NativeCollectionCutoff, type NativeCollectionDetachReason } from './production-provider-generation-capture-owner';
import type { ProductionProviderCaptureProgress, ProductionProviderCaptureSnapshot } from './production-provider-capture-owner';
import { createProductionProviderNativeEvidence, PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, type ProductionProviderNativeEvidenceSidecar } from './production-provider-native-evidence';

type OwnerArguments = Parameters<typeof createProductionProviderGenerationCaptureOwner>[0];
type Phase = 'not-started' | 'running' | 'collecting' | 'sealing' | 'finished';
type StopReason = 'user-requested' | 'disposed' | 'run-deadline' | 'collection-deadline' | 'sealing-deadline' | 'execution-failed';
type Cleanup = 'not-requested' | 'pending' | 'completed' | 'failed';
type NativeEvidenceStatus = 'not-attempted' | 'available' | 'provider-evidence-refused' | 'sealing-deadline' | 'sealing-interrupted' | 'sealing-failed';
const deadlinesSchema = z.object({
  runMs: z.number().int().min(1).max(86_400_000),
  collectionMs: z.number().int().min(1).max(86_400_000),
  sealingMs: z.number().int().min(1).max(86_400_000),
  cleanupMs: z.number().int().min(1).max(86_400_000),
}).strict().readonly();

export interface ProductionProviderInvestigationProgress {
  readonly phase: Phase;
  readonly provider: ProductionProviderCaptureProgress;
  readonly stopReason: StopReason | undefined;
  readonly cleanup: Cleanup;
  readonly sealOwnership: 'settled' | 'pending';
}

function summarizeRequests({ provider }: { provider: ProductionProviderCaptureSnapshot }) {
  return Object.freeze(provider.requests.map(request => {
    const { requestId, scenario, status, notStartedReason, trace, runId: _runId, input: _input, ...restRequest } = request;
    restRequest satisfies Record<PropertyKey, never>;
    const { format: _format, requestId: _requestId, completeness, limits, retainedCharacters, events, lateEvents, settled, failure: _failure, ...restTrace } = trace;
    restTrace satisfies Record<PropertyKey, never>;
    return Object.freeze({
      requestId, scenario, status, notStartedReason,
      outcome: settled?.outcome.status,
      settledCompleteness: settled?.completeness,
      completeness, limits, retainedCharacters,
      eventCount: events.length + lateEvents.length,
    });
  }));
}

export interface ProductionProviderInvestigationResult {
  readonly provider: ProductionProviderCaptureSnapshot | undefined;
  readonly nativeEvidence: ProductionProviderNativeEvidenceSidecar | undefined;
  readonly summary: Readonly<{
    format: 'production-provider-investigation-v1';
    policy: ReturnType<typeof createProductionProviderCapturePolicy>;
    completion: 'completed' | 'interrupted';
    stopReason: StopReason | undefined;
    providerEvidence: 'available' | 'refused';
    /** Observed with the Provider anchor: before the first stop request mutates
     * the owner, or after collection on normal completion. Cleanup/cutoff below
     * describe later actions, never backdated into this observation. */
    providerProgress: ProductionProviderCaptureProgress;
    requests: ReturnType<typeof summarizeRequests>;
    cutoff: NativeCollectionCutoff;
    nativeEvidenceStatus: NativeEvidenceStatus;
    cleanup: Cleanup;
    sealOwnership: 'settled' | 'pending';
    progressCallbackFailures: number;
  }>;
}

/** One MSI target, not a replacement for ordinary chat or online Download. */
export function createProductionProviderInvestigation({
  runId, modelId, plan, createCaptureClient, createUnrecordedWorkerClient,
  maximumWorkerEpochs, maximumNativeBinaryBytes: rawMaximumNativeBinaryBytes,
  deadlines: rawDeadlines, onProgress,
}: {
  runId: string;
  modelId: string;
  plan: OwnerArguments['plan'];
  createCaptureClient: OwnerArguments['createCaptureClient'];
  createUnrecordedWorkerClient: OwnerArguments['createUnrecordedWorkerClient'];
  maximumWorkerEpochs: number;
  maximumNativeBinaryBytes: number;
  deadlines: z.infer<typeof deadlinesSchema>;
  onProgress: ({ progress }: { progress: ProductionProviderInvestigationProgress }) => void;
}) {
  const policy = createProductionProviderCapturePolicy({ plan });
  const deadlines = deadlinesSchema.parse(rawDeadlines);
  const maximumNativeBinaryBytes = z.number().int().min(0).max(PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES).parse(rawMaximumNativeBinaryBytes);
  const owner = createProductionProviderGenerationCaptureOwner({
    runId, modelId, plan, createCaptureClient, createUnrecordedWorkerClient,
    maximumWorkerEpochs, traceLimits: policy.traceLimits,
  });
  let phase: Phase = 'not-started';
  let invocation: 'not-started' | 'started' = 'not-started';
  let stopReason: StopReason | undefined;
  const stopListeners = new Set<() => void>();
  let cleanup: Cleanup = 'not-requested';
  let disposal: Promise<void> | undefined;
  let anchor: ProductionProviderCaptureSnapshot | undefined;
  let anchorProgress: ProductionProviderCaptureProgress | undefined;
  let anchorObservation: 'not-taken' | 'captured' | 'unavailable' = 'not-taken';
  let detached: Extract<DetachedNativeCollection, { status: 'detached' }> | undefined;
  let cutoff: NativeCollectionCutoff | undefined;
  let nativeEvidence: ProductionProviderNativeEvidenceSidecar | undefined;
  let nativeEvidenceStatus: NativeEvidenceStatus = 'not-attempted';
  let sealOwnership: 'settled' | 'pending' = 'settled';
  let sealAdoption: 'open' | 'closed' = 'open';
  let sealWork: Promise<void> | undefined;
  let progressCallbackFailures = 0;

  function publishProgress(): void {
    try {
      onProgress({ progress: getProgress() });
    } catch {
      progressCallbackFailures = Math.min(Number.MAX_SAFE_INTEGER, progressCallbackFailures + 1);
    }
  }

  function canAdoptSeal(): boolean {
    switch (sealAdoption) {
    case 'open': return true;
    case 'closed': return false;
    default: { const exhaustive: never = sealAdoption; throw new Error('Unhandled seal adoption: ' + exhaustive); }
    }
  }

  function getProgress(): ProductionProviderInvestigationProgress {
    return Object.freeze(exactObject<ProductionProviderInvestigationProgress>()({
      phase, provider: owner.getProgress(), stopReason, cleanup, sealOwnership,
    }));
  }

  function startDisposal(): Promise<void> {
    if (disposal !== undefined) return disposal;
    cleanup = 'pending';
    // Physical Worker disposal is requested synchronously, before awaiting any
    // pending generation, collection, hashing, or progress delivery.
    const actual = owner.dispose();
    disposal = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('Production Provider investigation cleanup remains unconfirmed');
        error.name = 'ProductionProviderInvestigationCleanupTimeoutError';
        reject(error);
      }, deadlines.cleanupMs);
      void actual.then(() => {
        cleanup = 'completed';
        clearTimeout(timer);
        resolve();
      }, error => {
        cleanup = 'failed';
        clearTimeout(timer);
        reject(error);
      });
    });
    void disposal.catch(() => undefined);
    return disposal;
  }

  function captureAnchor(): void {
    switch (anchorObservation) {
    case 'captured': case 'unavailable': return;
    case 'not-taken': break;
    default: { const exhaustive: never = anchorObservation; throw new Error('Unhandled anchor observation: ' + exhaustive); }
    }
    try {
      const provider = owner.snapshotProvider();
      const progress = owner.getProgress();
      anchor = provider;
      anchorProgress = progress;
      anchorObservation = 'captured';
    } catch {
      // Observation failure cannot delay physical disposal or substitute a
      // later state for the missing cutoff. run() rejects without an anchor.
      anchorObservation = 'unavailable';
    }
  }

  function detach({ reason }: { reason: NativeCollectionDetachReason }): void {
    if (cutoff !== undefined) return;
    // Normal completion observes the script after collection. A stopping run
    // already captured its pre-stop projection in the same synchronous stack.
    captureAnchor();
    const result = owner.detachNativeCollection({ reason });
    switch (result.status) {
    case 'detached':
      detached = result;
      cutoff = result.cutoff;
      break;
    case 'already-detached': throw new Error('Investigation native ownership was already transferred');
    default: { const exhaustive: never = result; throw new Error('Unhandled native transfer: ' + String(exhaustive)); }
    }
  }

  function requestStop({ reason }: { reason: StopReason }): void {
    switch (phase) {
    case 'finished': return;
    case 'not-started': case 'running': case 'collecting': case 'sealing': break;
    default: { const exhaustive: never = phase; throw new Error('Unhandled investigation phase: ' + exhaustive); }
    }
    stopReason ??= reason;
    // No await, native observer, RPC, encoding, or byte copy precedes disposal.
    // Capture both projections before abort/dispose can reset Load to idle.
    captureAnchor();
    let detachReason: NativeCollectionDetachReason;
    let interruptedSealStatus: NativeEvidenceStatus;
    switch (reason) {
    case 'user-requested':
      owner.abort({ reason: 'user-requested' });
      detachReason = reason;
      interruptedSealStatus = 'sealing-interrupted';
      break;
    case 'run-deadline': case 'collection-deadline':
      owner.abort({ reason: 'deadline' });
      detachReason = reason;
      interruptedSealStatus = 'sealing-interrupted';
      break;
    case 'sealing-deadline':
      owner.abort({ reason: 'deadline' });
      detachReason = 'disposed';
      interruptedSealStatus = 'sealing-deadline';
      break;
    case 'disposed': case 'execution-failed':
      // Disposal is an independent terminal request, not an invented deadline.
      detachReason = 'disposed';
      interruptedSealStatus = 'sealing-interrupted';
      break;
    default: { const exhaustive: never = reason; throw new Error('Unhandled investigation stop: ' + exhaustive); }
    }
    void startDisposal();
    switch (phase) {
    case 'not-started': case 'running': case 'collecting': break;
    case 'sealing':
      sealAdoption = 'closed';
      if (nativeEvidence === undefined) nativeEvidenceStatus = interruptedSealStatus;
      break;
    default: { const exhaustive: never = phase; throw new Error('Unhandled stopping phase: ' + exhaustive); }
    }
    // Native detachment follows the requested stop. Its later inactive-session
    // state must not replace the pre-stop Provider anchor or its counters.
    detach({ reason: detachReason });
    for (const notifyStop of stopListeners) notifyStop();
  }

  async function waitPhase({ startOperation, milliseconds, deadlineReason }: {
    startOperation: () => Promise<void>;
    milliseconds: number;
    deadlineReason: 'run-deadline' | 'collection-deadline' | 'sealing-deadline';
  }): Promise<'settled' | 'rejected' | 'interrupted'> {
    const interrupted = Promise.withResolvers<'interrupted'>();
    const notifyStop = () => interrupted.resolve('interrupted');
    // Subscribe before invoking the owned boundary, including a synchronous
    // reentrant stop. Earlier stops do not discard the new partial-sealing phase.
    stopListeners.add(notifyStop);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'interrupted'>(resolve => {
      timer = setTimeout(() => {
        requestStop({ reason: deadlineReason });
        resolve('interrupted');
      }, milliseconds);
    });
    try {
      let operation: Promise<void>;
      try {
        operation = startOperation();
      } catch {
        return 'rejected';
      }
      const observe = operation.then(() => 'settled' as const, () => 'rejected' as const);
      // Start the owned operation and subscribe to its outcome/stop first. This
      // phase notification never interrupts Provider settlement-to-continuity.
      publishProgress();
      return await Promise.race([observe, deadline, interrupted.promise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      stopListeners.delete(notifyStop);
    }
  }

  function startSealing({ provider }: { provider: ProductionProviderCaptureSnapshot }): void {
    const transfer = detached;
    detached = undefined;
    if (transfer === undefined) throw new Error('Investigation native transfer is missing');
    sealOwnership = 'pending';
    // The helper synchronously creates its owned encoding plan. Neither this
    // coordinator nor its progress/result/session DTO retains the source raw body.
    sealWork = createProductionProviderNativeEvidence({ native: transfer.capture, provider, maximumBinaryBytes: maximumNativeBinaryBytes }).then(evidence => {
      if (canAdoptSeal()) {
        nativeEvidence = evidence;
        nativeEvidenceStatus = 'available';
      }
    }, () => {
      if (canAdoptSeal()) nativeEvidenceStatus = 'sealing-failed';
    }).finally(() => {
      sealOwnership = 'settled';
    });
  }

  function handleExecutionOutcome({ outcome }: { outcome: Awaited<ReturnType<typeof waitPhase>> }): void {
    switch (outcome) {
    case 'settled': case 'interrupted': break;
    case 'rejected': requestStop({ reason: 'execution-failed' }); break;
    default: { const exhaustive: never = outcome; throw new Error('Unhandled investigation outcome: ' + exhaustive); }
    }
  }

  async function run(): Promise<ProductionProviderInvestigationResult> {
    switch (invocation) {
    case 'started': throw new Error('Production Provider investigation can run only once');
    case 'not-started': break;
    default: { const exhaustive: never = invocation; throw new Error('Unhandled investigation invocation: ' + exhaustive); }
    }
    invocation = 'started';
    const progressTimer = setInterval(publishProgress, 250);
    try {
      if (stopReason === undefined) {
        phase = 'running';
        const outcome = await waitPhase({ startOperation: () => owner.run().then(() => undefined), milliseconds: deadlines.runMs, deadlineReason: 'run-deadline' });
        handleExecutionOutcome({ outcome });
      }
      if (stopReason === undefined) {
        phase = 'collecting';
        const outcome = await waitPhase({ startOperation: owner.collectNative, milliseconds: deadlines.collectionMs, deadlineReason: 'collection-deadline' });
        handleExecutionOutcome({ outcome });
      }
      if (cutoff === undefined) detach({ reason: 'normal-completion' });
      const disposing = startDisposal();
      const provider = anchor;
      if (provider === undefined || cutoff === undefined || anchorProgress === undefined) throw new Error('Production Provider cutoff observation is unavailable');
      let providerEvidence: 'available' | 'refused' = 'available';
      let providerOutput: ProductionProviderCaptureSnapshot | undefined;
      try {
        createProductionProviderCaptureEvidence({ capture: provider, runId, modelId });
        providerOutput = provider;
      } catch {
        providerEvidence = 'refused';
        nativeEvidenceStatus = 'provider-evidence-refused';
        detached = undefined;
      }
      switch (providerEvidence) {
      case 'refused': break;
      case 'available': {
        phase = 'sealing';
        const outcome = await waitPhase({ startOperation: () => {
          startSealing({ provider });
          if (sealWork === undefined) throw new Error('Investigation seal operation is missing');
          return sealWork;
        }, milliseconds: deadlines.sealingMs, deadlineReason: 'sealing-deadline' });
        switch (outcome) {
        case 'settled': case 'interrupted': break;
        case 'rejected':
          nativeEvidenceStatus = 'sealing-failed';
          sealOwnership = 'settled';
          break;
        default: { const exhaustive: never = outcome; throw new Error('Unhandled sealing outcome: ' + exhaustive); }
        }
        break;
      }
      default: { const exhaustive: never = providerEvidence; throw new Error('Unhandled Provider evidence: ' + exhaustive); }
      }
      await disposing.catch(() => undefined);
      phase = 'finished';
      publishProgress();
      return Object.freeze(exactObject<ProductionProviderInvestigationResult>()({
        provider: providerOutput,
        nativeEvidence,
        summary: Object.freeze({
          format: 'production-provider-investigation-v1', policy,
          completion: stopReason === undefined ? 'completed' : 'interrupted', stopReason,
          providerEvidence, providerProgress: anchorProgress, requests: summarizeRequests({ provider }), cutoff,
          nativeEvidenceStatus, cleanup, sealOwnership, progressCallbackFailures,
        }),
      }));
    } finally {
      clearInterval(progressTimer);
      // Even an unexpected synchronous failure cannot leave future adoption or
      // a detached raw payload reachable from this terminal coordinator.
      phase = 'finished';
      sealAdoption = 'closed';
      detached = undefined;
      void startDisposal();
    }
  }

  return {
    run, getProgress,
    interrupt({ reason }: { reason: 'user-requested' }): void {
      requestStop({ reason });
    },
    dispose(): Promise<void> {
      requestStop({ reason: 'disposed' });
      return startDisposal();
    },
    /** Call after run settles before returning pending seal capacity to a batch
     * budget. Disposal alone does not prevent the subsequent partial seal.
     * Adoption cutoff does not cancel WebCrypto or release its owned copies. */
    waitForEvidenceRelease(): Promise<void> {
      switch (phase) {
      case 'finished': return sealWork ?? Promise.resolve();
      case 'not-started': case 'running': case 'collecting': case 'sealing':
        return Promise.reject(new Error('Evidence release requires the investigation run to finish'));
      default: { const exhaustive: never = phase; throw new Error('Unhandled evidence release phase: ' + exhaustive); }
      }
    },
  };
}

export const TEST_ONLY = {
};
