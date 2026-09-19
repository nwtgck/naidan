// @vitest-environment node
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { expose, releaseProxy, type Endpoint, type Remote } from 'comlink';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProgressInfo, TransformersJsProductionInvestigationCandidate, TransformersJsWorkerClient } from '@/features/transformers-js/types';
import { createProductionRuntimeStartupFixture, installProductionRuntimeStartupPlatform } from '@/features/transformers-js/runtime/fixtures/production-runtime-startup-fixture';
import { runProductionDownloadPreparation } from '@/features/transformers-js/download-verification/logic/run-production-download-preparation';
import { prepareProductionRuntimeArtifacts } from '@/features/transformers-js/download-verification/logic/prepare-production-runtime-artifacts';
import { prepareProductionModelCandidate } from '@/features/transformers-js/download-verification/logic/prepare-production-model-candidate';
import { acceptDownloadedProductionCandidate } from '@/features/transformers-js/download-verification/logic/accept-downloaded-production-candidate';
import { createDownloadVerificationCandidateAcceptanceWorkerClient } from './client-hosted';
import { DownloadAcceptanceWorkerRetirementError } from './retirement-error';
import * as workerTransport from '@/utils/worker-transport';
import { createTransformersJsService } from '@/features/transformers-js/index-hosted';
import { resolvePublicHuggingFaceRevision } from '@/features/transformers-js/download-verification/logic/resolve-public-hugging-face-revision';
import { reuseDownloadedProductionRevision } from '@/features/transformers-js/download-verification/logic/reuse-downloaded-production-revision';
import { createMemoryFiles } from '@/features/transformers-js/replay-models/support/download-memory-files';
import { writeToOpfs } from '@/features/transformers-js/utils';

// Only metadata/transfer preparation and native model work are synthetic. The
// candidate orchestration, acceptance helper, client, session and Comlink are real.
vi.mock('../logic/prepare-production-runtime-artifacts', () => ({ prepareProductionRuntimeArtifacts: vi.fn() }));
vi.mock('../logic/prepare-production-model-candidate', () => ({ prepareProductionModelCandidate: vi.fn() }));
vi.mock('../logic/resolve-public-hugging-face-revision', () => ({ resolvePublicHuggingFaceRevision: vi.fn() }));
vi.mock('../logic/reuse-downloaded-production-revision', () => ({ reuseDownloadedProductionRevision: vi.fn() }));
// Record settlement without replacing any orchestration behavior. The service
// lane can reject before its retired Download continuation finishes.
vi.mock('../logic/run-production-download-preparation', async importOriginal => {
  const original = await importOriginal<typeof import('@/features/transformers-js/download-verification/logic/run-production-download-preparation')>();
  return { ...original, runProductionDownloadPreparation: (args: Parameters<typeof original.runProductionDownloadPreparation>[0]) => {
    const running = original.runProductionDownloadPreparation(args);
    preparations.push(running.then(value => ({ status: 'fulfilled' as const, value }), (error: unknown) => ({ status: 'rejected' as const, error })));
    return running;
  } };
});

const modelId = 'synthetic/model';
const revision = '0123456789abcdef0123456789abcdef01234567';
const workers: AcceptanceWorker[] = [];
const nativeFailure = new Error('Synthetic selected candidate rejection');
const preparations: Array<Promise<{ status: 'fulfilled'; value: unknown } | { status: 'rejected'; error: unknown }>> = [];
let firstOutcome: 'accepted' | 'rejected';
let retirementFailure: { error: unknown } | undefined;
let barrier: { entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> } | undefined;
const forbiddenFetch = vi.fn(() => {
  throw new Error('Network forbidden');
});

class AcceptanceWorker extends EventTarget {
  readonly channel = new MessageChannel();
  readonly endpoint = this.channel.port2 as unknown as Endpoint;
  readonly requests: Array<{ modelId: string; revision: string | undefined; candidate: TransformersJsProductionInvestigationCandidate }> = [];
  readonly revisionRequests: Array<{ modelId: string; revision: string | undefined }> = [];
  readonly startup = createProductionRuntimeStartupFixture({ emitFromWorker: ({ message }) => this.dispatchEvent(new MessageEvent('message', { data: message })) });
  readonly first = workers.length === 0;
  terminate = vi.fn(() => {
    if (this.first && retirementFailure !== undefined) throw retirementFailure.error;
    this.channel.port1.close();
    this.channel.port2.close();
  });

