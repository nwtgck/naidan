import { expect, vi } from 'vitest';
import { createMemoryFiles } from './memory-files';
import { createSyntheticModelBody, inspectSyntheticOrtSession, type SyntheticSessionObservation } from './synthetic-session-oracle';
import { WEB_BUNDLE_SHA256 } from '@/features/transformers-js/model-support-investigation/logic/fixtures/raw-metadata-replay/helpers';
import { readModelFixture } from '@/features/transformers-js/download-verification/fixtures/model-runtime-fixture';
import { createDownloadedModelWorkerFetch } from '@/features/transformers-js/runtime/offline-worker-fetch';
import { getProductionTransformersArtifact, importProductionTransformersArtifact } from '@/features/transformers-js/runtime/fixtures/production-transformers-artifact';
import { initializeProductionEntryFixture, installProductionRuntimeStartupPlatform, productionRuntimeModuleFixtureBytes } from '@/features/transformers-js/runtime/fixtures/production-runtime-startup-fixture';
import { resolveHostedTransformersRuntimeAssetUrls } from '@/features/transformers-js/runtime/configure-hosted-runtime';
import type { WorkerServerApi } from '@/utils/worker-transport';
import type { ITransformersJsDownloadWorker, ITransformersJsWorker, TransformersJsProgressCallback, TransformersJsWorkerClient } from '@/features/transformers-js/types';
import type { DownloadVerificationModelArtifactRequestWorker } from '@/features/transformers-js/download-verification/types';
import type { FreshMetadataWorker, FreshMetadataSummary } from '@/features/transformers-js/model-support-investigation/fresh-metadata-worker/types';

// Only module resolution is replaced: each entry receives a fresh instance of
// the production-plugin artifact, including real AutoClass and resource loading.
type Runtime = typeof import('@huggingface/transformers');
type DownloadApi = WorkerServerApi<ITransformersJsDownloadWorker>;
type LoadApi = WorkerServerApi<ITransformersJsWorker>;
type ObserverApi = WorkerServerApi<DownloadVerificationModelArtifactRequestWorker>;

