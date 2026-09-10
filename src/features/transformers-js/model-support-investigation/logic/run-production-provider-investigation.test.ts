// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransformersJsWorkerClient } from '@/features/transformers-js/types';
import type { GenerationCaptureReadResult, GenerationCaptureRequest } from '@/features/transformers-js/worker/generation-capture-protocol';
import { createMemoryFiles } from '@/features/transformers-js/download-verification/fixtures/raw-download-replay/memory-files';
import * as nativeEvidence from './production-provider-native-evidence';
import * as providerEvidence from './production-provider-capture-evidence';
import * as captureOwner from './production-provider-generation-capture-owner';
import { createProductionProviderInvestigation } from './run-production-provider-investigation';
import { validateProductionProviderInvestigationLiveProgress } from './production-provider-investigation-summary';

type Arguments = Parameters<typeof createProductionProviderInvestigation>[0];
const investigations: ReturnType<typeof createProductionProviderInvestigation>[] = [];
let fs: ReturnType<typeof createMemoryFiles>;

function fixture({ plan }: { plan: Arguments['plan'] }) {
  const entered = Promise.withResolvers<void>();
  const taking = Promise.withResolvers<void>();
  let session: 'active' | 'inactive' = 'active';
  const issuedCalls: GenerationCaptureRequest['context'][] = [];
  const client = {
    loadDownloadedModel: vi.fn<TransformersJsWorkerClient['loadDownloadedModel']>().mockResolvedValue({ device: 'webgpu' }),
    generateText: vi.fn<TransformersJsWorkerClient['generateText']>().mockResolvedValue(undefined),
    interrupt: vi.fn<TransformersJsWorkerClient['interrupt']>().mockResolvedValue(undefined),
    unloadModel: vi.fn<TransformersJsWorkerClient['unloadModel']>().mockResolvedValue(undefined),
    resetCache: vi.fn<TransformersJsWorkerClient['resetCache']>().mockResolvedValue(undefined),
    dispose: vi.fn<TransformersJsWorkerClient['dispose']>(async () => {
      session = 'inactive';
    }),
  } satisfies TransformersJsWorkerClient;
  const take = vi.fn<() => Promise<GenerationCaptureReadResult>>(async () => {
    taking.resolve();
    return { status: 'not-started' };
  });
  const createCaptureClient = vi.fn<Arguments['createCaptureClient']>(({ runId, workerEpoch, getActiveRequest }) => {
    client.generateText.mockImplementation(async ({ onChunk }) => {
      const request = getActiveRequest();
      if (request === undefined) throw new Error('Expected public request');
      issuedCalls.push({ runId, workerEpoch, requestId: request.requestId, generationCallId: issuedCalls.length + 1 });
      entered.resolve();
      onChunk({ chunk: 'Synthetic reply.' });
    });
    return { client, takeGenerationCapture: take, getCaptureLifetime: () => ({
      runId, workerEpoch, session, issuedCalls, loadRequests: [], incompleteReasons: [],
    }) };
  });
  const onProgress = vi.fn<Arguments['onProgress']>();
  const createUnrecordedWorkerClient = vi.fn(() => client);
  const investigation = createProductionProviderInvestigation({
    runId: 'synthetic-run', modelId: 'fixture/model', plan,
    createCaptureClient, createUnrecordedWorkerClient, maximumWorkerEpochs: 8,
    maximumNativeBinaryBytes: 1024,
    deadlines: { runMs: 1000, collectionMs: 1000, sealingMs: 1000, cleanupMs: 100 }, onProgress,
  });
  investigations.push(investigation);
  return { investigation, client, createCaptureClient, createUnrecordedWorkerClient, take, entered, taking, onProgress };
}

beforeEach(() => {
  vi.useFakeTimers();
  fs = createMemoryFiles();
  fs.enter({ nextPhase: 'load', mutationPolicy: 'read-only' });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => fs.root } });
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('Network is forbidden');
  }));
});