  constructor() {
    super();
    workers.push(this);
    this.channel.port1.on('message', data => this.dispatchEvent(new MessageEvent('message', { data })));
    expose({
      verifyDownloadedModelRevision: async (requestedModel: string, requestedRevision: string | undefined, callback: Remote<(info: ProgressInfo) => void>) => {
        this.revisionRequests.push({ modelId: requestedModel, revision: requestedRevision });
        callback[releaseProxy]();
        return { device: 'webgpu', dtype: 'q4f16' };
      },
      verifyDownloadedModelCandidate: async (requestedModel: string, requestedRevision: string | undefined, candidate: TransformersJsProductionInvestigationCandidate, callback: Remote<(info: ProgressInfo) => void>) => {
        this.requests.push({ modelId: requestedModel, revision: requestedRevision, candidate });
        callback[releaseProxy]();
        if (this.first && barrier !== undefined) {
          barrier.entered.resolve();
          await barrier.release.promise;
        }
        if (this.first && firstOutcome === 'rejected') throw nativeFailure;
        return { device: candidate.device, dtype: candidate.dtype };
      },
    }, this.endpoint);
    // The host session is installed after the Worker constructor returns.
    queueMicrotask(() => this.startup.start());
  }

  postMessage(message: unknown, transfer: Parameters<MessagePort['postMessage']>[1]) {
    if (!this.startup.acceptHostMessage({ message })) this.channel.port1.postMessage(message, transfer);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  firstOutcome = 'accepted';
  retirementFailure = undefined;
  barrier = undefined;
  preparations.length = 0;
  installProductionRuntimeStartupPlatform({ origin: 'http://localhost' });
  vi.stubGlobal('Worker', AcceptanceWorker);
  vi.stubGlobal('fetch', forbiddenFetch);
  vi.mocked(resolvePublicHuggingFaceRevision).mockResolvedValue({ normalizedModelId: modelId, requestedRevision: 'main', resolvedRevision: revision });
  vi.mocked(reuseDownloadedProductionRevision).mockResolvedValue({ reused: false, acceptance: undefined });
  vi.mocked(prepareProductionRuntimeArtifacts).mockResolvedValue({
    modelId, revision, status: 'prepared', processor: 'tokenizer', modelType: 'llama', error: undefined,
    observationMethod: 'transformers-runtime-artifact-preparation',
    resourcePlansByCandidate: {
      'webgpu/q4f16': { status: 'ready', paths: ['onnx/model_q4f16.onnx'] },
      'webgpu/q4': { status: 'ready', paths: ['onnx/model_q4.onnx'] },
      'wasm/q4': { status: 'ready', paths: ['onnx/model_q4.onnx'] },
    },
  });
  vi.mocked(prepareProductionModelCandidate).mockResolvedValue({ status: 'ready', prefetch: {
    requestedCount: 0, cachedCount: 0, downloadedCount: 0, failedCount: 0, complete: true, files: [],
  } });
});

function idleProductionClient(): TransformersJsWorkerClient {
  return {
    dispose: async () => undefined,
    resetCache: async () => undefined,
    unloadModel: async () => undefined,
    interrupt: async () => undefined,
    loadDownloadedModel: async () => {
      throw new Error('Model Load is outside this fixture');
    },
    generateText: async () => {
      throw new Error('Generation is outside this fixture');
    },
  };
}

