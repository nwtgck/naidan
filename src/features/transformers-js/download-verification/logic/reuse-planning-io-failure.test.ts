// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import type { ITransformersJsWorker } from '@/features/transformers-js/types';
import type { WorkerServerApi } from '@/utils/worker-transport';
import { createDownloadVerificationCandidateAcceptanceWorkerClient } from '@/features/transformers-js/download-verification/candidate-acceptance-worker/client-hosted';
import { createMemoryFiles } from '@/features/transformers-js/replay-models/support/download-memory-files';
import { reuseDownloadedProductionRevision } from './reuse-downloaded-production-revision';
import { initializeProductionEntryFixture, installProductionRuntimeStartupPlatform, productionRuntimeModuleFixtureBytes } from '@/features/transformers-js/runtime/fixtures/production-runtime-startup-fixture';
import { resolveHostedTransformersRuntimeAssetUrls } from '@/features/transformers-js/runtime/configure-hosted-runtime';

const boundary = vi.hoisted(() => ({
  api: undefined as WorkerServerApi<ITransformersJsWorker> | undefined,
  modelLoad: vi.fn(async () => ({ dispose: async () => {} })),
}));

// This test retains actual entry/planner/cache/revision orchestration. Model
// configuration, resource selection and ORT are tiny boundary fixtures; this is
// not model compatibility or inference evidence.
vi.mock('@huggingface/transformers', () => ({
  AutoConfig: { from_pretrained: vi.fn(async () => ({ model_type: 'gpt2' })) },
  AutoModelForCausalLM: { from_pretrained: boundary.modelLoad },
  AutoModelForImageTextToText: { from_pretrained: vi.fn() },
  AutoTokenizer: { from_pretrained: vi.fn(async () => ({})) },
  AutoProcessor: { from_pretrained: vi.fn() },
  ModelRegistry: {
    get_tokenizer_files: vi.fn(async () => []),
    get_processor_files: vi.fn(async () => []),
  },
  InterruptableStoppingCriteria: class {
    reset() {}
    interrupt() {}
  },
  StoppingCriteriaList: class extends Array {},
  TextStreamer: vi.fn(),
  RawImage: { read: vi.fn() },
  env: { backends: { onnx: { wasm: {}, logLevel: 'error' } }, customCache: undefined },
}));
vi.mock('@/features/transformers-js/runtime/production-resource-selector', () => ({
  selectProductionModelResources: ({ candidate }: { candidate: { dtype: string } }) => ({
    className: 'SyntheticPlanningIoModel', sessions: [], paths: [`onnx/model_${candidate.dtype}.onnx`],
  }),
}));
vi.mock('@/utils/worker-transport', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/worker-transport')>(),
  exposeWorkerRemote: ({ api }: { api: WorkerServerApi<ITransformersJsWorker> }) => {
    boundary.api = api;
  },
}));
vi.mock('../candidate-acceptance-worker/client-hosted', () => ({
  createDownloadVerificationCandidateAcceptanceWorkerClient: vi.fn(),
}));
// Browser native Blob module evaluation is the only initialization platform
// boundary replaced here; the actual entry and host lease gate still run.
vi.mock('@/features/transformers-js/runtime/import-production-runtime-module', () => ({
  importProductionRuntimeModule: async ({ objectUrl }: { objectUrl: string }) => {
    expect(new URL(objectUrl).origin).toBe('https://naidan.example');
  },
}));

afterEach(() => vi.unstubAllGlobals());

