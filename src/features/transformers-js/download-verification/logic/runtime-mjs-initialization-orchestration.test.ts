// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startProductionWorkerRuntime } from '@/features/transformers-js/worker/production-worker-startup';
import { createProductionRuntimeStartupFixture, installProductionRuntimeStartupPlatform } from '@/features/transformers-js/runtime/fixtures/production-runtime-startup-fixture';
import { acceptDownloadedProductionCandidate } from './accept-downloaded-production-candidate';
import { runCandidateDownloadOrchestration } from './run-candidate-download-orchestration';
import { reuseDownloadedProductionRevision } from './reuse-downloaded-production-revision';
import { acceptReusableDownloadedProductionRevisionsForDownload } from './run-cached-revision-acceptance-orchestration';
import type { DownloadVerificationCandidatePreparationObservation } from '@/features/transformers-js/download-verification/types';

const modelId = 'fixture/runtime-initialization';
const revision = 'a'.repeat(40);
const workers: Array<InitializationFailureWorker | ReadyWorker> = [];
const initializationFailure = new TypeError('Fixture native runtime module import failed');
const transport = vi.hoisted(() => ({ wrap: vi.fn(), release: vi.fn() }));
vi.mock('@/utils/worker-transport', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/worker-transport')>(),
  wrapWorkerRemote: transport.wrap,
  releaseWorkerRemote: transport.release,
}));

// Only entry initialization is a boundary fixture here. Startup serialization,
// host session ownership, acceptance classification and both coordinators are
// real. No successful ready or model RPC is forged to bypass the module lease.
class InitializationFailureWorker extends EventTarget {
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
  readonly startup: Promise<void>;

  constructor() {
    super();
    workers.push(this);
    this.startup = startProductionWorkerRuntime({
      loadEntry: async () => {
        throw initializationFailure;
      },
      postMessage: ({ message }) => this.dispatchEvent(new MessageEvent('message', { data: message })),
    }).catch(() => undefined);
  }
}

class ReadyWorker extends EventTarget {
  private active = true;
  readonly fixture = createProductionRuntimeStartupFixture({ emitFromWorker: ({ message }) => this.dispatchEvent(new MessageEvent('message', { data: message })) });
  readonly postMessage = vi.fn((message: unknown) => this.fixture.acceptHostMessage({ message }));
  readonly terminate = vi.fn(() => {
    this.active = false;
  });