afterEach(() => {
  barrier?.release.resolve();
  // Test-owned ports must close even when simulated physical termination fails.
  for (const worker of workers.splice(0)) {
    worker.channel.port1.close();
    worker.channel.port2.close();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(forbiddenFetch).not.toHaveBeenCalled();
});

it('stops Production Download after accepted verification when the actual client cannot retire its Worker', async () => {
  firstOutcome = 'accepted';
  const physicalFailure = new Error('Synthetic physical termination failure: out of memory');
  retirementFailure = { error: physicalFailure };
  const observations: unknown[] = [];
  const result = await runProductionDownloadPreparation({ modelId, revision, onTiming: ({ observation }) => {
    observations.push(observation);
  } }).then(
    value => ({ status: 'fulfilled' as const, value }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );
  expect(result).toMatchObject({ status: 'rejected', error: { name: 'DownloadAcceptanceWorkerRetirementError', cause: physicalFailure } });
  if (result.status !== 'rejected') throw new Error('Expected retirement rejection');
  expect(result.error).toBeInstanceOf(DownloadAcceptanceWorkerRetirementError);
  if (!(result.error instanceof DownloadAcceptanceWorkerRetirementError)) throw new Error('Missing retirement error');
  expect(result.error.interruption).toBeUndefined();
  expect(result.error.verificationOutcome).toEqual({ status: 'fulfilled', device: 'webgpu', dtype: 'q4f16' });
  expect(prepareProductionRuntimeArtifacts).toHaveBeenCalledOnce();
  expect(prepareProductionModelCandidate).toHaveBeenCalledOnce();
  expect(workers).toHaveLength(1);
  expect(workers[0]!.requests).toEqual([{ modelId, revision, candidate: { device: 'webgpu', dtype: 'q4f16' } }]);
  expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  expect(observations).toEqual([expect.objectContaining({ kind: 'acceptance', loadOutcome: 'accepted', cleanupOutcome: 'failed', hostSettlement: 'rejected' })]);
});

it('stops Production Download after rejected verification when the actual client cannot retire its Worker', async () => {
  firstOutcome = 'rejected';
  const physicalFailure = new Error('Synthetic physical termination failure: out of memory');
  retirementFailure = { error: physicalFailure };
  const observations: unknown[] = [];
  const result = await runProductionDownloadPreparation({ modelId, revision, onTiming: ({ observation }) => {
    observations.push(observation);
  } }).then(
    value => ({ status: 'fulfilled' as const, value }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );
  expect(result).toMatchObject({ status: 'rejected', error: { name: 'DownloadAcceptanceWorkerRetirementError', cause: physicalFailure } });
  if (result.status !== 'rejected') throw new Error('Expected retirement rejection');
  expect(result.error).toBeInstanceOf(DownloadAcceptanceWorkerRetirementError);
  if (!(result.error instanceof DownloadAcceptanceWorkerRetirementError)) throw new Error('Missing retirement error');
  expect(result.error.interruption).toBeUndefined();
  expect(result.error.verificationOutcome).toEqual({ status: 'rejected', error: expect.objectContaining({ name: nativeFailure.name, message: nativeFailure.message }) });
  expect(prepareProductionRuntimeArtifacts).toHaveBeenCalledOnce();
  expect(prepareProductionModelCandidate).toHaveBeenCalledOnce();
  expect(workers).toHaveLength(1);
  expect(workers[0]!.requests).toEqual([{ modelId, revision, candidate: { device: 'webgpu', dtype: 'q4f16' } }]);
  expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  expect(observations).toEqual([expect.objectContaining({ kind: 'acceptance', loadOutcome: 'rejected', cleanupOutcome: 'failed', hostSettlement: 'rejected' })]);
});

it.each([undefined, null])('retains physical throw %s and shares the same failed retirement across dispose calls', async cause => {
  retirementFailure = { error: cause };
  const client = createDownloadVerificationCandidateAcceptanceWorkerClient({ operationSignal: undefined });
  await client.verifyDownloadedModelCandidate({ modelId, loadRevision: revision, candidate: { device: 'webgpu', dtype: 'q4f16' }, progressCallback: () => undefined });
  const error = await client.dispose().then(() => undefined, (error: unknown) => error);
  expect(error).toBeInstanceOf(DownloadAcceptanceWorkerRetirementError);
  if (!(error instanceof DownloadAcceptanceWorkerRetirementError)) throw new Error('Missing retirement error');
  expect(Object.hasOwn(error, 'cause')).toBe(true);
  expect(error.cause).toBe(cause);
  await expect(client.dispose()).rejects.toBe(error);
  expect(workers[0]!.terminate).toHaveBeenCalledOnce();
});

it.each(['accepted', 'rejected'] as const)('preserves %s when advisory remote release fails but physical stop succeeds', async outcome => {
  firstOutcome = outcome;
  // Only the advisory transport-release call is fault injected. Verification,
  // Comlink readiness and physical retirement still use the actual client.
  vi.spyOn(workerTransport, 'releaseWorkerRemote').mockImplementation(() => {
    throw new Error('Synthetic advisory release failure');
  });
  const result = await acceptDownloadedProductionCandidate({ modelId, resolvedRevision: revision, loadRevision: revision, candidate: { device: 'webgpu', dtype: 'q4f16' } });
  expect(result.status).toBe(outcome);
  expect(workerTransport.releaseWorkerRemote).toHaveBeenCalledOnce();
  expect(workers[0]!.terminate).toHaveBeenCalledOnce();
});

it('keeps the original abort reason separately when physical stop also fails', async () => {
  barrier = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  const controller = new AbortController();
  const reason = new Error('Synthetic caller abort');
  const cause = new Error('Synthetic physical failure');
  retirementFailure = { error: cause };
  const running = acceptDownloadedProductionCandidate({ modelId, resolvedRevision: revision, loadRevision: revision, candidate: { device: 'webgpu', dtype: 'q4f16' }, signal: controller.signal });
  const settled = running.then(() => undefined, (error: unknown) => error);
  await barrier.entered.promise;
  controller.abort(reason);
  const error = await settled;
  expect(error).toBeInstanceOf(DownloadAcceptanceWorkerRetirementError);
  if (!(error instanceof DownloadAcceptanceWorkerRetirementError)) throw new Error('Missing retirement error');
  expect(error.cause).toBe(cause);
  expect(error.interruption).toEqual({ reason });
  expect(error.verificationOutcome).toEqual({ status: 'not-settled' });
  expect(workers[0]!.terminate).toHaveBeenCalledOnce();
});

it('preserves cancellation when physical retirement succeeds', async () => {
  barrier = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  const controller = new AbortController();
  const reason = new Error('Synthetic caller abort');
  const running = acceptDownloadedProductionCandidate({ modelId, resolvedRevision: revision, loadRevision: revision, candidate: { device: 'webgpu', dtype: 'q4f16' }, signal: controller.signal });
  const settled = running.then(() => undefined, (error: unknown) => error);
  await barrier.entered.promise;
  controller.abort(reason);
  expect(await settled).toBe(reason);
  expect(workers[0]!.terminate).toHaveBeenCalledOnce();
});

it('retains the original session failure when its physical termination also fails', async () => {
  barrier = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  const cause = new Error('Synthetic physical stop failure after Worker error');
  retirementFailure = { error: cause };
  const observations: unknown[] = [];
  const running = runProductionDownloadPreparation({ modelId, revision, onTiming: ({ observation }) => {
    observations.push(observation);
  } });
  const settled = running.then(() => undefined, (error: unknown) => error);
  await barrier.entered.promise;
  workers[0]!.dispatchEvent(new Event('error'));
  const error = await settled;
  expect(error).toBeInstanceOf(DownloadAcceptanceWorkerRetirementError);
  if (!(error instanceof DownloadAcceptanceWorkerRetirementError)) throw new Error('Missing retirement error');
  expect(error.cause).toBe(cause);
  expect(error.verificationOutcome).toEqual({ status: 'rejected', error: expect.objectContaining({ name: 'ProductionWorkerLifecycleError', reason: 'worker-error' }) });
  expect(observations).toEqual([expect.objectContaining({ loadOutcome: 'failed', cleanupOutcome: 'failed', hostSettlement: 'rejected' })]);
  expect(prepareProductionModelCandidate).toHaveBeenCalledOnce();
  expect(workers).toHaveLength(1);
  expect(workers[0]!.terminate).toHaveBeenCalledOnce();
});

it('continues normal candidate fallback only after successful physical retirement', async () => {
  firstOutcome = 'rejected';
  const result = await runProductionDownloadPreparation({ modelId, revision });
  expect(result.status).toBe('accepted');
  expect(prepareProductionModelCandidate).toHaveBeenCalledTimes(2);
  expect(workers).toHaveLength(2);
  expect(workers[0]!.requests).toEqual([{ modelId, revision, candidate: { device: 'webgpu', dtype: 'q4f16' } }]);
  expect(workers[1]!.requests).toEqual([{ modelId, revision, candidate: { device: 'webgpu', dtype: 'q4' } }]);
  expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  expect(workers[1]!.terminate).toHaveBeenCalledOnce();
});

it.each(['accepted', 'rejected'] as const)('closes same-service queued and future operations after %s acceptance cannot retire', async outcome => {
  firstOutcome = outcome;
  barrier = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  const cause = new Error('out of memory: synthetic physical failure');
  retirementFailure = { error: cause };
  const createWorkerClient = vi.fn(() => {
    throw new Error('Unexpected replacement Production client');
  });
  const owner = createTransformersJsService({ createWorkerClient });
  const running = owner.service.downloadModel({ modelId });
  const settled = running.then(() => undefined, (error: unknown) => error);
  try {
    await barrier.entered.promise;
    const queued = owner.service.downloadModel({ modelId }).then(() => undefined, (error: unknown) => error);
    barrier.release.resolve();
    const error = await settled;
    expect(error).toBeInstanceOf(DownloadAcceptanceWorkerRetirementError);
    expect(await queued).toBe(error);
    await expect(owner.service.resetCache()).rejects.toBe(error);
    await expect(owner.service.downloadModel({ modelId })).rejects.toBe(error);
    await vi.waitFor(() => {
      expect(owner.service.getDownloadTimingSnapshot().records).toEqual([expect.objectContaining({ outcome: 'failed', observations: [expect.objectContaining({ loadOutcome: outcome, cleanupOutcome: 'failed', hostSettlement: 'rejected' })] })]);
    });
    await expect(owner.service.restart()).rejects.toBe(error);
    expect(createWorkerClient).not.toHaveBeenCalled();
    expect(prepareProductionModelCandidate).toHaveBeenCalledOnce();
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  } finally {
    barrier.release.resolve();
    await settled;
    await owner.dispose().catch(() => undefined);
  }
});

it('keeps a failed acceptance owner separate from another service', async () => {
  retirementFailure = { error: new Error('Synthetic physical failure') };
  const first = createTransformersJsService({ createWorkerClient: idleProductionClient });
  const second = createTransformersJsService({ createWorkerClient: idleProductionClient });
  try {
    await expect(first.service.downloadModel({ modelId })).rejects.toBeInstanceOf(DownloadAcceptanceWorkerRetirementError);
    await second.service.downloadModel({ modelId });
    expect(workers).toHaveLength(2);
    expect(workers[1]!.requests).toEqual([{ modelId, revision, candidate: { device: 'webgpu', dtype: 'q4f16' } }]);
    expect(workers[1]!.terminate).toHaveBeenCalledOnce();
    expect(second.service.getDownloadTimingSnapshot().records[0]?.outcome).toBe('completed');
  } finally {
    await first.dispose().catch(() => undefined);
    await second.dispose();
  }
});

it('registers early cached revision acceptance in the same physical-retirement owner', async () => {
  retirementFailure = { error: new Error('Synthetic cached acceptance termination failure') };
  const files = createMemoryFiles();
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => files.root } });
  const base = `models/huggingface.co/${modelId}/resolve/${revision}/`;
  // Tiny synthetic committed inventory, not a valid model. Inventory selection,
  // reuse orchestration, revision helper and its forwarded factory are actual.
  await writeToOpfs({ path: `${base}config.json`, response: new Response('{}') });
  await writeToOpfs({ path: `${base}onnx/model_q4f16.onnx`, response: new Response('synthetic') });
  const actual = await vi.importActual<typeof import('@/features/transformers-js/download-verification/logic/reuse-downloaded-production-revision')>('../logic/reuse-downloaded-production-revision');
  vi.mocked(reuseDownloadedProductionRevision).mockImplementationOnce(actual.reuseDownloadedProductionRevision);
  const createWorkerClient = vi.fn(idleProductionClient);
  const owner = createTransformersJsService({ createWorkerClient });
  try {
    await expect(owner.service.downloadModel({ modelId })).rejects.toBeInstanceOf(DownloadAcceptanceWorkerRetirementError);
    await expect(owner.service.restart()).rejects.toBeInstanceOf(DownloadAcceptanceWorkerRetirementError);
    expect(createWorkerClient).not.toHaveBeenCalled();
    expect(prepareProductionRuntimeArtifacts).not.toHaveBeenCalled();
    expect(prepareProductionModelCandidate).not.toHaveBeenCalled();
    expect(workers).toHaveLength(1);
    expect(workers[0]!.revisionRequests).toEqual([{ modelId, revision }]);
    expect(workers[0]!.requests).toEqual([]);
  } finally {
    await owner.dispose().catch(() => undefined);
  }
});