it('stops revision reuse after an exact candidate-plan OPFS I/O failure instead of accepting legacy main', async () => {
  const modelId = 'org/model';
  const revision = '1'.repeat(40);
  const fs = createMemoryFiles();
  const base = `models/huggingface.co/${modelId}/resolve/main/onnx/`;
  let directory = fs.root;
  for (const part of base.split('/').filter(Boolean)) {
    directory = await directory.getDirectoryHandle(part, { create: true });
  }
  fs.files.set(`${base}model_q4f16.onnx`, new Uint8Array([1, 2, 3]));
  fs.files.set(`${base}.model_q4f16.onnx.complete`, new Uint8Array());
  // Required config admission precedes the candidate plan. Let it succeed so
  // the injected I/O failure still belongs to planning, not config presence.
  const exactBase = `models/huggingface.co/${modelId}/resolve/${revision}/`;
  let exactDirectory = fs.root;
  for (const part of exactBase.split('/').filter(Boolean)) {
    exactDirectory = await exactDirectory.getDirectoryHandle(part, { create: true });
  }
  fs.files.set(`${exactBase}config.json`, new TextEncoder().encode('{"model_type":"gpt2"}'));
  fs.files.set(`${exactBase}.config.json.complete`, new Uint8Array());
  fs.activity.length = 0;
  fs.enter({ nextPhase: 'load', mutationPolicy: 'read-only' });
  const failure = new DOMException('Synthetic exact-revision permission failure', 'NotAllowedError');
  let candidatePlanning = false;
  const getDirectory = vi.fn(async () => {
    if (candidatePlanning) throw failure;
    return fs.root;
  });
  const forbiddenFetch = vi.fn<typeof fetch>(async () => {
    throw new Error('Unexpected network request');
  });
  installProductionRuntimeStartupPlatform({ origin: 'https://naidan.example' });
  const assets = resolveHostedTransformersRuntimeAssetUrls({ workerLocationUrl: 'https://naidan.example/assets/worker.js', environment: import.meta.env.DEV ? 'development' : 'production', userAgent: '', vendor: '' });
  const runtimeRequests: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== assets.mjsUrl) return forbiddenFetch(input, init);
    expect(init?.redirect).toBe('error');
    runtimeRequests.push(url);
    return new Response(productionRuntimeModuleFixtureBytes({ variant: assets.variant }), { headers: { 'Content-Type': 'text/javascript' } });
  };
  vi.stubGlobal('fetch', transport);
  vi.stubGlobal('self', {
    location: { href: 'https://naidan.example/assets/worker.js', origin: 'https://naidan.example' },
    fetch: transport,
  });
  vi.stubGlobal('navigator', { storage: { getDirectory }, userAgent: '', vendor: '', hardwareConcurrency: 2 });
  const entry = await import('@/features/transformers-js/worker/entry');
  await initializeProductionEntryFixture({ initialize: entry.initializeProductionWorkerRuntime });
  const worker = boundary.api;
  if (worker === undefined) throw new Error('Production entry did not expose its API');
  const phases: string[] = [];
  const failures: Array<{ name: string; message: string }> = [];
  const verifyDownloadedModelRevision = vi.fn<ReturnType<typeof createDownloadVerificationCandidateAcceptanceWorkerClient>['verifyDownloadedModelRevision']>(async ({ modelId, loadRevision }) => {
    try {
      return await worker.verifyDownloadedModelRevision(modelId, loadRevision, info => {
        if (typeof info.status === 'string') phases.push(info.status);
        if (info.status === 'cache-acceptance-candidate-plan') candidatePlanning = true;
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failures.push({ name: error.name, message: error.message });
      // Reconstruct only Error name/message as Comlink does, not its prototype.
      throw Object.assign(new Error(error.message), { name: error.name });
    }
  });
  const dispose = vi.fn(async () => {});
  vi.mocked(createDownloadVerificationCandidateAcceptanceWorkerClient).mockReturnValue({
    verifyDownloadedModelRevision, verifyDownloadedModelCandidate: vi.fn(), dispose,
  });
  const startFreshDownload = vi.fn();
  const result = await (async () => {
    const reuse = await reuseDownloadedProductionRevision({
      modelId, resolvedRevision: revision, storageRoot: fs.root,
      inspectCachedRevisions: async () => ({
        modelId, normalizedModelId: modelId,
        revisions: [
          { revision, kind: 'immutable-sha', totalBytes: 3, fileCount: 1, completionMarkerCount: 1, incompleteFileCount: 0, zeroByteFileCount: 0, weightFileCount: 1, committedWeightFileCount: 1, lastModified: 2, status: 'committed-file-set' },
          { revision: 'main', kind: 'legacy-main', totalBytes: 3, fileCount: 1, completionMarkerCount: 1, incompleteFileCount: 0, zeroByteFileCount: 0, weightFileCount: 1, committedWeightFileCount: 1, lastModified: 1, status: 'committed-file-set' },
        ],
      }),
    });
    if (!reuse.reused) startFreshDownload();
    return { status: 'resolved' as const, reuse };
  })().catch((error: unknown) => ({ status: 'rejected' as const, error }));

  const diagnostic = JSON.stringify({ result, failures, phases, revisions: verifyDownloadedModelRevision.mock.calls.map(([input]) => input.loadRevision) });
  expect(phases).toContain('cache-acceptance-candidate-plan');
  expect(failures[0]?.message).toContain('Synthetic exact-revision permission failure');
  expect(forbiddenFetch).not.toHaveBeenCalled();
  expect(runtimeRequests).toEqual([assets.mjsUrl]);
  expect(startFreshDownload).not.toHaveBeenCalled();
  expect(fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
  expect(result.status, diagnostic).toBe('rejected');
  expect(verifyDownloadedModelRevision).toHaveBeenCalledOnce();
  expect(boundary.modelLoad).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledOnce();
});