export async function connectRawDownload({ modelId, revision, remoteRefs }: {
  modelId: string, revision: string, remoteRefs: ReadonlyMap<string, string>,
}) {
  const archive = readModelFixture({ modelId });
  if (archive.summary.revision !== revision) throw new Error('Model test revision differs from raw evidence');
  const repository = archive.repository;
  const repositoryPaths = new Set(repository.files.map(file => file.path));
  const metadataPaths = new Set<string>(archive.summary.files.map(file => file.path));
  const fs = createMemoryFiles();
  const requests: Array<{ phase: string, path: string, revision: string, bytes: number, status: number }> = [];
  const unknown: string[] = [];
  const offlineRequests: string[] = [];
  // Calls to the bootstrap/global guard, not invocations of a later internal
  // cache-only env.fetch function installed by the actual Production entry.
  const offlineFetchCalls: string[] = [];
  const offlineNonRuntimeFetchCalls: string[] = [];
  const runtimeAssetFetchCalls: string[] = [];
  const expectedRuntimeAssetFetchCalls: string[] = [];
  const runtimeLeases: Array<{ dispose(): void }> = [];
  const runtimePlatform = installProductionRuntimeStartupPlatform({ origin: 'http://localhost' });
  const sessions: Array<SyntheticSessionObservation & { phase: string }> = [];
  const sessionErrors: string[] = [];
  const downloadCapabilityCalls: Array<'metadata' | 'observer' | 'model-prefetch'> = [];
  const revisionAcceptanceCalls: Array<{ modelId: string, revision: string | undefined }> = [];
  const serviceApiRequests: Array<{ operation: number, url: string }> = [];
  const serviceLoadCalls: Array<{ modelId: string, revision: string | undefined }> = [];
  const serviceClientEvents: Array<{ service: number, event: 'created' | 'disposed' }> = [];
  function assertSessionOracle() {
    if (sessionErrors.length > 0) throw new Error(`Synthetic ORT oracle rejected an input: ${sessionErrors.join('; ')}`);
  }
  let phase = 'unassigned';
  let captured: unknown;
  const activeLoads: LoadApi[] = [];
  const runtimeArtifact = await getProductionTransformersArtifact();
  if (runtimeArtifact.originalBundleSha256 !== WEB_BUNDLE_SHA256) throw new Error('Installed web bundle changed: review the fixed model contracts');
  const bundleUrl = new URL(runtimeArtifact.moduleUrl);
  const ortUrl = runtimeArtifact.ortWebGpuUrl;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Exact external ORT method boundary.
  const ort = await import(/* @vite-ignore */ ortUrl) as { InferenceSession: { create(...args: unknown[]): Promise<unknown> } };
  const released = vi.fn(async () => undefined);
  const sessionSpy = vi.spyOn(ort.InferenceSession, 'create').mockImplementation(async (...args) => {
    try {
      if (phase !== 'load') throw new Error(`Synthetic ORT session reached from ${phase}`);
      const observation = inspectSyntheticOrtSession({ modelId, revision, repositoryPaths, core: args[0], options: args[1] });
      sessions.push({ phase, ...observation });
      return { inputNames: [], outputNames: [], release: released };
    } catch (error) {
      // Production may catch a runtime rejection and try another candidate. That
      // must not hide invalid fixture inputs behind a later accepted candidate.
      sessionErrors.push(error instanceof Error ? error.message : String(error));
      throw error;
    }
  });
  const network = vi.fn<typeof fetch>(async input => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const prefix = `/${modelId}/resolve/`;
    if (url.origin !== 'https://huggingface.co' || !url.pathname.startsWith(prefix)) {
      unknown.push(url.href); throw new Error(`Unknown transport request ${url.href}`);
    }
    const [requestedRevision, ...parts] = url.pathname.slice(prefix.length).split('/');
    const path = parts.map(decodeURIComponent).join('/');
    if (requestedRevision === undefined || (remoteRefs.get(requestedRevision) ?? requestedRevision) !== revision) {
      unknown.push(url.href); throw new Error(`Unexpected mutable or different revision ${url.href}`);
    }
    const modelBody = path.startsWith('onnx/');
    if (!modelBody && !metadataPaths.has(path)) {
      unknown.push(url.href); throw new Error(`Uncaptured metadata request ${url.href}`);
    }
    let body = archive.files.get(path);
    if (modelBody && repositoryPaths.has(path)) body = createSyntheticModelBody({ modelId, revision, path });
    if (!body && repositoryPaths.has(path)) {
      unknown.push(url.href); throw new Error(`Repository-present body unavailable in fixture ${path}`);
    }
    const status = body ? 200 : 404;
    requests.push({ phase, path, revision: requestedRevision, bytes: body?.byteLength ?? 0, status });
    return new Response(body ? Uint8Array.from(body) : 'fixture absent', {
      status, headers: { 'Content-Length': String(body?.byteLength ?? 14), 'Content-Type': path.endsWith('.json') ? 'application/json' : 'application/octet-stream' },
    });
  });
  const forbiddenTransport: typeof fetch = async input => {
    offlineRequests.push(String(input));
    throw new Error('Offline Load reached its forbidden underlying transport');
  };
  const runtimeModules: Runtime[] = [];
  async function boot({ kind }: { kind: 'download' | 'observer' | 'load' | 'fresh-metadata' }) {
    phase = kind;
    const fetchPolicy = (() => {
      switch (kind) {
      case 'load': {
        fs.enter({ nextPhase: kind, mutationPolicy: 'read-only' });
        const identity = { workerLocationUrl: 'http://localhost/assets/worker.js', environment: import.meta.env.DEV ? 'development' as const : 'production' as const, userAgent: 'Vitest', vendor: '' };
        const assets = resolveHostedTransformersRuntimeAssetUrls(identity);
        const guard = createDownloadedModelWorkerFetch({ ...identity, originalFetch: async (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (url !== assets.mjsUrl) return forbiddenTransport(input, init);
          expect(init?.redirect).toBe('error');
          runtimeAssetFetchCalls.push(url);
          return new Response(productionRuntimeModuleFixtureBytes({ variant: assets.variant }), { headers: { 'Content-Type': 'text/javascript' } });
        } });
        const observedGuard: typeof fetch = async (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          offlineFetchCalls.push(url);
          if (url !== assets.mjsUrl) offlineNonRuntimeFetchCalls.push(url);
          return guard(input, init);
        };
        return observedGuard;
      }
      case 'download':
      case 'observer':
        fs.enter({ nextPhase: kind, mutationPolicy: 'read-write' });
        return network;
      case 'fresh-metadata':
        fs.enter({ nextPhase: kind, mutationPolicy: 'read-only' });
        return network;
      default: {
        const _ex: never = kind;
        throw new Error(`Unhandled fixture capability ${_ex}`);
      }
      }
    })();
    vi.stubGlobal('fetch', fetchPolicy);
    vi.stubGlobal('self', { fetch: fetchPolicy, location: new URL('http://localhost/assets/worker.js') });
    vi.stubGlobal('navigator', { userAgent: 'Vitest', vendor: '', gpu: {}, hardwareConcurrency: 2, storage: { getDirectory: async () => fs.root } });
    const actualProcess = globalThis.process;
    vi.stubGlobal('process', { ...actualProcess, release: { ...actualProcess.release, name: 'browser-test' } });
    bundleUrl.searchParams.set('connected-resource-phase', crypto.randomUUID());
    let runtime: Runtime;
    try {
      runtime = await importProductionTransformersArtifact({ moduleUrl: bundleUrl.href }) as Runtime;
    } finally {
      vi.stubGlobal('process', actualProcess);
    }
    runtimeModules.push(runtime);
    vi.resetModules();
    vi.doMock('@huggingface/transformers', () => runtime);
    vi.doMock('@/utils/worker-transport', async () => ({
      ...await vi.importActual<typeof import('@/utils/worker-transport')>('@/utils/worker-transport'),
      exposeWorkerRemote: ({ api }: { api: unknown }) => {
        captured = api;
      },
    }));
    captured = undefined;
    switch (kind) {
    case 'download': await import('@/features/transformers-js/download-verification/download-worker/entry'); break;
    case 'observer': await import('@/features/transformers-js/download-verification/model-artifact-request-worker/entry'); break;
    case 'fresh-metadata': await import('@/features/transformers-js/model-support-investigation/fresh-metadata-worker/entry'); break;
    case 'load': {
      // Node cannot perform browser Blob module imports. Only that platform
      // boundary is simulated; fetch, byte/hash validation, host lease, startup
      // requester and the actual entry initializer below remain connected.
      const importedModules: string[] = [];
      vi.doMock('@/features/transformers-js/runtime/import-production-runtime-module', () => ({
        importProductionRuntimeModule: async ({ objectUrl }: { objectUrl: string }) => {
          expect(new URL(objectUrl).origin).toBe('http://localhost');
          expect(runtimePlatform.blobs.has(objectUrl)).toBe(true);
          importedModules.push(objectUrl);
        },
      }));
      const beforeFetches = runtimeAssetFetchCalls.length;
      const entry = await import('@/features/transformers-js/worker/entry');
      expect(captured).toBeUndefined();
      runtimeLeases.push(await initializeProductionEntryFixture({ initialize: entry.initializeProductionWorkerRuntime }));
      const assets = resolveHostedTransformersRuntimeAssetUrls({ workerLocationUrl: 'http://localhost/assets/worker.js', environment: import.meta.env.DEV ? 'development' : 'production', userAgent: 'Vitest', vendor: '' });
      expectedRuntimeAssetFetchCalls.push(assets.mjsUrl);
      expect(runtimeAssetFetchCalls.slice(beforeFetches)).toEqual([assets.mjsUrl]);
      expect(importedModules).toHaveLength(1);
      expect(runtime.env.backends.onnx.wasm?.wasmPaths).toEqual({ mjs: importedModules[0], wasm: assets.wasmUrl });
      break;
    }
    default: {
      const _ex: never = kind;
      throw new Error(`Unhandled fixture entry ${_ex}`);
    }
    }
    if (!captured) throw new Error(`Worker entry did not expose an API: ${kind}`);
    return captured;
  }
  vi.doMock('@/features/transformers-js/download-verification/runtime-artifact-preparation-worker/client-hosted', () => ({
    createDownloadVerificationRuntimeArtifactPreparationWorkerClient: () => ({
      async prepareModelRuntimeArtifacts({ modelId: id, revision: rev, progressCallback }: {
        modelId: string, revision: string, progressCallback: TransformersJsProgressCallback,
      }) {
        downloadCapabilityCalls.push('metadata');
        const api = await boot({ kind: 'download' }) as DownloadApi;
        return api.prepareModelRuntimeArtifacts(id, rev, info => progressCallback({ info }));
      },
      async dispose() {},
    }),
  }));
  vi.doMock('@/features/transformers-js/download-verification/model-artifact-request-worker/client-hosted', () => ({
    createDownloadVerificationModelArtifactRequestWorkerClient: () => ({
      async observeModelArtifactRequests({ modelId: id, revision: rev, candidate }: Parameters<ObserverApi['observeModelArtifactRequests']>[0]) {
        downloadCapabilityCalls.push('observer');
        const api = await boot({ kind: 'observer' }) as ObserverApi;
        return api.observeModelArtifactRequests({ modelId: id, revision: rev, candidate });
      },
      async dispose() {},
    }),
  }));
  vi.doMock('@/features/transformers-js/download-verification/download-worker/client-hosted', () => ({
    createTransformersJsDownloadWorkerClient: () => ({
      async prefetchUrls({ urls, progressCallback }: { urls: string[], progressCallback: TransformersJsProgressCallback }) {
        downloadCapabilityCalls.push('model-prefetch');
        const api = await boot({ kind: 'download' }) as DownloadApi;
        return api.prefetchUrls(urls, info => progressCallback({ info }));
      },
      async dispose() {},
    }),
  }));
  vi.doMock('@/features/transformers-js/download-verification/candidate-acceptance-worker/client-hosted', () => ({
    createDownloadVerificationCandidateAcceptanceWorkerClient: () => {
      let api: LoadApi | undefined;
      return {
        async verifyDownloadedModelCandidate({ modelId: id, loadRevision, candidate, progressCallback }: {
          modelId: string, loadRevision: string, candidate: Parameters<LoadApi['verifyDownloadedModelCandidate']>[2],
          progressCallback: TransformersJsProgressCallback,
        }) {
          api = await boot({ kind: 'load' }) as LoadApi;
          activeLoads.push(api);
          return api.verifyDownloadedModelCandidate(id, loadRevision, candidate, info => progressCallback({ info }));
        },
        async verifyDownloadedModelRevision({ modelId: id, loadRevision, progressCallback }: {
          modelId: string, loadRevision: string | undefined, progressCallback: TransformersJsProgressCallback,
        }) {
          revisionAcceptanceCalls.push({ modelId: id, revision: loadRevision });
          api = await boot({ kind: 'load' }) as LoadApi;
          activeLoads.push(api);
          return api.verifyDownloadedModelRevision(id, loadRevision, info => progressCallback({ info }));
        },
        async dispose() {
          await api?.unloadModel();
        },
      };
    },
  }));
  const { runProductionDownloadPreparation } = await import('@/features/transformers-js/download-verification/logic/run-production-download-preparation');
  type HostedService = typeof import('@/features/transformers-js/index-hosted')['transformersJsService'];
  let serviceOwner: { service: HostedService, clients: TransformersJsWorkerClient[] } | undefined;
  let serviceSequence = 0;
  let serviceOperation = 0;
  async function importService() {
    const serviceId = ++serviceSequence;
    const clients: TransformersJsWorkerClient[] = [];
    // Each imported singleton retains its own facade factory and client owners.
    // Module-cache isolation is not physical Worker/Realm termination.
    vi.doMock('@/features/transformers-js/worker/client', () => ({
      createTransformersJsWorkerClient: () => {
        let api: LoadApi | undefined;
        let lifecycle: 'active' | 'disposed' = 'active';
        const client: TransformersJsWorkerClient = {
          async loadDownloadedModel({ modelId: id, revision: loadRevision, progressCallback }) {
            switch (lifecycle) {
            case 'active': break;
            case 'disposed': throw new Error('Service used a disposed fixture client');
            default: {
              const _ex: never = lifecycle;
              throw new Error(`Unhandled fixture client lifecycle ${_ex}`);
            }
            }
            if (api) throw new Error('Fixture service client must unload before another load');
            serviceLoadCalls.push({ modelId: id, revision: loadRevision });
            api = await boot({ kind: 'load' }) as LoadApi;
            activeLoads.push(api);
            return api.loadDownloadedModel(id, loadRevision, info => progressCallback({ info }));
          },
          async unloadModel() {
            await api?.unloadModel();
            api = undefined;
          },
          async dispose() {
            switch (lifecycle) {
            case 'active': break;
            case 'disposed': return;
            default: {
              const _ex: never = lifecycle;
              throw new Error(`Unhandled fixture client lifecycle ${_ex}`);
            }
            }
            lifecycle = 'disposed';
            await client.unloadModel();
            serviceClientEvents.push({ service: serviceId, event: 'disposed' });
          },
          async interrupt() {
            throw new Error('Service interrupt is outside this fixture contract');
          },
          async resetCache() {
            throw new Error('Service resetCache is outside this fixture contract');
          },
          async generateText() {
            throw new Error('Service generation is outside this fixture contract');
          },
        };
        clients.push(client);
        serviceClientEvents.push({ service: serviceId, event: 'created' });
        return client;
      },
    }));
    vi.resetModules();
    const { transformersJsService: service } = await import('@/features/transformers-js/index-hosted');
    serviceOwner = { service, clients };
    return service;
  }
  async function retireService() {
    const owner = serviceOwner;
    if (!owner) return;
    await owner.service.unloadModel();
    // The public service's unload clears model state but keeps its client.
    // Release that retained facade before abandoning this singleton. This lane
    // never registers UI listeners; there are no subscriptions to carry forward.
    for (const client of owner.clients) await client.dispose();
    serviceOwner = undefined;
  }
  function enterServiceOffline() {
    fs.enter({ nextPhase: 'service-load', mutationPolicy: 'read-only' });
    vi.stubGlobal('fetch', forbiddenTransport);
    vi.stubGlobal('navigator', { userAgent: 'Vitest', vendor: '', gpu: {}, hardwareConcurrency: 2, storage: { getDirectory: async () => fs.root } });
  }
  return {
    archive, repository, requests, unknown, offlineRequests, offlineFetchCalls, offlineNonRuntimeFetchCalls, runtimeAssetFetchCalls, sessions, sessionErrors, downloadCapabilityCalls, released, fs, runtimeArtifact, network,
    revisionAcceptanceCalls, serviceApiRequests, serviceLoadCalls, serviceClientEvents,
    async freshMetadata() {
      const api = await boot({ kind: 'fresh-metadata' }) as WorkerServerApi<FreshMetadataWorker>;
      const observations: FreshMetadataSummary[] = [];
      const { REPLAY_METADATA_PATHS } = await import('@/features/transformers-js/model-support-investigation/logic/collect-replay-metadata');
      // The model-only inventory is not a repository metadata manifest. Require
      // explicit presence/absence evidence for every collector path before replay.
      for (const path of REPLAY_METADATA_PATHS) {
        if (!metadataPaths.has(path)) throw new Error(`Unrecorded metadata inventory: ${path}`);
      }
      const repositoryFiles = [
        ...repository.files.map(({ path, size }) => ({ path, size })),
        ...archive.summary.files.flatMap(resource => {
          switch (resource.status) {
          case 'recorded': return [{ path: resource.path, size: resource.byteLength }];
          case 'repository-absent': return [];
          default: {
            const _ex: never = resource;
            throw new Error(`Unknown fixture resource: ${_ex}`);
          }
          }
        }),
      ];
      const result = await api.run({ modelId, revision, maximumBytes: 48 * 1024 * 1024, repositoryFiles }, ({ summary }) => {
        observations.push(structuredClone(summary));
      });
      return { result, observations };
    },
    async serviceDownload() {
      const operation = ++serviceOperation;
      let authority: 'active' | 'expired' = 'active';
      // Bind API attribution to this caller, never to the mutable Worker phase.
      // This does not isolate late code that reads globalThis.fetch anew: the
      // harness still requires sequential operations and lacks physical Realms.
      const repositoryFetch: typeof fetch = async input => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const expectedUrl = `https://huggingface.co/api/models/${modelId}/revision/main`;
        if (authority !== 'active' || url !== expectedUrl || remoteRefs.get('main') !== revision) {
          unknown.push(url);
          throw new Error(`Unexpected or expired service repository request ${url}`);
        }
        serviceApiRequests.push({ operation, url });
        return new Response(JSON.stringify({ sha: revision }), { headers: { 'Content-Type': 'application/json' } });
      };
      enterServiceOffline();
      vi.stubGlobal('fetch', repositoryFetch);
      try {
        const service = serviceOwner?.service ?? await importService();
        await service.downloadModel({ modelId });
        return service.getState();
      } finally {
        authority = 'expired';
        vi.stubGlobal('fetch', forbiddenTransport);
        assertSessionOracle();
      }
    },
    async coldServiceLoad() {
      await retireService();
      enterServiceOffline();
      const service = await importService();
      try {
        await service.loadDownloadedModel({ modelId });
        return service.getState();
      } finally {
        assertSessionOracle();
      }
    },
    async run() {
      try {
        return await runProductionDownloadPreparation({ modelId, revision, progressCallback: () => undefined });
      } finally {
        assertSessionOracle();
      }
    },
    async freshLoad({ progressCallback }: { progressCallback: TransformersJsProgressCallback | undefined }) {
      const api = await boot({ kind: 'load' }) as LoadApi;
      activeLoads.push(api);
      try {
        return await api.loadDownloadedModel(modelId, revision, info => progressCallback?.({ info }));
      } finally {
        assertSessionOracle();
      }
    },
    async close() {
      const failures: unknown[] = [];
      // Every owner gets its teardown even when another unload rejects. These
      // facades do not prove real ORT partial-session disposal or Realm abort.
      for (const release of [retireService, ...activeLoads.map(api => () => api.unloadModel())]) {
        try {
          await release();
        } catch (error) {
          failures.push(error);
        }
      }
      for (const lease of runtimeLeases) {
        try {
          lease.dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        expect(runtimePlatform.blobs.size).toBe(0);
        // Lifetime ledger, not only the startup snapshot: later duplicate MJS
        // fetches cannot disappear into the non-runtime/model-only assertions.
        expect(runtimeAssetFetchCalls).toEqual(expectedRuntimeAssetFetchCalls);
        expect(offlineFetchCalls.filter(url => !offlineNonRuntimeFetchCalls.includes(url))).toEqual(expectedRuntimeAssetFetchCalls);
      } catch (error) {
        failures.push(error);
      }
      for (const runtime of runtimeModules) runtime.env.fetch = forbiddenTransport;
      sessionSpy.mockRestore();
      for (const module of [
        '@huggingface/transformers', '@/utils/worker-transport',
        '@/features/transformers-js/runtime/import-production-runtime-module',
        '@/features/transformers-js/worker/client',
        '@/features/transformers-js/download-verification/runtime-artifact-preparation-worker/client-hosted',
        '@/features/transformers-js/download-verification/model-artifact-request-worker/client-hosted',
        '@/features/transformers-js/download-verification/download-worker/client-hosted',
        '@/features/transformers-js/download-verification/candidate-acceptance-worker/client-hosted',
      ]) vi.doUnmock(module);
      vi.unstubAllGlobals(); vi.resetModules();
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Connected replay teardown failed');
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