it('shares physical retirement with restart during a held acceptance and never replaces it', async () => {
  barrier = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  const cause = new Error('Synthetic held acceptance termination failure');
  retirementFailure = { error: cause };
  const createWorkerClient = vi.fn(idleProductionClient);
  const owner = createTransformersJsService({ createWorkerClient });
  const running = owner.service.downloadModel({ modelId }).then(() => undefined, (error: unknown) => error);
  try {
    await barrier.entered.promise;
    const retirement = owner.service.restart();
    const error = await retirement.then(() => undefined, (error: unknown) => error);
    expect(error).toBeInstanceOf(DownloadAcceptanceWorkerRetirementError);
    if (!(error instanceof DownloadAcceptanceWorkerRetirementError)) throw new Error('Missing retirement error');
    expect(error.cause).toBe(cause);
    expect(error.verificationOutcome).toEqual({ status: 'not-settled' });
    expect(error.interruption?.reason).toBe(await running);
    await preparations[0];
    await expect(owner.service.downloadModel({ modelId })).rejects.toThrow();
    await expect(owner.service.restart()).rejects.toThrow();
    expect(createWorkerClient).not.toHaveBeenCalled();
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  } finally {
    barrier.release.resolve();
    await running;
    await owner.dispose().catch(() => undefined);
  }
});

