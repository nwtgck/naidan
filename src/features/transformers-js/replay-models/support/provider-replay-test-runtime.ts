import { vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- Type-only description of the injected native inference boundary, never a main-thread runtime import.
import type { PreTrainedModel, PreTrainedTokenizer } from '@huggingface/transformers';
import type { ITransformersJsWorker } from '@/features/transformers-js/types';
import type { WorkerServerApi } from '@/utils/worker-transport';
import { createProviderReplayTestWorkerConstructor, type ProviderReplayTestWorker } from './provider-replay-test-transport';
import { readModelFixture } from '@/features/transformers-js/replay-models/support/model-runtime-fixture';
import { createMemoryFiles } from '@/features/transformers-js/replay-models/support/download-memory-files';
import { getProductionTransformersArtifact, importProductionTransformersArtifact } from '@/features/transformers-js/runtime/fixtures/production-transformers-artifact';
import { installProductionRuntimeStartupPlatform, productionRuntimeModuleFixtureBytes } from '@/features/transformers-js/runtime/fixtures/production-runtime-startup-fixture';
import { createDownloadedModelWorkerFetch } from '@/features/transformers-js/runtime/offline-worker-fetch';
import { resolveHostedTransformersRuntimeAssetUrls } from '@/features/transformers-js/runtime/configure-hosted-runtime';
import { createProductionRuntimeModuleRequester, startProductionWorkerRuntime } from '@/features/transformers-js/worker/production-worker-startup';
import type { createProviderReplayTestImagePlatform } from './provider-replay-test-image-platform';

type Runtime = typeof import('@huggingface/transformers');
export type ProviderReplayGenerate = ({ options, model, tokenizer, runtime }: {
  options: Parameters<PreTrainedModel['generate']>[0],
  model: PreTrainedModel,
  tokenizer: PreTrainedTokenizer,
  runtime: Runtime,
}) => ReturnType<PreTrainedModel['generate']>;

/**
 * Actual hosted Provider/service/client/Comlink/entry/tokenizer/streamer. The
 * browser Worker and OPFS platforms are simulated in one sequential Node Realm;
 * this does not prove browser scheduling, Blob/CSP, native pixels or real ORT.
 * Model-specific causal checks and inference results belong to the caller.
 */
export async function createProviderReplayTestRuntime({ modelId, expectedRevision, cacheRevision, metadataCache, artifacts, generate, imagePlatform }: {
  modelId: string,
  expectedRevision: string,
  cacheRevision: string,
  metadataCache: 'all-fixture' | readonly string[],
  artifacts: ReadonlyArray<{ path: string, bytes: Uint8Array }>,
  generate: ProviderReplayGenerate,
  imagePlatform: {
    platform: ReturnType<typeof createProviderReplayTestImagePlatform>,
    allowedDataUrls: readonly string[],
  } | undefined,
}) {
  const allowedImageUrls = new Set<string>();
  if (imagePlatform !== undefined) {
    for (const url of imagePlatform.allowedDataUrls) {
      // This is a bounded encoded-input capability, not a generic data: fetch
      // bypass. The PNG decoder independently enforces its decoded-byte limit.
      if (url.length > 8192 || !/^data:image\/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(url)
        || url === 'data:image/png;base64,') throw new Error('Replay image capability must be an exact bounded PNG data URL');
      allowedImageUrls.add(url);
    }
  }
  const fixture = readModelFixture({ modelId });
  if (fixture.summary.revision !== expectedRevision) throw new Error('Replay revision differs from original metadata');
  if (cacheRevision !== 'main' && cacheRevision !== expectedRevision) throw new Error('Replay cache namespace must be original metadata revision or explicit legacy main');
  const fs = createMemoryFiles();
  const recordedPaths = new Set(fixture.repository.files.map(file => file.path));
  const metadataPaths = metadataCache === 'all-fixture' ? [...fixture.files.keys()] : metadataCache;
  if (new Set(metadataPaths).size !== metadataPaths.length || metadataPaths.some(path => !fixture.files.has(path))) throw new Error('Unprovided or duplicate replay cache metadata');
  const seeded = new Map(metadataPaths.map(path => [path, fixture.files.get(path)!]));
  const artifact = await getProductionTransformersArtifact();
  for (const { path, bytes } of artifacts) {
    if (!recordedPaths.has(path) || !path.startsWith('onnx/') || seeded.has(path) || bytes.byteLength === 0) {
      throw new Error(`Invalid model-specific replay artifact: ${path}`);
    }
    seeded.set(path, Uint8Array.from(bytes));
  }
  for (const [path, bytes] of seeded) {
    const key = `models/huggingface.co/${modelId}/resolve/${cacheRevision}/${path}`;
    let directory = fs.root;
    for (const part of key.split('/').slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
    // Setup injects original metadata and explicit tiny model bodies. Production
    // still performs all inventory, marker, scope, plan and read-only checks.
    fs.files.set(key, Uint8Array.from(bytes));
    const slash = key.lastIndexOf('/');
    fs.files.set(`${key.slice(0, slash + 1)}.${key.slice(slash + 1)}.complete`, new Uint8Array());
  }
  fs.activity.length = 0;
  fs.enter({ nextPhase: 'provider-replay', mutationPolicy: 'read-only' });
  const identity = { workerLocationUrl: 'http://localhost/assets/replay-worker.js', environment: import.meta.env.DEV ? 'development' as const : 'production' as const, userAgent: 'Vitest', vendor: '' };
  const assets = resolveHostedTransformersRuntimeAssetUrls(identity);
  const restorations: Array<() => void> = [];
  const cleanupErrors: unknown[] = [];
  function rememberProperty({ target, key }: { target: object, key: string }) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    restorations.push(() => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    });
  }
  function setOwnedGlobal({ key, value }: { key: string, value: unknown }) {
    rememberProperty({ target: globalThis, key });
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  function cleanup() {
    for (const restore of restorations.splice(0).reverse()) {
      try {
        restore();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  // The shared browser-platform fixture also has an afterEach safety net. This
  // owner restores immediately on construction failure/close, without undoing
  // unrelated globals installed by the model test (e.g. its captured clock).
  rememberProperty({ target: globalThis, key: 'Blob' });
  rememberProperty({ target: globalThis, key: 'crypto' });
  rememberProperty({ target: URL, key: 'createObjectURL' });
  rememberProperty({ target: URL, key: 'revokeObjectURL' });
  try {
    const platform = installProductionRuntimeStartupPlatform({ origin: 'http://localhost' });
    const fetchCalls: string[] = [];
    const runtimeAssetFetchCalls: string[] = [];
    const localImageFetchCalls: string[] = [];
    const forbiddenTransport: string[] = [];
    const nativeLocalFetch = globalThis.fetch.bind(globalThis);
    const guard = createDownloadedModelWorkerFetch({ ...identity, originalFetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (allowedImageUrls.has(url)) {
        const request = new Request(input, init);
        if (request.url !== url || request.method !== 'GET' || request.redirect !== 'error') {
          throw new Error('Unsupported local replay image request');
        }
        localImageFetchCalls.push(url);
        // The real offline guard already ran. Only this snapshotted exact PNG
        // URL may reach the native local decoder; HTTP/blob/file never do.
        // Request construction retains headers/signal and init precedence.
        return nativeLocalFetch(request);
      }
      if (url !== assets.mjsUrl || init?.redirect !== 'error') {
        forbiddenTransport.push(url);
        throw new Error(`Unprovided replay transport: ${url}`);
      }
      runtimeAssetFetchCalls.push(url);
      return new Response(productionRuntimeModuleFixtureBytes({ variant: assets.variant }), { headers: { 'Content-Type': 'text/javascript' } });
    } });
    const fetchPolicy: typeof fetch = (input, init) => {
      fetchCalls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return guard(input, init);
    };
    setOwnedGlobal({ key: 'fetch', value: fetchPolicy });
    const workerFields = { fetch: fetchPolicy, location: new URL(identity.workerLocationUrl) };
    if (imagePlatform === undefined) {
      setOwnedGlobal({ key: 'self', value: workerFields });
    } else {
      // Upstream env.js checks self.constructor.name at module evaluation, and
      // RawImage captures these image APIs then. Use a matching instance and
      // owned global constructors, not a later mutation of env or RawImage.
      class WorkerGlobalScope extends EventTarget {}
      class DedicatedWorkerGlobalScope extends WorkerGlobalScope {}
      const { ImageData, OffscreenCanvas, createImageBitmap, observations: _observations, ...unhandled } = imagePlatform.platform;
      unhandled satisfies Record<PropertyKey, never>;
      setOwnedGlobal({ key: 'WorkerGlobalScope', value: WorkerGlobalScope });
      setOwnedGlobal({ key: 'DedicatedWorkerGlobalScope', value: DedicatedWorkerGlobalScope });
      setOwnedGlobal({ key: 'ImageData', value: ImageData });
      setOwnedGlobal({ key: 'OffscreenCanvas', value: OffscreenCanvas });
      setOwnedGlobal({ key: 'createImageBitmap', value: createImageBitmap });
      setOwnedGlobal({ key: 'self', value: Object.assign(new DedicatedWorkerGlobalScope(), workerFields, { ImageData, OffscreenCanvas, createImageBitmap }) });
    }
    setOwnedGlobal({ key: 'navigator', value: { userAgent: identity.userAgent, vendor: '', gpu: {}, hardwareConcurrency: 2, storage: { getDirectory: async () => fs.root } } });
    // ORT's heavyweight constructor is replaced, not AutoModel resource loading.
    const ort = await import(/* @vite-ignore */ artifact.ortWebGpuUrl) as {
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors the external ORT factory's positional API.
      InferenceSession: { create: (...args: unknown[]) => Promise<unknown> },
    };
    const ortCalls: unknown[][] = [];
    const ortSpy = vi.spyOn(ort.InferenceSession, 'create').mockImplementation(async (...args) => {
      ortCalls.push(args);
      return { inputNames: [], outputNames: [], release: async () => undefined };
    });
    restorations.push(() => ortSpy.mockRestore());
    const url = new URL(artifact.moduleUrl);
    url.searchParams.set('provider-replay', crypto.randomUUID());
    const originalProcess = globalThis.process;
    setOwnedGlobal({ key: 'process', value: { ...originalProcess, release: { ...originalProcess.release, name: 'browser-test' } } });
    let runtime: Runtime;
    try {
      runtime = await importProductionTransformersArtifact({ moduleUrl: url.href }) as Runtime;
    } finally {
      Object.defineProperty(globalThis, 'process', { configurable: true, writable: true, value: originalProcess });
    }
    let tokenizer: PreTrainedTokenizer | undefined;
    const originalTokenizer = runtime.AutoTokenizer.from_pretrained.bind(runtime.AutoTokenizer);
    const tokenizerSpy = vi.spyOn(runtime.AutoTokenizer, 'from_pretrained').mockImplementation(async (...args) => {
      tokenizer = await originalTokenizer(...args);
      return tokenizer;
    });
    restorations.push(() => tokenizerSpy.mockRestore());
    const processors: Array<Awaited<ReturnType<Runtime['AutoProcessor']['from_pretrained']>>> = [];
    const originalProcessor = runtime.AutoProcessor.from_pretrained.bind(runtime.AutoProcessor);
    const processorSpy = vi.spyOn(runtime.AutoProcessor, 'from_pretrained').mockImplementation(async (...args) => {
      const processor = await originalProcessor(...args);
      processors.push(processor);
      // Processor subclasses may construct their tokenizer internally without
      // going through the exported AutoTokenizer. Observe that actual instance;
      // never replace the callable processor, its components or its cache.
      if (processor.tokenizer instanceof runtime.PreTrainedTokenizer) tokenizer = processor.tokenizer;
      return processor;
    });
    restorations.push(() => processorSpy.mockRestore());
    const inferenceCalls: Parameters<PreTrainedModel['generate']>[0][] = [];
    for (const autoClass of [runtime.AutoModelForCausalLM, runtime.AutoModelForImageTextToText]) {
      const original = autoClass.from_pretrained.bind(autoClass);
      const modelSpy = vi.spyOn(autoClass, 'from_pretrained').mockImplementation(async (...args) => {
        const model = await original(...args);
        model.generate = options => {
          if (!(options.input_ids instanceof runtime.Tensor)) throw new Error('Replay requires actual Tensor: input_ids');
          if ('attention_mask' in options && !(options.attention_mask instanceof runtime.Tensor)) throw new Error('Replay requires actual Tensor: attention_mask');
          if (!tokenizer) throw new Error('Inference reached before actual tokenizer preparation');
          inferenceCalls.push(options);
          return generate({ options, model, tokenizer, runtime });
        };
        return model;
      });
      restorations.push(() => modelSpy.mockRestore());
    }
    vi.resetModules();
    vi.doMock('@huggingface/transformers', () => runtime);
    restorations.push(() => vi.doUnmock('@huggingface/transformers'));
    const workers: ProviderReplayTestWorker[] = [];
    let activeWorker: ProviderReplayTestWorker | undefined;
    vi.doMock('@/utils/worker-transport', async () => {
      const actual = await vi.importActual<typeof import('@/utils/worker-transport')>('@/utils/worker-transport');
      return { ...actual, exposeWorkerRemote: ({ api, endpoint }: {
        api: WorkerServerApi<ITransformersJsWorker>, endpoint: Parameters<typeof actual.exposeWorkerRemote>[0]['endpoint'],
      }) => {
        if (endpoint !== undefined || !activeWorker) throw new Error('Unexpected replay Worker exposure');
        // Only supplies the native Worker-global endpoint. Serialization, callback
        // transfer, method this binding and RPC completion remain actual Comlink.
        actual.exposeWorkerRemote<ITransformersJsWorker>({ api, endpoint: activeWorker.endpoint });
      } };
    });
    restorations.push(() => vi.doUnmock('@/utils/worker-transport'));
    vi.doMock('@/features/transformers-js/runtime/import-production-runtime-module', () => ({
      importProductionRuntimeModule: async ({ objectUrl }: { objectUrl: string }) => {
        if (new URL(objectUrl).origin !== 'http://localhost' || !platform.blobs.has(objectUrl)) throw new Error('Unowned replay Blob module');
        // Node cannot import browser-origin Blob URLs. Byte/hash/lease checks and
        // the real initializer still execute; this is only native module evaluation.
      },
    }));
    restorations.push(() => vi.doUnmock('@/features/transformers-js/runtime/import-production-runtime-module'));
    setOwnedGlobal({ key: 'Worker', value: createProviderReplayTestWorkerConstructor({
      scriptUrl: new URL('../../worker/bootstrap.ts', import.meta.url),
      onConstructed: ({ worker }) => workers.push(worker),
      start: async ({ worker }) => {
        activeWorker = worker;
        await startProductionWorkerRuntime({ loadEntry: async () => {
          const entry = await import('@/features/transformers-js/worker/entry');
          const { requestRuntimeModule } = createProductionRuntimeModuleRequester({ endpoint: worker.startupEndpoint });
          return entry.initializeProductionWorkerRuntime({ requestRuntimeModule });
        }, postMessage: ({ message }) => worker.sendFromWorker({ message }) });
      },
    }) });
    restorations.push(() => {
      // A host terminal event disposes its real session and module URL lease.
      for (const worker of workers) {
        try {
          worker.dispatchEvent(new Event('error'));
        } finally {
          worker.terminate();
        }
      }
    });
    const { TransformersJsProvider } = await import('@/features/transformers-js/provider-hosted');
    const { transformersJsService: service } = await import('@/features/transformers-js/index-hosted');
    return {
      provider: new TransformersJsProvider(), service, runtime,
      observations: { fs, fetchCalls, runtimeAssetFetchCalls, localImageFetchCalls, forbiddenTransport, ortCalls, inferenceCalls, processors, workers, platform, cleanupErrors, expectedRuntimeAssetUrl: assets.mjsUrl },
      async close() {
        try {
          await service.unloadModel();
        } catch (error) {
          cleanup();
          throw error;
        }
        cleanup();
        if (cleanupErrors.length > 0) throw cleanupErrors[0];
      },
    };
  } catch (error) {
    cleanup();
    // Restoration failures are secondary; retain the original setup failure.
    throw error;
  }
}

export const TEST_ONLY = {
};
