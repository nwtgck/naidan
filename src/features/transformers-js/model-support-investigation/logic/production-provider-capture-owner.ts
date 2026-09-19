import { z } from 'zod';
import { createTransformersJsService } from '@/features/transformers-js/index-hosted';
import { createTransformersJsProvider } from '@/features/transformers-js/provider-hosted';
import type { TransformersJsWorkerClient } from '@/features/transformers-js/types';
import { exactObject } from '@/utils/exact-object';
import { createModelSupportWeatherTool } from './tool-protocol-fixture';
import { capturePlanSchema, captureScenarios, isCapturePlanV2, isCaptureScenarioSelected, captureScenarioInput, captureProviderMessages,
  type ProductionProviderCapturePlan, type CaptureScenario, type CaptureRequestInput } from './production-provider-capture-plan';
export type { ProductionProviderCapturePlan } from './production-provider-capture-plan';
import {
  createProductionProviderTrace,
  type ProductionProviderSettledSnapshot,
  type ProductionProviderTraceSnapshot,
} from './production-provider-trace';

type StopReason = 'provider-rejected' | 'capture-incomplete' | 'aborted' | 'disposed' | 'runtime-unavailable';
export type CaptureNotStartedReason = 'not-yet-started' | 'scope-not-selected' | 'first-settlement-unavailable' | 'legacy-script-stopped' | 'runtime-unavailable' | 'aborted' | 'deadline' | 'disposed';
type RunState = Readonly<{ status: 'not-started' | 'running' | 'completed' } | { status: 'stopped'; reason: StopReason }>;
export interface ProductionProviderCaptureRequestIdentity {
  readonly runId: string;
  readonly requestId: string;
  readonly scenario: CaptureScenario;
}
interface OwnerEvent {
  readonly sequence: number;
  readonly kind: 'run-started' | 'abort-requested' | 'dispose-requested' | 'dispose-completed' | 'dispose-failed';
  readonly activeRequestId: string | undefined;
}
interface CaptureSnapshotBase {
  readonly runId: string;
  readonly modelId: string;
  readonly run: RunState;
  readonly lifetime: 'open' | 'closing' | 'closed';
  readonly abortReason: 'user-requested' | 'deadline' | undefined;
  readonly disposal: 'not-requested' | 'pending' | 'completed' | 'failed';
  // No automatic late-callback window or native capture RPC is performed here.
  // Requesting disposal does not prove immediate physical cutoff, especially
  // while cleanup is pending/failed. Absence afterwards is not evidence.
  readonly observation: 'open' | 'end-requested-by-dispose';
  readonly events: readonly OwnerEvent[];
  readonly capabilities: Readonly<{
    providerCallbacks: 'bounded-projection';
    nativeInvocations: 'not-collected-by-this-owner';
    tools: 'not-selected' | 'fixed-public-weather-tool';
    images: 'not-selected' | 'fixed-public-image';
  }>;
}
type CaptureRequestSnapshot = Readonly<ProductionProviderCaptureRequestIdentity & {
  status: 'not-started' | 'awaiting-settlement' | 'settled';
  input: CaptureRequestInput | undefined;
  trace: ProductionProviderTraceSnapshot;
  notStartedReason: CaptureNotStartedReason | undefined;
}>;
export type ProductionProviderCaptureSnapshot = CaptureSnapshotBase & {
  readonly format: 'production-provider-capture-v2'; readonly plan: ProductionProviderCapturePlan; readonly requests: readonly CaptureRequestSnapshot[];
};

export interface ProductionProviderCaptureProgress {
  readonly runId: string;
  readonly modelId: string;
  readonly plan: ProductionProviderCapturePlan;
  readonly run: RunState;
  readonly lifetime: ProductionProviderCaptureSnapshot['lifetime'];
  readonly activeRequest: ProductionProviderCaptureRequestIdentity | undefined;
  readonly totalRequests: number;
  readonly selectedRequests: number;
  readonly settledRequests: number;
  readonly loadStatus: ReturnType<ReturnType<typeof createTransformersJsService>['service']['getState']>['status'];
}