it('shares physical retirement with dispose during a held acceptance and never replaces it', async () => {
  barrier = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  const cause = new Error('Synthetic held acceptance termination failure');
  retirementFailure = { error: cause };
  const createWorkerClient = vi.fn(idleProductionClient);
  const owner = createTransformersJsService({ createWorkerClient });
  const running = owner.service.downloadModel({ modelId }).then(() => undefined, (error: unknown) => error);
  try {
    await barrier.entered.promise;
    const retirement = owner.dispose();
    const error = await retirement.then(() => undefined, (error: unknown) => error);
    expect(error).toBeInstanceOf(DownloadAcceptanceWorkerRetirementError);
    if (!(error instanceof DownloadAcceptanceWorkerRetirementError)) throw new Error('Missing retirement error');
    expect(error.cause).toBe(cause);
    expect(error.verificationOutcome).toEqual({ status: 'not-settled' });
    expect(error.interruption?.reason).toBe(await running);
    await preparations[0];
    await expect(owner.service.downloadModel({ modelId })).rejects.toThrow();
    await expect(owner.service.restart()).rejects.toThrow();
    expect(createWorkerClient).not.toHaveBeenCalled();
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  } finally {
    barrier.release.resolve();
    await running;
    await owner.dispose().catch(() => undefined);
  }
});

it('blocks an old Download acceptance factory after held preparation outlives a successful restart', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  vi.mocked(prepareProductionModelCandidate).mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return { status: 'ready', prefetch: { requestedCount: 0, cachedCount: 0, downloadedCount: 0, failedCount: 0, complete: true, files: [] } };
  });
  const createWorkerClient = vi.fn(idleProductionClient);
  const owner = createTransformersJsService({ createWorkerClient });
  const running = owner.service.downloadModel({ modelId }).then(() => undefined, (error: unknown) => error);
  try {
    await entered.promise;
    await owner.service.restart();
    release.resolve();
    const preparation = await preparations[0];
    expect(preparation).toMatchObject({ status: 'rejected', error: { name: 'ProductionWorkerLifecycleError', reason: 'restarted' } });
    expect(await running).toMatchObject({ name: 'ProductionWorkerLifecycleError', reason: 'restarted' });
    expect(workers).toHaveLength(0);
    expect(createWorkerClient).toHaveBeenCalledOnce();
    // The new lane remains usable; old factory rejection is not a global latch.
    await owner.service.resetCache();
  } finally {
    release.resolve();
    await running;
    await owner.dispose();
  }
});