afterEach(async () => {
  const cleanup = investigations.splice(0).map(investigation => investigation.dispose().catch(() => undefined));
  await vi.runAllTimersAsync();
  await Promise.all(cleanup);
  expect(vi.getTimerCount()).toBe(0);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Real Provider/service/collection ownership; only the Worker client and slow
// evidence-sealing boundary are controlled. This is not a Comlink/GPU test.
describe('bounded Production Provider investigation', () => {
  it('validates completed collection progress when a failed first request blocked only continuity', async () => {
    const { investigation, createCaptureClient, client, onProgress } = fixture({ plan: 'full-v2' });
    const original = createCaptureClient.getMockImplementation()!;
    createCaptureClient.mockImplementation(input => {
      const capture = original(input);
      client.generateText.mockRejectedValueOnce(new Error('First request failed'));
      return capture;
    });
    onProgress.mockImplementation(({ progress }) => {
      validateProductionProviderInvestigationLiveProgress({ value: { progress, deadlines: { runMs: 1000, collectionMs: 1000, sealingMs: 1000, cleanupMs: 100 } }, runId: 'synthetic-run', modelId: 'fixture/model' });
    });
    const result = await investigation.run();
    expect(result.summary.requests[1]).toMatchObject({ scenario: 'continuity', status: 'not-started', notStartedReason: 'first-settlement-unavailable' });
    expect(result.summary.providerProgress).toMatchObject({ run: { status: 'completed' }, selectedRequests: 13, settledRequests: 12 });
    expect(result.summary.progressCallbackFailures).toBe(0);
    expect(client.generateText).toHaveBeenCalledTimes(12);
  });
  it('publishes every immediate phase boundary without waiting for the sampling timer', async () => {
    const { investigation, onProgress } = fixture({ plan: 'first-only' });
    await investigation.run();
    expect(onProgress.mock.calls.map(([{ progress }]) => progress.phase)).toEqual(['running', 'collecting', 'sealing', 'finished']);
    expect(onProgress.mock.calls[0]?.[0].progress.provider.settledRequests).toBe(0);
    expect(onProgress.mock.calls.at(-1)?.[0].progress.provider.settledRequests).toBe(1);
  });
  it('collects once, starts disposal before sealing and retains only sealed evidence', async () => {
    const { investigation, client, take } = fixture({ plan: 'first-only' });
    const realSeal = nativeEvidence.createProductionProviderNativeEvidence;
    const seal = vi.spyOn(nativeEvidence, 'createProductionProviderNativeEvidence').mockImplementation(input => {
      expect(client.dispose).toHaveBeenCalledOnce();
      return realSeal(input);
    });
    const result = await investigation.run();
    expect(result.summary).toMatchObject({ completion: 'completed', providerEvidence: 'available', nativeEvidenceStatus: 'available', cleanup: 'completed', sealOwnership: 'settled' });
    expect(result.provider?.requests[0]?.trace.settled?.outcome).toEqual({ status: 'fulfilled' });
    expect(result.nativeEvidence?.summary.phase).toBe('finished');
    expect(take).toHaveBeenCalledOnce();
    expect(seal).toHaveBeenCalledOnce();
    expect(result).not.toHaveProperty('native');
    investigation.interrupt({ reason: 'user-requested' });
    expect(investigation.getProgress().stopReason).toBeUndefined();
    await expect(investigation.run()).rejects.toThrow('only once');
  });

  it('preserves an unstarted anchor when stopped before run without creating a Worker', async () => {
    const { investigation, createCaptureClient, take } = fixture({ plan: 'first-only' });
    investigation.interrupt({ reason: 'user-requested' });
    const result = await investigation.run();
    expect(result.summary.stopReason).toBe('user-requested');
    expect(result.provider?.run.status).toBe('not-started');
    expect(result.summary.cutoff.phaseAtCutoff).toBe('not-requested');
    expect(createCaptureClient).not.toHaveBeenCalled();
    expect(take).not.toHaveBeenCalled();
  });

  it('retains Provider request summaries if serialization is refused without attempting native sealing', async () => {
    const { investigation } = fixture({ plan: 'first-only' });
    vi.spyOn(providerEvidence, 'createProductionProviderCaptureEvidence').mockImplementation(() => {
      throw new Error('Private diagnostic');
    });
    const seal = vi.spyOn(nativeEvidence, 'createProductionProviderNativeEvidence');
    const result = await investigation.run();
    expect(result.provider).toBeUndefined();
    expect(result.nativeEvidence).toBeUndefined();
    expect(result.summary).toMatchObject({ providerEvidence: 'refused', nativeEvidenceStatus: 'provider-evidence-refused', requests: [{ requestId: 'synthetic-run-first-turn', scenario: 'first-turn', status: 'settled', outcome: 'fulfilled', completeness: 'complete' }] });
    expect(JSON.stringify(result.summary)).not.toContain('Synthetic reply.');
    expect(JSON.stringify(result.summary)).not.toContain('Private diagnostic');
    expect(seal).not.toHaveBeenCalled();
  });

  it('keeps cutoff progress consistent with its pending Provider anchor after a late settlement', async () => {
    const { investigation, createCaptureClient, entered, client, take } = fixture({ plan: 'first-only' });
    const original = createCaptureClient.getMockImplementation()!;
    const pending = Promise.withResolvers<void>();
    createCaptureClient.mockImplementation(input => {
      const capture = original(input);
      client.generateText.mockImplementation(async () => {
        entered.resolve(); await pending.promise;
      });
      return capture;
    });
    const sealing = Promise.withResolvers<nativeEvidence.ProductionProviderNativeEvidenceSidecar>();
    const sealEntered = Promise.withResolvers<void>();
    vi.spyOn(nativeEvidence, 'createProductionProviderNativeEvidence').mockImplementation(() => {
      sealEntered.resolve(); return sealing.promise;
    });
    const running = investigation.run();
    await entered.promise;
    investigation.interrupt({ reason: 'user-requested' });
    await sealEntered.promise;
    pending.resolve();
    sealing.reject(new Error('Synthetic seal failure'));
    const result = await running;
    expect(result.provider?.requests[0]?.status).toBe('awaiting-settlement');
    expect(result.summary.providerProgress.settledRequests).toBe(0);
    expect(result.summary.providerProgress.run.status).toBe('running');
    expect(result.summary.providerProgress.loadStatus).toBe('ready');
    expect(result.summary.providerProgress.lifetime).toBe('open');
    expect(result.provider?.lifetime).toBe('open');
    expect(result.provider?.abortReason).toBeUndefined();
    expect(result.summary.stopReason).toBe('user-requested');
    expect(take).not.toHaveBeenCalled();
  });

  it('stops physically when the first cutoff observation fails without substituting a later anchor', async () => {
    const original = captureOwner.createProductionProviderGenerationCaptureOwner;
    const snapshot = vi.fn(() => {
      throw new Error('Unexportable observation detail');
    });
    vi.spyOn(captureOwner, 'createProductionProviderGenerationCaptureOwner').mockImplementation(input => ({ ...original(input), snapshotProvider: snapshot }));
    const { investigation, client, entered, createCaptureClient } = fixture({ plan: 'first-only' });
    const originalClient = createCaptureClient.getMockImplementation()!;
    createCaptureClient.mockImplementation(input => {
      const result = originalClient(input);
      client.generateText.mockImplementation(async () => {
        entered.resolve(); await new Promise(() => undefined);
      });
      return result;
    });
    const running = investigation.run();
    const rejected = expect(running).rejects.toThrow('Production Provider cutoff observation is unavailable');
    await entered.promise;
    expect(() => investigation.interrupt({ reason: 'user-requested' })).not.toThrow();
    expect(client.dispose).toHaveBeenCalledOnce();
    investigation.interrupt({ reason: 'user-requested' });
    await rejected;
    expect(snapshot).toHaveBeenCalledOnce();
    await investigation.waitForEvidenceRelease();
  });

  it('honors a new dispose during partial sealing without waiting for the sealing deadline', async () => {
    const { investigation, take, taking } = fixture({ plan: 'first-only' });
    const pendingTake = Promise.withResolvers<GenerationCaptureReadResult>();
    take.mockImplementation(() => {
      taking.resolve(); return pendingTake.promise;
    });
    const sealing = Promise.withResolvers<nativeEvidence.ProductionProviderNativeEvidenceSidecar>();
    const sealEntered = Promise.withResolvers<void>();
    vi.spyOn(nativeEvidence, 'createProductionProviderNativeEvidence').mockImplementation(() => {
      sealEntered.resolve(); return sealing.promise;
    });
    const running = investigation.run();
    await taking.promise;
    await vi.advanceTimersByTimeAsync(1000);
    await sealEntered.promise;
    await investigation.dispose();
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    const result = await running;
    expect(result.summary).toMatchObject({ stopReason: 'collection-deadline', nativeEvidenceStatus: 'sealing-interrupted', sealOwnership: 'pending' });
    let released = false;
    void investigation.waitForEvidenceRelease().then(() => {
      released = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toBe(false);
    sealing.reject(new Error('Late seal rejection'));
    pendingTake.resolve({ status: 'not-started' });
    await investigation.waitForEvidenceRelease();
    expect(result.summary.sealOwnership).toBe('pending');
    expect(result.nativeEvidence).toBeUndefined();
  });

  it('cuts off a pending generation at the run deadline without native take or a fabricated settlement', async () => {
    const { investigation, createCaptureClient, entered, client, take } = fixture({ plan: 'first-only' });
    const original = createCaptureClient.getMockImplementation()!;
    const pending = Promise.withResolvers<void>();
    createCaptureClient.mockImplementation(input => {
      const capture = original(input);
      client.generateText.mockImplementation(async () => {
        entered.resolve(); await pending.promise;
      });
      return capture;
    });
    const running = investigation.run();
    await entered.promise;
    await vi.advanceTimersByTimeAsync(1000);
    const result = await running;
    expect(result.summary).toMatchObject({ stopReason: 'run-deadline', completion: 'interrupted', cutoff: { reason: 'run-deadline', phaseAtCutoff: 'not-requested' } });
    expect(result.provider?.requests[0]).toMatchObject({ status: 'awaiting-settlement', trace: { settled: undefined } });
    expect(result.nativeEvidence?.summary.phase).toBe('not-requested');
    expect(client.dispose).toHaveBeenCalledOnce();
    expect(take).not.toHaveBeenCalled();
    pending.reject(new Error('Late ordinary generation rejection'));
    await vi.advanceTimersByTimeAsync(0);
    expect(result.provider?.requests[0]?.status).toBe('awaiting-settlement');
    expect(result.summary.stopReason).toBe('run-deadline');
  });

  it('keeps a pending collection in its sealed partial after its late reply', async () => {
    const { investigation, take, taking, client } = fixture({ plan: 'first-only' });
    const pending = Promise.withResolvers<GenerationCaptureReadResult>();
    take.mockImplementation(() => {
      taking.resolve(); return pending.promise;
    });
    const running = investigation.run();
    await taking.promise;
    await vi.advanceTimersByTimeAsync(1000);
    const result = await running;
    expect(result.summary).toMatchObject({ stopReason: 'collection-deadline', cutoff: { phaseAtCutoff: 'collecting', epochs: [{ collectionStatus: 'pending' }] } });
    expect(result.nativeEvidence?.summary.phase).toBe('collecting');
    const json = result.nativeEvidence?.json;
    pending.resolve({ status: 'not-started' });
    await vi.advanceTimersByTimeAsync(0);
    expect(result.nativeEvidence?.json).toBe(json);
    expect(take).toHaveBeenCalledOnce();
    expect(client.dispose).toHaveBeenCalledOnce();
  });

  it('does not adopt late successful sealing or release its pending capacity at the adoption deadline', async () => {
    const { investigation } = fixture({ plan: 'first-only' });
    const realSeal = nativeEvidence.createProductionProviderNativeEvidence;
    const originalEvidence = Promise.withResolvers<nativeEvidence.ProductionProviderNativeEvidenceSidecar>();
    const pending = Promise.withResolvers<nativeEvidence.ProductionProviderNativeEvidenceSidecar>();
    const entered = Promise.withResolvers<void>();
    vi.spyOn(nativeEvidence, 'createProductionProviderNativeEvidence').mockImplementation(input => {
      void realSeal(input).then(originalEvidence.resolve, originalEvidence.reject);
      entered.resolve();
      return pending.promise;
    });
    const running = investigation.run();
    await entered.promise;
    await vi.advanceTimersByTimeAsync(1000);
    const result = await running;
    expect(result.summary).toMatchObject({ stopReason: 'sealing-deadline', nativeEvidenceStatus: 'sealing-deadline', sealOwnership: 'pending', cleanup: 'completed' });
    expect(result.nativeEvidence).toBeUndefined();
    const evidence = await originalEvidence.promise;
    pending.resolve(evidence);
    await investigation.waitForEvidenceRelease();
    expect(result.nativeEvidence).toBeUndefined();
    expect(result.summary.sealOwnership).toBe('pending');
    expect(investigation.getProgress().sealOwnership).toBe('settled');
  });

  it('reports unconfirmed cleanup and keeps dispose rejected even when actual cleanup later resolves', async () => {
    const { investigation, client } = fixture({ plan: 'first-only' });
    const pending = Promise.withResolvers<void>();
    client.dispose.mockReturnValue(pending.promise);
    const running = investigation.run();
    await vi.advanceTimersByTimeAsync(100);
    const result = await running;
    expect(result.summary.cleanup).toBe('pending');
    await expect(investigation.dispose()).rejects.toMatchObject({ name: 'ProductionProviderInvestigationCleanupTimeoutError' });
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(result.summary.cleanup).toBe('pending');
    await expect(investigation.dispose()).rejects.toMatchObject({ name: 'ProductionProviderInvestigationCleanupTimeoutError' });
  });

  it('preserves actual cleanup failure without discarding Provider evidence', async () => {
    const { investigation, client } = fixture({ plan: 'first-only' });
    const error = new Error('Synthetic cleanup error');
    client.dispose.mockRejectedValue(error);
    const result = await investigation.run();
    expect(result.summary.cleanup).toBe('failed');
    expect(result.provider?.requests[0]?.status).toBe('settled');
    await expect(investigation.dispose()).rejects.toThrow();
    expect(JSON.stringify(result.summary)).not.toContain(error.message);
  });

  it('does not insert progress callbacks into immediate settlement or continuity', async () => {
    const { investigation, onProgress, client, take, createCaptureClient } = fixture({ plan: 'full-v2' });
    onProgress.mockImplementation(() => {
      throw new Error('UI failure');
    });
    const result = await investigation.run();
    expect(onProgress.mock.calls.map(([{ progress }]) => progress.phase)).toEqual(['running', 'collecting', 'sealing', 'finished']);
    // Notifications surround the whole script, never a per-request settlement.
    expect(onProgress.mock.calls.map(([{ progress }]) => progress.provider.settledRequests)).toEqual([0, 13, 13, 13]);
    expect(result.summary.progressCallbackFailures).toBe(4);
    expect(result.provider?.requests[0]?.trace.settled?.outcome.status).toBe('fulfilled');
    expect(result.provider?.requests.map(request => request.scenario)).toEqual([
      'first-turn', 'continuity', 'independent-next-input', 'system-user', 'supplied-history',
      'reasoning-none', 'reasoning-low', 'reasoning-medium', 'reasoning-high',
      'natural-tool-minimal', 'natural-tool-representative', 'structured-tool-history', 'image',
    ]);
    expect(result.provider?.requests.map(request => request.status)).toEqual(Array.from({ length: 13 }, () => 'settled'));
    expect(client.generateText).toHaveBeenCalledTimes(13);
    expect(client.loadDownloadedModel).toHaveBeenCalledOnce();
    expect(createCaptureClient).toHaveBeenCalledOnce();
    expect(take).toHaveBeenCalledOnce();
    expect(client.generateText.mock.calls[1]?.[0].messages).toEqual(result.provider?.requests[1]?.input?.messages);
    expect(result.summary.requests.every(request => request.limits.maximumEvents === 1024 && request.limits.maximumCharacters === 65536)).toBe(true);
  });

  it('owns sampled callback failures while the actual Provider request remains pending', async () => {
    const { investigation, createCaptureClient, entered, client, onProgress } = fixture({ plan: 'first-only' });
    const original = createCaptureClient.getMockImplementation()!;
    const pending = Promise.withResolvers<void>();
    createCaptureClient.mockImplementation(input => {
      const capture = original(input);
      client.generateText.mockImplementation(async () => {
        entered.resolve(); await pending.promise;
      });
      return capture;
    });
    onProgress.mockImplementation(() => {
      throw new Error('Private UI failure');
    });
    const running = investigation.run();
    await entered.promise;
    await vi.advanceTimersByTimeAsync(500);
    expect(onProgress).toHaveBeenCalledTimes(3);
    pending.resolve();
    const result = await running;
    expect(result.summary.progressCallbackFailures).toBe(6);
    expect(result.summary.stopReason).toBeUndefined();
    expect(result.provider?.requests[0]?.trace.settled?.outcome.status).toBe('fulfilled');
  });

  it('keeps Provider evidence when native sealing throws synchronously', async () => {
    const { investigation, client } = fixture({ plan: 'first-only' });
    vi.spyOn(nativeEvidence, 'createProductionProviderNativeEvidence').mockImplementation(() => {
      throw new Error('Private sealing failure');
    });
    const result = await investigation.run();
    expect(result.summary).toMatchObject({ providerEvidence: 'available', nativeEvidenceStatus: 'sealing-failed', sealOwnership: 'settled', cleanup: 'completed' });
    expect(result.nativeEvidence).toBeUndefined();
    expect(client.dispose).toHaveBeenCalledOnce();
    await investigation.waitForEvidenceRelease();
  });

  it('does not label explicit disposal as a Provider deadline', async () => {
    const { investigation, createCaptureClient } = fixture({ plan: 'first-only' });
    await investigation.dispose();
    const result = await investigation.run();
    expect(result.summary.stopReason).toBe('disposed');
    expect(result.provider?.abortReason).toBeUndefined();
    // The anchor precedes the first disposal request; cleanup is observed later.
    expect(result.provider?.disposal).toBe('not-requested');
    expect(result.summary.cleanup).toBe('completed');
    expect(createCaptureClient).not.toHaveBeenCalled();
  });

  it('rejects a release barrier before run termination because partial sealing can still start', async () => {
    const { investigation } = fixture({ plan: 'first-only' });
    await investigation.dispose();
    await expect(investigation.waitForEvidenceRelease()).rejects.toThrow('requires the investigation run to finish');
    await investigation.run();
    await investigation.waitForEvidenceRelease();
  });
});
