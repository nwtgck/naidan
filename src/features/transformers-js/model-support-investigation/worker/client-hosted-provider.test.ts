// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFiles } from '@/features/transformers-js/replay-models/support/download-memory-files';
import type { GenerationCaptureClient, GenerationCaptureRequest } from '@/features/transformers-js/worker/generation-capture-protocol';
import type { TransformersJsWorkerClient } from '@/features/transformers-js/types';
import { createInitialInvestigationCheckpoint } from '@/features/transformers-js/model-support-investigation/logic/investigation-recovery';
import { toPlanningWorkerRun } from '@/features/transformers-js/model-support-investigation/logic/planning-worker-run';
import { configurationForPreset } from '@/features/transformers-js/model-support-investigation/logic/investigation-config';
import type { ModelSupportInvestigationCheckpoint, ModelSupportInvestigationPlanningRequest } from '@/features/transformers-js/model-support-investigation/types';
import * as nativeEvidence from '@/features/transformers-js/model-support-investigation/logic/production-provider-native-evidence';

const mocks = vi.hoisted(() => ({
  release: Symbol('release'), planning: vi.fn(), candidate: vi.fn(), template: vi.fn(),
  captureClient: vi.fn(), unrecordedClient: vi.fn(), acceptance: vi.fn(), legacyProduction: vi.fn(),
  workers: [] as Array<{ terminate: ReturnType<typeof vi.fn> }>,
}));
vi.mock('comlink', () => ({ releaseProxy: mocks.release, proxy: (value: unknown) => value, wrap: () => ({
  runPartialInvestigation: mocks.planning, runCandidateAttempt: mocks.candidate,
  inspectDownloadedTemplateBehavior: mocks.template, [mocks.release]: async () => undefined,
}) }));
vi.mock('@/features/transformers-js/worker/client-hosted', () => ({
  createTransformersJsGenerationCaptureClient: mocks.captureClient,
  createTransformersJsWorkerClient: mocks.unrecordedClient,
}));
vi.mock('@/features/transformers-js/download-verification/logic/complete-download-verification-runtime-evidence', () => ({ completeDownloadVerificationRuntimeEvidence: mocks.acceptance }));
vi.mock('../logic/run-production-lane-comparison', () => ({ runProductionLaneComparison: mocks.legacyProduction }));