const identitySchema = z.object({
  runId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/u),
  // This narrow investigation target is not a URL or remote-fetch capability.
  // Preserve the accepted spelling rather than normalizing model aliases here.
  modelId: z.string().max(256)
    .regex(/^(?:hf\.co\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
    .refine(value => value.split('/').every(part => part !== '.' && part !== '..')),
  plan: capturePlanSchema,
}).strict();

/**
 * Hosted investigation owner, never the ordinary service singleton. Uses the
 * real service and Provider implementations, including their Load, cloning,
 * abort and tool loop. The versioned fixed scripts offer no arbitrary messages/tools,
 * no Download operations, no native observer installation, and no timers.
 */
export function createProductionProviderCaptureOwner({ runId: inputRunId, modelId: inputModelId, plan: inputPlan, createWorkerClient, traceLimits }: {
  runId: string;
  modelId: string;
  plan: ProductionProviderCapturePlan;
  createWorkerClient: () => TransformersJsWorkerClient;
  traceLimits: Parameters<typeof createProductionProviderTrace>[0]['limits'];
}) {
  const { runId, modelId, plan } = identitySchema.parse({ runId: inputRunId, modelId: inputModelId, plan: inputPlan });
  const version2 = isCapturePlanV2({ plan });
  const requests = captureScenarios({ plan }).map((scenario): {
    identity: ProductionProviderCaptureRequestIdentity;
    input: CaptureRequestInput | undefined;
    notStartedReason: CaptureNotStartedReason | undefined;
    trace: ReturnType<typeof createProductionProviderTrace>;
  } => ({
    identity: Object.freeze({ runId, requestId: runId + '-' + scenario, scenario }),
    input: undefined,
    notStartedReason: isCaptureScenarioSelected({ plan, scenario }) ? 'not-yet-started' : 'scope-not-selected',
    trace: createProductionProviderTrace({ requestId: runId + '-' + scenario, limits: traceLimits }),
  }));
  const serviceOwner = createTransformersJsService({ createWorkerClient });
  const provider = createTransformersJsProvider({ service: serviceOwner.service });
  const controller = new AbortController();
  const selectedRequests = requests.filter(request => request.notStartedReason === 'not-yet-started').length;
  let settledRequests = 0;
  let lifetime: ProductionProviderCaptureSnapshot['lifetime'] = 'open';
  let runState: RunState = Object.freeze({ status: 'not-started' });
  let activeRequest: ProductionProviderCaptureRequestIdentity | undefined;
  let abortReason: ProductionProviderCaptureSnapshot['abortReason'];
  let disposal: ProductionProviderCaptureSnapshot['disposal'] = 'not-requested';
  let disposalPromise: Promise<void> | undefined;
  const events: OwnerEvent[] = [];

  function record({ kind }: { kind: OwnerEvent['kind'] }) {
    // At most one run, one abort, and two disposal events for this owner.
    events.push(Object.freeze({ sequence: events.length, kind, activeRequestId: activeRequest?.requestId }));
  }

  function observationStatus(): ProductionProviderCaptureSnapshot['observation'] {
    switch (disposal) {
    case 'not-requested': return 'open';
    case 'pending': case 'completed': case 'failed': return 'end-requested-by-dispose';
    default: {
      const exhaustive: never = disposal;
      throw new Error('Unhandled capture disposal: ' + exhaustive);
    }
    }
  }

  function isOpen(): boolean {
    switch (lifetime) {
    case 'open': return true;
    case 'closing': case 'closed': return false;
    default: {
      const exhaustive: never = lifetime;
      throw new Error('Unhandled capture lifetime: ' + exhaustive);
    }
    }
  }

  function snapshot(): ProductionProviderCaptureSnapshot {
    const base = exactObject<CaptureSnapshotBase>()({
      runId, modelId, run: runState, lifetime, abortReason, disposal,
      observation: observationStatus(),
      events: Object.freeze(events.slice()),
      capabilities: Object.freeze({
        providerCallbacks: 'bounded-projection', nativeInvocations: 'not-collected-by-this-owner',
        tools: isCaptureScenarioSelected({ plan, scenario: 'natural-tool-minimal' }) ? 'fixed-public-weather-tool' : 'not-selected',
        images: isCaptureScenarioSelected({ plan, scenario: 'image' }) ? 'fixed-public-image' : 'not-selected',
      }),
    });
    const capturedRequests = requests.map(({ identity, input, trace, notStartedReason }) => {
      const captured = trace.snapshot();
      return Object.freeze(exactObject<CaptureRequestSnapshot>()({
        ...identity,
        status: input === undefined ? 'not-started' : captured.settled === undefined ? 'awaiting-settlement' : 'settled',
        input, trace: captured, notStartedReason,
      }));
    });
    return Object.freeze(exactObject<ProductionProviderCaptureSnapshot>()({ ...base, format: 'production-provider-capture-v2', plan, requests: Object.freeze(capturedRequests) }));
  }

  function requestedStop(): StopReason | undefined {
    if (!isOpen()) return 'disposed';
    if (abortReason !== undefined) return 'aborted';
    return undefined;
  }

  function stop({ reason }: { reason: StopReason }): ProductionProviderCaptureSnapshot {
    runState = Object.freeze({ status: 'stopped', reason });
    for (const request of requests) {
      switch (request.notStartedReason) {
      case 'not-yet-started': break;
      case undefined: case 'scope-not-selected': case 'first-settlement-unavailable': case 'legacy-script-stopped':
      case 'runtime-unavailable': case 'aborted': case 'deadline': case 'disposed': continue;
      default: { const exhaustive: never = request.notStartedReason; throw new Error('Unhandled request state: ' + exhaustive); }
      }
      switch (reason) {
      case 'runtime-unavailable': case 'disposed': request.notStartedReason = reason; break;
      case 'aborted':
        switch (abortReason) {
        case 'deadline': request.notStartedReason = 'deadline'; break;
        case 'user-requested': request.notStartedReason = 'aborted'; break;
        case undefined: throw new Error('Capture abort has no recorded reason');
        default: { const exhaustive: never = abortReason; throw new Error('Unhandled abort reason: ' + exhaustive); }
        }
        break;
      case 'provider-rejected': case 'capture-incomplete': request.notStartedReason = 'legacy-script-stopped'; break;
      default: { const exhaustive: never = reason; throw new Error('Unhandled stop reason: ' + exhaustive); }
      }
    }
    return snapshot();
  }

  async function run(): Promise<ProductionProviderCaptureSnapshot> {
    if (!isOpen()) throw new Error('Provider capture owner is terminally disposed');
    const runStatus = runState.status;
    switch (runStatus) {
    case 'not-started': break;
    case 'running': case 'completed': case 'stopped': throw new Error('Provider capture owner can run only once');
    default: {
      const exhaustive: never = runStatus;
      throw new Error('Unhandled capture run status: ' + exhaustive);
    }
    }
    runState = Object.freeze({ status: 'running' });
    record({ kind: 'run-started' });
    let firstSettled: ProductionProviderSettledSnapshot | undefined;
    function retainFirstSettlement({ scenario, settled }: { scenario: CaptureScenario; settled: ProductionProviderSettledSnapshot }): void {
      switch (scenario) {
      case 'first-turn': firstSettled = settled; break;
      case 'continuity': case 'independent-next-input': case 'system-user': case 'supplied-history':
      case 'reasoning-none': case 'reasoning-low': case 'reasoning-medium': case 'reasoning-high':
      case 'natural-tool-minimal': case 'natural-tool-representative': case 'structured-tool-history': case 'image': break;
      default: { const exhaustive: never = scenario; throw new Error('Unhandled settled scenario: ' + exhaustive); }
      }
    }
    for (const request of requests) {
      const before = requestedStop();
      if (before !== undefined) {
        return stop({ reason: before });
      }
      if (!isCaptureScenarioSelected({ plan, scenario: request.identity.scenario })) continue;
      if (version2 && request.identity.scenario === 'continuity' && (firstSettled?.outcome.status !== 'fulfilled' || firstSettled.completeness !== 'complete')) {
        request.notStartedReason = 'first-settlement-unavailable';
        continue;
      }
      if (version2 && request.identity.scenario !== 'first-turn') {
        // The ordinary Provider may auto-load. Never let a later scenario repair
        // a lost runtime: only the initial request may trigger this owner's Load.
        const state = serviceOwner.service.getState();
        if (state.status !== 'ready' || state.activeModelId !== modelId) return stop({ reason: 'runtime-unavailable' });
      }
      request.input = captureScenarioInput({ scenario: request.identity.scenario, firstSettled });
      request.notStartedReason = undefined;
      const messages = captureProviderMessages({ input: request.input });
      const { parameters } = request.input;
      const tools = request.input.tools.length === 0 ? [] : [createModelSupportWeatherTool()];
      activeRequest = request.identity;
      let settled: ProductionProviderSettledSnapshot;
      try {
        // Direct await: do not interpose a wrapped chat Promise, extra reaction,
        // trace RPC, callback drain or timer before taking the settled snapshot.
        await provider.chat({
          model: modelId, messages, parameters, tools,
          ...request.trace.callbacks, signal: controller.signal,
        });
      } catch (error) {
        settled = request.trace.settle({ outcome: 'rejected', error });
        settledRequests += 1;
        activeRequest = undefined;
        if (!version2) return stop({ reason: requestedStop() ?? 'provider-rejected' });
        retainFirstSettlement({ scenario: request.identity.scenario, settled });
        const after = requestedStop();
        if (after !== undefined) return stop({ reason: after });
        continue;
      }
      settled = request.trace.settle({ outcome: 'fulfilled', error: undefined });
      settledRequests += 1;
      activeRequest = undefined;
      retainFirstSettlement({ scenario: request.identity.scenario, settled });
      const after = requestedStop();
      if (after !== undefined || (!version2 && settled.completeness !== 'complete')) {
        return stop({ reason: after ?? 'capture-incomplete' });
      }
      // Build the next request immediately from this immutable settlement.
      // No export, native-capture RPC or observation-window delay belongs here.
    }
    runState = Object.freeze({ status: 'completed' });
    // Keep callbacks and the loaded owner alive until explicit disposal. A
    // completed script does not claim complete/native generation or no late text.
    return snapshot();
  }

  function abort({ reason }: { reason: 'user-requested' | 'deadline' }): void {
    if (!isOpen() || abortReason !== undefined) return;
    abortReason = z.enum(['user-requested', 'deadline']).parse(reason);
    record({ kind: 'abort-requested' });
    controller.abort();
  }

  function dispose(): Promise<void> {
    if (disposalPromise !== undefined) return disposalPromise;
    lifetime = 'closing';
    disposal = 'pending';
    record({ kind: 'dispose-requested' });
    // Terminal service disposal starts synchronously. Do not wait for chat,
    // interrupt, graceful unload or a late-callback window before requesting it.
    disposalPromise = serviceOwner.dispose().then(() => {
      lifetime = 'closed';
      disposal = 'completed';
      record({ kind: 'dispose-completed' });
    }, error => {
      lifetime = 'closed';
      disposal = 'failed';
      record({ kind: 'dispose-failed' });
      throw error;
    });
    // Own rejection even if a caller takes only a partial snapshot on teardown.
    // Returning the same Promise still preserves the cleanup error for awaiters.
    void disposalPromise.catch(() => undefined);
    return disposalPromise;
  }

  return {
    run, snapshot, abort, dispose,
    /** Sampling must neither copy captured output nor interpose UI callbacks
     * between direct chat settlement and the next continuity request. */
    getProgress(): ProductionProviderCaptureProgress {
      return Object.freeze(exactObject<ProductionProviderCaptureProgress>()({
        runId, modelId, plan, run: runState, lifetime, activeRequest,
        totalRequests: requests.length, selectedRequests, settledRequests,
        loadStatus: serviceOwner.service.getState().status,
      }));
    },
    /** Synchronous per-call correlation view for an owned capture-aware client. */
    getActiveRequest(): ProductionProviderCaptureRequestIdentity | undefined {
      return activeRequest;
    },
  };
}

export const TEST_ONLY = {
};