  constructor() {
    super();
    workers.push(this);
    queueMicrotask(() => {
      if (this.active) this.fixture.start();
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  installProductionRuntimeStartupPlatform({ origin: 'http://localhost' });
  vi.stubGlobal('Worker', InitializationFailureWorker);
});

afterEach(async () => {
  for (const worker of workers.splice(0)) {
    worker.dispatchEvent(new Event('error'));
    if (worker instanceof InitializationFailureWorker) await worker.startup;
  }
  vi.unstubAllGlobals();
});

it('stops after the first prepared dtype when runtime module initialization fails before model RPC', async () => {
  const modelGet = vi.fn<typeof fetch>(async () => new Response(Uint8Array.of(1, 2, 3)));
  const prepareCandidate = vi.fn(async ({ candidate }: { candidate: { dtype: string } }): Promise<DownloadVerificationCandidatePreparationObservation> => {
    const response = await modelGet(`https://huggingface.co/${modelId}/resolve/${revision}/onnx/model_${candidate.dtype}.onnx`);
    await response.arrayBuffer();
    return {
      status: 'ready',
      prefetch: { requestedCount: 1, cachedCount: 0, downloadedCount: 1, failedCount: 0, complete: true, files: [] },
    };
  });
  const result = await runCandidateDownloadOrchestration({
    candidates: [{ device: 'webgpu', dtype: 'q4f16' }, { device: 'webgpu', dtype: 'q4' }],
    prepareCandidate,
    acceptCandidate: ({ candidate }) => acceptDownloadedProductionCandidate({ modelId, resolvedRevision: revision, loadRevision: revision, candidate }),
  });

  expect(result).toMatchObject({
    status: 'failed', selectedCandidate: undefined,
    error: { name: 'ProductionWorkerLifecycleError', message: expect.stringContaining(initializationFailure.message) },
  });
  expect(result.attempts).toHaveLength(1);
  expect(result.attempts[0]?.acceptance?.status).toBe('failed');
  expect(prepareCandidate).toHaveBeenCalledOnce();
  // The initial explicit Download is allowed; an initialization failure must
  // not cause another dtype's transfer to start.
  expect(modelGet.mock.calls.map(([url]) => url)).toEqual([
    `https://huggingface.co/${modelId}/resolve/${revision}/onnx/model_q4f16.onnx`,
  ]);
  expect(workers).toHaveLength(1);
  expect(workers[0]!.postMessage).not.toHaveBeenCalled();
  expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  expect(transport.wrap).not.toHaveBeenCalled();
});

it('rejects real revision reuse after exact cache initialization failure without advancing to legacy main', async () => {
  const acceptRevisions = vi.fn(acceptReusableDownloadedProductionRevisionsForDownload);
  const outcome = reuseDownloadedProductionRevision({
    modelId, resolvedRevision: revision, storageRoot: {} as FileSystemDirectoryHandle,
    candidateOrderByRevision: {
      [revision]: [{ device: 'webgpu', dtype: 'q4f16' }, { device: 'webgpu', dtype: 'q4' }],
      main: [{ device: 'webgpu', dtype: 'q4' }],
    },
    inspectCachedRevisions: async () => ({
      modelId, normalizedModelId: modelId,
      revisions: [
        { revision, kind: 'immutable-sha', totalBytes: 3, fileCount: 1, completionMarkerCount: 1, incompleteFileCount: 0, zeroByteFileCount: 0, weightFileCount: 1, committedWeightFileCount: 1, lastModified: 2, status: 'committed-file-set' },
        { revision: 'main', kind: 'legacy-main', totalBytes: 3, fileCount: 1, completionMarkerCount: 1, incompleteFileCount: 0, zeroByteFileCount: 0, weightFileCount: 1, committedWeightFileCount: 1, lastModified: 1, status: 'committed-file-set' },
      ],
    }),
    acceptReusableRevisions: acceptRevisions,
  });

  await expect(outcome).rejects.toThrow('ProductionWorkerLifecycleError');
  const acceptance: Awaited<ReturnType<typeof acceptReusableDownloadedProductionRevisionsForDownload>> = await acceptRevisions.mock.results[0]!.value;
  expect(acceptance).toMatchObject({ status: 'failed', error: { name: 'ProductionWorkerLifecycleError' } });
  expect(acceptance.attempts.map(attempt => attempt.candidate.revision)).toEqual([revision]);
  expect(workers).toHaveLength(1);
  expect(workers[0]!.postMessage).not.toHaveBeenCalled();
  expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  expect(transport.wrap).not.toHaveBeenCalled();
});

it('preserves ordinary ORT incompatibility fallback after verified startup has completed', async () => {
  vi.stubGlobal('Worker', ReadyWorker);
  const verify = vi.fn()
    .mockRejectedValueOnce(new Error('Fixture ordinary ORT dtype incompatibility'))
    .mockResolvedValueOnce({ device: 'webgpu', dtype: 'q4' });
  transport.wrap.mockImplementation(() => ({ verifyDownloadedModelCandidate: verify }));
  const prepareCandidate = vi.fn(async (): Promise<DownloadVerificationCandidatePreparationObservation> => ({
    status: 'ready',
    prefetch: { requestedCount: 0, cachedCount: 1, downloadedCount: 0, failedCount: 0, complete: true, files: [] },
  }));
  const result = await runCandidateDownloadOrchestration({
    candidates: [{ device: 'webgpu', dtype: 'q4f16' }, { device: 'webgpu', dtype: 'q4' }],
    prepareCandidate,
    acceptCandidate: ({ candidate }) => acceptDownloadedProductionCandidate({ modelId, resolvedRevision: revision, loadRevision: revision, candidate }),
  });

  expect(result.status).toBe('accepted');
  expect(result.selectedCandidate).toEqual({ device: 'webgpu', dtype: 'q4' });
  expect(result.attempts.map(attempt => attempt.acceptance?.status)).toEqual(['rejected', 'accepted']);
  expect(verify.mock.calls.map(([, , candidate]) => candidate)).toEqual([
    { device: 'webgpu', dtype: 'q4f16' }, { device: 'webgpu', dtype: 'q4' },
  ]);
  expect(prepareCandidate).toHaveBeenCalledTimes(2);
  expect(workers).toHaveLength(2);
  for (const worker of workers) expect(worker.terminate).toHaveBeenCalledOnce();
});