let files: ReturnType<typeof createMemoryFiles>;
let client: TransformersJsWorkerClient;
let take: ReturnType<typeof vi.fn<GenerationCaptureClient['takeGenerationCapture']>>;
const clients: Array<{ dispose(): Promise<void> }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workers.length = 0;
  files = createMemoryFiles();
  files.enter({ nextPhase: 'load', mutationPolicy: 'read-only' });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => files.root } });
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('External fetch is forbidden');
  }));
  vi.stubGlobal('Worker', class {
    terminate = vi.fn();
    constructor() {
      mocks.workers.push(this);
    }
  });
  mocks.planning.mockImplementation(async ({ runId, modelId }: ModelSupportInvestigationPlanningRequest) => {
    const run = createInitialInvestigationCheckpoint({ runId, modelId, now: () => '2026-09-10T00:00:00.000Z' }).run;
    run.status = 'passed';
    run.error = undefined;
    run.completedAt = '2026-09-10T00:00:01.000Z';
    // This fixture returns a completed planning preflight, not its initial
    // running checkpoint. Other unobserved planning scopes remain not-run.
    run.steps = run.steps.map(step => step.id === 'runtime-assets'
      ? { ...step, status: 'passed', detail: 'Synthetic runtime preflight completed' } : step);
    return toPlanningWorkerRun({ run });
  });
  client = {
    loadDownloadedModel: vi.fn<TransformersJsWorkerClient['loadDownloadedModel']>().mockResolvedValue({ device: 'webgpu' }),
    generateText: vi.fn<TransformersJsWorkerClient['generateText']>().mockResolvedValue(undefined),
    interrupt: vi.fn<TransformersJsWorkerClient['interrupt']>().mockResolvedValue(undefined),
    unloadModel: vi.fn<TransformersJsWorkerClient['unloadModel']>().mockResolvedValue(undefined),
    resetCache: vi.fn<TransformersJsWorkerClient['resetCache']>().mockResolvedValue(undefined),
    dispose: vi.fn<TransformersJsWorkerClient['dispose']>().mockResolvedValue(undefined),
  };
  take = vi.fn<GenerationCaptureClient['takeGenerationCapture']>().mockResolvedValue({ status: 'not-started' });
  mocks.captureClient.mockImplementation(({ runId, workerEpoch, getActiveRequest }) => {
    const issuedCalls: GenerationCaptureRequest['context'][] = [];
    vi.mocked(client.generateText).mockImplementation(async ({ onChunk }) => {
      const request = getActiveRequest();
      issuedCalls.push({ runId, workerEpoch, requestId: request.requestId, generationCallId: issuedCalls.length + 1 });
      onChunk({ chunk: 'Synthetic public reply.' });
    });
    return { client, takeGenerationCapture: take, getCaptureLifetime: () => ({ runId, workerEpoch, session: 'active', issuedCalls, loadRequests: [], incompleteReasons: [] }) };
  });
  mocks.unrecordedClient.mockReturnValue(client);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map(value => value.dispose().catch(() => undefined)));
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(files.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// The hosted routing, coordinator and public Provider/service are real. Only
// planning transport and the Production Worker-client platform are controlled.
describe('exclusive hosted Provider investigation routing', () => {
  it('runs Full once with the initial host identity through planning and Provider collection', async () => {
    const { createModelSupportInvestigationWorkerClient } = await import('./client-hosted');
    const host = createModelSupportInvestigationWorkerClient();
    clients.push(host);
    const checkpoints: ModelSupportInvestigationCheckpoint[] = [];
    const result = await host.runPartialInvestigation({ modelId: 'org/model', configuration: configurationForPreset({ preset: 'full' }), onEvent: vi.fn(), onCheckpoint: ({ checkpoint }) => checkpoints.push(checkpoint) });
    expect(mocks.captureClient).toHaveBeenCalledOnce();
    const runId = checkpoints[0]?.run.runId;
    expect(runId).toBeDefined();
    expect(mocks.planning).toHaveBeenCalledWith(expect.objectContaining({ runId }), expect.any(Function), expect.any(Function), expect.any(Function));
    expect(new Set(checkpoints.map(checkpoint => checkpoint.run.runId))).toEqual(new Set([runId]));
    expect(result.runId).toBe(runId);
    expect(mocks.captureClient).toHaveBeenCalledWith(expect.objectContaining({ runId, workerEpoch: 1 }));
    expect(client.loadDownloadedModel).toHaveBeenCalledOnce();
    expect(client.generateText).toHaveBeenCalledTimes(13);
    expect(take).toHaveBeenCalledOnce();
    expect(mocks.acceptance).not.toHaveBeenCalled();
    expect(mocks.template).not.toHaveBeenCalled();
    expect(mocks.candidate).not.toHaveBeenCalled();
    expect(mocks.legacyProduction).not.toHaveBeenCalled();
    expect(result.productionProviderCapture?.runId).toBe(runId);
    expect(result.productionProviderInvestigation?.providerProgress.runId).toBe(runId);
    expect(result.loadAttempts).toEqual([]);
    expect(result.productionLane.status).toBe('not-run');
    expect(checkpoints.at(-1)?.nativeEvidence?.summary.phase).toBe('finished');
    expect(checkpoints.at(-1)?.nativeEvidence?.summary.recording).toBe('not-recorded');
    expect(result.productionProviderInvestigation?.nativeEvidenceStatus).toBe('available');
    expect(result.status).toBe('failed');
    expect(result.currentOperation).toContain('native recording=not-recorded');
    expect(mocks.workers).toHaveLength(1);
  });

  it('uses the same public script offline without legacy runtime permission', async () => {
    const { createModelSupportInvestigationWorkerClient } = await import('./client-hosted');
    const host = createModelSupportInvestigationWorkerClient();
    clients.push(host);
    const result = await host.runPartialInvestigation({ modelId: 'org/model', configuration: configurationForPreset({ preset: 'offline' }), onEvent: vi.fn(), onCheckpoint: vi.fn() });
    expect(mocks.planning.mock.calls[0]?.[0]).toMatchObject({ externalNetworkPolicy: 'deny' });
    expect(result.productionProviderCapture?.plan).toBe('full-v2');
    expect(client.loadDownloadedModel).toHaveBeenCalledOnce();
    expect(client.generateText).toHaveBeenCalledTimes(13);
    expect(mocks.acceptance).not.toHaveBeenCalled();
    expect(mocks.template).not.toHaveBeenCalled();
    expect(mocks.candidate).not.toHaveBeenCalled();
    expect(mocks.legacyProduction).not.toHaveBeenCalled();
  });

  it('retains a partial native sidecar without promoting fulfilled Provider requests to complete observation', async () => {
    const original = mocks.captureClient.getMockImplementation()!;
    mocks.captureClient.mockImplementation(input => {
      const capture: GenerationCaptureClient = original(input);
      take.mockImplementation(async () => {
        const context = capture.getCaptureLifetime().issuedCalls[0];
        if (context === undefined) throw new Error('Expected a host-issued first request');
        return { status: 'captured', capture: {
          schemaVersion: 1, runId: input.runId, workerEpoch: input.workerEpoch, byteOrder: 'little-endian',
          limits: input.limits,
          calls: [{ context, loadIdentity: { status: 'not-observed', reason: 'no-completed-load' }, outcome: 'fulfilled',
            invocations: [{ nativeInvocationOrdinal: 1, stream: { status: 'not-attempted' } }] }],
          events: [{ kind: 'native-call', identity: { ...context, nativeInvocationOrdinal: 1 }, phase: 'entering' }],
          incompleteReasons: [], unobserved: ['native-stop-cause', 'native-forward-input', 'kv-bytes'],
        } };
      });
      return capture;
    });
    const { createModelSupportInvestigationWorkerClient } = await import('./client-hosted');
    const host = createModelSupportInvestigationWorkerClient();
    clients.push(host);
    const checkpoints: ModelSupportInvestigationCheckpoint[] = [];
    const result = await host.runPartialInvestigation({ modelId: 'org/model', configuration: configurationForPreset({ preset: 'full' }), onEvent: vi.fn(), onCheckpoint: ({ checkpoint }) => checkpoints.push(checkpoint) });
    expect(result.productionProviderInvestigation?.requests.every(request => request.outcome === 'fulfilled')).toBe(true);
    expect(result.productionProviderInvestigation?.nativeEvidenceStatus).toBe('available');
    expect(checkpoints.at(-1)?.nativeEvidence?.summary).toMatchObject({
      recording: 'partial', capturedCallCount: 1, enteredNativeInvocationCount: 1,
      issuedNotObservedCallCount: 12, incompleteInvocationCount: 1, unobservedLoadCount: 1,
    });
    expect(result.status).toBe('failed');
    expect(result.currentOperation).toContain('native recording=partial');
    expect(take).toHaveBeenCalledOnce();
  });

  it('retains scope-unselected requests without executing or counting them as blocked', async () => {
    const { createModelSupportInvestigationWorkerClient } = await import('./client-hosted');
    const host = createModelSupportInvestigationWorkerClient();
    clients.push(host);
    const configuration = configurationForPreset({ preset: 'offline' });
    configuration.scope.continuity = 'not-selected';
    configuration.scope['capability-probes'] = 'not-selected';
    const result = await host.runPartialInvestigation({ modelId: 'org/model', configuration, onEvent: vi.fn(), onCheckpoint: vi.fn() });
    expect(result.productionProviderCapture?.plan).toBe('generation-v2');
    expect(client.generateText).toHaveBeenCalledTimes(3);
    expect(result.productionProviderInvestigation?.requests.filter(request => request.notStartedReason === 'scope-not-selected')).toHaveLength(10);
    expect(result.currentOperation).toContain('0 unexecuted');
  });

  it('adopts one sealed partial after user interruption and rejects late generation callbacks', async () => {
    const { createModelSupportInvestigationWorkerClient } = await import('./client-hosted');
    const host = createModelSupportInvestigationWorkerClient();
    clients.push(host);
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<void>();
    let onChunk: Parameters<TransformersJsWorkerClient['generateText']>[0]['onChunk'] | undefined;
    const original = mocks.captureClient.getMockImplementation()!;
    mocks.captureClient.mockImplementation(input => {
      const capture = original(input);
      vi.mocked(client.generateText).mockImplementation(async input => {
        onChunk = input.onChunk;
        entered.resolve();
        await pending.promise;
      });
      return capture;
    });
    const checkpoints: ModelSupportInvestigationCheckpoint[] = [];
    const onEvent = vi.fn<Parameters<typeof host.runPartialInvestigation>[0]['onEvent']>();
    const operation = host.runPartialInvestigation({ modelId: 'org/model', configuration: configurationForPreset({ preset: 'full' }), onEvent, onCheckpoint: ({ checkpoint }) => checkpoints.push(checkpoint) });
    const rejected = expect(operation).rejects.toMatchObject({ name: 'ModelSupportInvestigationUserInterruptedError' });
    await entered.promise;
    await host.interrupt();
    expect(client.dispose).toHaveBeenCalledOnce();
    await rejected;
    const terminal = checkpoints.filter(checkpoint => checkpoint.run.productionProviderInvestigation !== undefined);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.run.productionProviderCapture?.requests[0]?.status).toBe('awaiting-settlement');
    expect(terminal[0]?.nativeEvidence?.summary.phase).toBe('not-requested');
    expect(onEvent.mock.calls.flatMap(([{ event }]) => event.productionProviderProgress === undefined ? [] : [event.productionProviderProgress.progress.phase])).toEqual(['not-started', 'running', 'sealing', 'finished']);
    expect(terminal[0]?.run.productionProviderInvestigation?.progressCallbackFailures).toBe(0);
    const count = checkpoints.length;
    onChunk?.({ chunk: 'Late private callback' });
    pending.resolve();
    await Promise.resolve();
    expect(checkpoints).toHaveLength(count);
    expect(JSON.stringify(terminal)).not.toContain('Late private callback');
    expect(take).not.toHaveBeenCalled();
    await host.waitForEvidenceRelease();
  });

  it('does not publish a final capture into a disposed host after its late seal finishes', async () => {
    const { createModelSupportInvestigationWorkerClient } = await import('./client-hosted');
    const host = createModelSupportInvestigationWorkerClient();
    clients.push(host);
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<nativeEvidence.ProductionProviderNativeEvidenceSidecar>();
    vi.spyOn(nativeEvidence, 'createProductionProviderNativeEvidence').mockImplementation(() => {
      entered.resolve(); return pending.promise;
    });
    const checkpoints: ModelSupportInvestigationCheckpoint[] = [];
    const operation = host.runPartialInvestigation({ modelId: 'org/model', configuration: configurationForPreset({ preset: 'full' }), onEvent: vi.fn(), onCheckpoint: ({ checkpoint }) => checkpoints.push(checkpoint) });
    const rejected = expect(operation).rejects.toMatchObject({ name: 'ModelSupportInvestigationUserInterruptedError' });
    await entered.promise;
    const count = checkpoints.length;
    await host.dispose();
    await rejected;
    expect(checkpoints).toHaveLength(count);
    pending.reject(new Error('Late seal error'));
    await host.waitForEvidenceRelease();
    expect(checkpoints).toHaveLength(count);
  });

  it('does not refund future native ownership before run or reuse the same host for another target', async () => {
    const { createModelSupportInvestigationWorkerClient } = await import('./client-hosted');
    const host = createModelSupportInvestigationWorkerClient();
    clients.push(host);
    await expect(host.waitForEvidenceRelease()).rejects.toThrow('requires the investigation run to finish');
    await host.runPartialInvestigation({ modelId: 'org/model', configuration: configurationForPreset({ preset: 'full' }), onEvent: vi.fn(), onCheckpoint: vi.fn() });
    await host.waitForEvidenceRelease();
    await expect(host.runPartialInvestigation({ modelId: 'org/next', configuration: configurationForPreset({ preset: 'full' }), onEvent: vi.fn(), onCheckpoint: vi.fn() })).rejects.toThrow('only once');
    expect(client.loadDownloadedModel).toHaveBeenCalledOnce();
  });
});
