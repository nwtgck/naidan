import { MessageChannel } from 'node:worker_threads';
import { Buffer } from 'node:buffer';
import { URL as NodeUrl } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import JSZip from 'jszip';
import { z } from 'zod';
import { ProductionReplayTestWorker } from '@/features/transformers-js/production-replay-test-transport';
import { createProductionReplayTestRuntime } from '@/features/transformers-js/production-replay-test-runtime';
import { createProductionReplayTestImagePlatform } from '@/features/transformers-js/production-replay-test-image-platform';
import { readModelFixture } from '@/features/transformers-js/download-verification/fixtures/model-runtime-fixture';
import { createSyntheticModelBody } from '@/features/transformers-js/download-verification/fixtures/raw-download-replay/synthetic-session-oracle';
import { MODEL_SUPPORT_INVESTIGATION_MULTIMODAL_FIXTURE as image } from '@/features/transformers-js/model-support-investigation/fixtures/synthetic-multimodal-image';
import { resolveHostedTransformersRuntimeAssetUrls } from '@/features/transformers-js/runtime/configure-hosted-runtime';
import { createInvestigationFullFlowTestHttp } from '@/features/transformers-js/model-support-investigation/fixtures/full-flow-test-http';
import { getProductionTransformersArtifact, importProductionTransformersArtifact } from '@/features/transformers-js/runtime/fixtures/production-transformers-artifact';
import { productionLoadReceiptSchema } from '@/features/transformers-js/runtime/production-load-receipt';
import { productionLoadObservationSchema } from '@/features/transformers-js/worker/load-receipt';

const nativeBytes = await vi.hoisted(async () => {
  const { Buffer } = await import('node:buffer');
  const Uint8Array = Object.getPrototypeOf(Buffer.prototype).constructor as Uint8ArrayConstructor;
  const ArrayBuffer = Buffer.alloc(0).buffer.constructor as ArrayBufferConstructor;
  // Install before schema and JSZip/pako modules capture byte constructors.
  vi.stubGlobal('Uint8Array', Uint8Array); vi.stubGlobal('ArrayBuffer', ArrayBuffer);
  return { Uint8Array, ArrayBuffer };
});

vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: vi.fn() }) }));

const models = [
  { modelId: 'onnx-community/Qwen3.5-2B-ONNX', revision: 'b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb', extraShards: [] },
  { modelId: 'onnx-community/Qwen3.5-4B-ONNX', revision: '74d8caba2117fd5f41d655e9cc27eda1338662b3', extraShards: ['onnx/decoder_model_merged_q4f16.onnx_data_1'] },
];
type WorkerKind = 'planning' | 'production' | 'evidence' | 'fresh-metadata' | 'request-observer';
const productionLoadEnvelope = z.object({ type: z.literal('APPLY'), path: z.tuple([z.literal('loadDownloadedModel')]) }).passthrough();
const nativeLoadIndexSchema = z.object({ runId: z.string(), epochs: z.array(z.object({
  workerEpoch: z.number(), collection: z.object({ status: z.literal('returned'), result: z.object({
    status: z.enum(['captured', 'not-started']), loadObservation: productionLoadObservationSchema,
  }) }),
})) });
const archivedAcceptanceSchema = z.object({
  status: z.enum(['accepted', 'failed', 'exhausted']), source: z.literal('ordinary-provider-load'),
  repositoryResolvedRevision: z.string(), cacheRevision: z.string().nullable(), loaderRevisionOption: z.string().nullable(),
  revisionIdentity: z.enum(['exact-resolved-revision', 'legacy-main-unverified', 'unverified']).nullable(),
  receipt: productionLoadReceiptSchema.nullable(), cacheReuse: z.null(),
});

function artifactsForModel({ modelId, revision, extraShards }: typeof models[number]) {
  return [
    'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
    'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
    'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data', ...extraShards,
  ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId, revision, path }) }));
}

afterEach(() => {
  vi.doUnmock('@/utils/worker-transport');
  vi.doUnmock('onnxruntime-web');
  vi.doUnmock('@/features/transformers-js/model-support-investigation/worker/import-planning-runtime-module');
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  vi.useRealTimers();
});

// One sequential Node platform supplies independent module instances to each
// Worker. Comlink, startup leases, all ID/checkpoint validation, public Provider,
// actual runtime artifact/tokenizer/streamer and ZIP code execute unchanged.
// GPU/ORT construction, native inference and browser module/image/OPFS platforms
// are substitutes. Synthetic replies certify collection, not model correctness.
describe('complete Full collection through Session and actual Worker transports', () => {
  it.each([
    { preset: 'offline', firstTarget: 'success' },
    { preset: 'full', firstTarget: 'success' },
    { preset: 'full', firstTarget: 'image-rejection' },
    { preset: 'full', firstTarget: 'missing-cache' },
    { preset: 'full', firstTarget: 'different-revision' },
  ] as const)('settles $preset Full with first target $firstTarget, continues the next target and re-exports retained evidence', async ({ preset, firstTarget }) => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    // Native MessagePorts clone into Node's realm. Use that same platform byte
    // constructor so schema instanceof checks retain their browser semantics.
    vi.stubGlobal('Uint8Array', nativeBytes.Uint8Array);
    vi.stubGlobal('ArrayBuffer', nativeBytes.ArrayBuffer);
    const first = models[0]!;
    const expectedFirst = (() => {
      switch (firstTarget) {
      case 'success':
      case 'different-revision': return { status: 'passed', nativeCalls: 13, recording: 'recorded', fulfilled: 13, rejected: 0, notStarted: 0 };
      case 'image-rejection': return { status: 'failed', nativeCalls: 13, recording: 'recorded', fulfilled: 12, rejected: 1, notStarted: 0 };
      case 'missing-cache': return { status: 'failed', nativeCalls: 0, recording: 'not-recorded', fulfilled: 0, rejected: 1, notStarted: 12 };
      default: { const exhaustive: never = firstTarget; throw new Error('Unexpected Full control: ' + exhaustive); }
      }
    })();
    // Missing-cache is a real offline Load failure: do not seed the first
    // model's directory. Only the independently successful second target exists.
    const seededModel = firstTarget === 'missing-cache' ? models[1]! : first;
    const harness = await createProductionReplayTestRuntime({
      modelId: seededModel.modelId, expectedRevision: seededModel.revision, artifacts: artifactsForModel(seededModel),
      imagePlatform: { platform: createProductionReplayTestImagePlatform(), allowedDataUrls: [image.dataUrl] },
      generate: async () => {
        throw new Error('The platform setup runtime must not perform Worker inference');
      },
    });
    let inferenceCalls = 0;
    const workerRuntimes: Array<{ kind: Exclude<WorkerKind, 'evidence'>; runtime: typeof import('@huggingface/transformers'); inferenceCalls: number }> = [];
    const workers: Array<ProductionReplayTestWorker & { kind: string }> = [];
    const startupErrors: unknown[] = [];
    const startupStages: string[] = [];
    const nativeSelf = self;
    const originalFetch = fetch;
    let activeWorker: ProductionReplayTestWorker | undefined;
    let wrapper: ReturnType<typeof mount> | undefined;
    try {
      const artifact = await getProductionTransformersArtifact();
      async function loadWorkerRuntime({ kind }: { kind: Exclude<WorkerKind, 'evidence'> }) {
        const moduleUrl = new NodeUrl(artifact.moduleUrl);
        moduleUrl.searchParams.set('full-worker', `${kind}-${crypto.randomUUID()}`);
        const originalProcess = globalThis.process;
        vi.stubGlobal('process', { ...originalProcess, release: { ...originalProcess.release, name: 'browser-test' } });
        let runtime: typeof import('@huggingface/transformers');
        try {
          runtime = await importProductionTransformersArtifact({ moduleUrl: moduleUrl.href }) as typeof runtime;
        } finally {
          vi.stubGlobal('process', originalProcess);
        }
        const runtimeObservation = { kind, runtime, inferenceCalls: 0 };
        workerRuntimes.push(runtimeObservation);
        if (kind === 'production') {
          const productionOrdinal = workerRuntimes.filter(item => item.kind === 'production').length;
          let tokenizer: Awaited<ReturnType<typeof runtime.AutoTokenizer.from_pretrained>> | undefined;
          const loadTokenizer = runtime.AutoTokenizer.from_pretrained.bind(runtime.AutoTokenizer);
          vi.spyOn(runtime.AutoTokenizer, 'from_pretrained').mockImplementation(async (...args) => {
            tokenizer = await loadTokenizer(...args); return tokenizer;
          });
          const loadProcessor = runtime.AutoProcessor.from_pretrained.bind(runtime.AutoProcessor);
          vi.spyOn(runtime.AutoProcessor, 'from_pretrained').mockImplementation(async (...args) => {
            const processor = await loadProcessor(...args);
            if (processor.tokenizer instanceof runtime.PreTrainedTokenizer) tokenizer = processor.tokenizer;
            return processor;
          });
          for (const autoClass of [runtime.AutoModelForCausalLM, runtime.AutoModelForImageTextToText]) {
            const loadModel = autoClass.from_pretrained.bind(autoClass);
            vi.spyOn(autoClass, 'from_pretrained').mockImplementation(async (...args) => {
              const model = await loadModel(...args);
              model.generate = async options => {
                const input = options.input_ids;
                if (!(input instanceof runtime.Tensor) || options.streamer === undefined || tokenizer === undefined) throw new Error('Expected actual native inputs, tokenizer and streamer');
                inferenceCalls++;
                runtimeObservation.inferenceCalls++;
                if (firstTarget === 'image-rejection' && productionOrdinal === 1 && options.pixel_values !== undefined) {
                  expect(options.pixel_values).toBeInstanceOf(runtime.Tensor);
                  // Synthetic rejection certifies the Full failure/cleanup
                  // path, not the cause of any observed browser model error.
                  throw new TypeError('Synthetic native image rejection');
                }
                const output = tokenizer.encode('Synthetic collection reply.', { add_special_tokens: false }).map(BigInt);
                options.streamer.put(input.tolist()); options.streamer.put([output]); options.streamer.end();
                const sequence = [...input.data].map(BigInt).concat(output);
                return { sequences: new runtime.Tensor('int64', sequence, [1, sequence.length]) };
              };
              return model;
            });
          }
        }
        return runtime;
      }
      // Seed the second model at the OPFS platform before the real read-only run.
      const fs = harness.observations.fs;
      fs.enter({ nextPhase: 'fixture-setup', mutationPolicy: 'read-write' });
      for (const model of models.filter(item => item !== seededModel && firstTarget !== 'missing-cache')) {
        const fixture = readModelFixture({ modelId: model.modelId });
        expect(fixture.summary.revision).toBe(model.revision);
        for (const [path, bytes] of new Map([...fixture.files, ...artifactsForModel(model).map(item => [item.path, item.bytes] as const)])) {
          const key = `models/huggingface.co/${model.modelId}/resolve/${model.revision}/${path}`;
          let directory = fs.root;
          for (const part of key.split('/').slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
          fs.files.set(key, Uint8Array.from(bytes));
          const slash = key.lastIndexOf('/');
          fs.files.set(`${key.slice(0, slash + 1)}.${key.slice(slash + 1)}.complete`, new Uint8Array());
        }
      }
      fs.activity.length = 0; fs.enter({ nextPhase: 'full-investigation', mutationPolicy: 'read-only' });
      const assets = resolveHostedTransformersRuntimeAssetUrls({ workerLocationUrl: 'http://localhost/assets/planning-worker.js', environment: import.meta.env.DEV ? 'development' : 'production', userAgent: 'Vitest', vendor: '' });
      const http = createInvestigationFullFlowTestHttp({ models, assets, externalNetworkPolicy: preset === 'full' ? 'allow' : 'deny',
        repositoryRevisions: new Map(firstTarget === 'different-revision' ? [[first.modelId, 'a'.repeat(40)]] : []),
      });
      const planningFetch = http.fetch;
      vi.stubGlobal('MessageChannel', MessageChannel);
      vi.stubGlobal('navigator', { ...navigator, userAgent: 'Vitest', vendor: '', hardwareConcurrency: 2,
        gpu: { requestAdapter: async () => ({ features: new Set(['shader-f16']), limits: {} }) },
        storage: { getDirectory: async () => fs.root } });
      vi.doMock('onnxruntime-web', () => ({
        InferenceSession: { create: async () => ({ run: async () => ({ y: { data: [7] } }), release: async () => undefined }) },
        Tensor: class {},
      }));
      vi.doMock('@/features/transformers-js/model-support-investigation/worker/import-planning-runtime-module', () => ({
        importPlanningRuntimeModule: async ({ url }: { url: string }) => {
          if (url !== assets.mjsUrl) throw new Error('Unexpected native planning module evaluation');
          // Preflight has already fetched and SHA-256 verified the installed MJS.
          // Node cannot natively evaluate its browser-origin HTTP URL.
        },
      }));
      vi.doMock('@/utils/worker-transport', async () => {
        const actual = await vi.importActual<typeof import('@/utils/worker-transport')>('@/utils/worker-transport');
        return { ...actual, exposeWorkerRemote: ({ api, endpoint }: Parameters<typeof actual.exposeWorkerRemote>[0]) => {
          startupStages.push('expose');
          if (endpoint !== undefined || activeWorker === undefined) throw new Error('Unexpected Worker-global exposure');
          actual.exposeWorkerRemote({ api, endpoint: activeWorker.endpoint });
        } };
      });
      vi.stubGlobal('Worker', class extends ProductionReplayTestWorker {
        readonly kind: WorkerKind;
        constructor(url: string | URL, options: WorkerOptions | undefined) {
          const pathname = new NodeUrl(String(url)).pathname;
          const kind = pathname.endsWith('/model-support-investigation/worker/entry.ts') ? 'planning'
            : pathname.endsWith('/transformers-js/worker/bootstrap.ts') ? 'production'
              : pathname.endsWith('/model-support-investigation/evidence-worker/entry.ts') ? 'evidence'
                : pathname.endsWith('/model-support-investigation/fresh-metadata-worker/entry.ts') ? 'fresh-metadata'
                  : pathname.endsWith('/download-verification/model-artifact-request-worker/entry.ts') ? 'request-observer' : undefined;
          if (kind === undefined) throw new Error(`Unexpected Full Worker entry: ${pathname}`);
          expect(options?.type).toBe('module');
          super({ start: async ({ worker }) => {
            startupStages.push('start-' + kind);
            activeWorker = worker;
            if (kind !== 'evidence') {
              // This sequential in-process platform reuses its browser image
              // globals, but each entry must capture a fresh base fetch, never
              // the preceding Production Worker's OPFS interception wrapper.
              if (kind === 'production') nativeSelf.fetch = originalFetch;
              vi.stubGlobal('self', kind === 'production' ? nativeSelf : { fetch: planningFetch, location: new NodeUrl(`http://localhost/assets/${kind}-worker.js`) });
              // Independent runtime modules are essential: request observation
              // intentionally holds fetch promises until its Worker is killed.
              const runtime = await loadWorkerRuntime({ kind });
              vi.doMock('@huggingface/transformers', () => runtime);
            }
            // Only module state is fresh; native ports and real one-shot startup
            // still decide when the host is allowed to use each Worker.
            vi.resetModules();
            switch (kind) {
            case 'planning':
              vi.stubGlobal('self', { fetch: planningFetch, location: new NodeUrl('http://localhost/assets/planning-worker.js') });
              await import('@/features/transformers-js/model-support-investigation/worker/entry');
              startupStages.push('planning-imported');
              break;
            case 'production': {
              vi.stubGlobal('self', nativeSelf); vi.stubGlobal('fetch', originalFetch);
              const { createProductionRuntimeModuleRequester, startProductionWorkerRuntime } = await import('@/features/transformers-js/worker/production-worker-startup');
              await startProductionWorkerRuntime({ loadEntry: async () => {
                const entry = await import('@/features/transformers-js/worker/entry');
                const { requestRuntimeModule } = createProductionRuntimeModuleRequester({ endpoint: worker.startupEndpoint });
                return entry.initializeProductionWorkerRuntime({ requestRuntimeModule });
              }, postMessage: ({ message }) => worker.sendFromWorker({ message }) });
              break;
            }
            case 'evidence': await import('@/features/transformers-js/model-support-investigation/evidence-worker/entry'); break;
            case 'fresh-metadata':
              vi.stubGlobal('self', { fetch: planningFetch, location: new NodeUrl('http://localhost/assets/fresh-metadata-worker.js') });
              await import('@/features/transformers-js/model-support-investigation/fresh-metadata-worker/entry');
              break;
            case 'request-observer':
              vi.stubGlobal('self', { fetch: planningFetch, location: new NodeUrl('http://localhost/assets/request-observer-worker.js') });
              await import('@/features/transformers-js/download-verification/model-artifact-request-worker/entry');
              break;
            default: { const exhaustive: never = kind; throw new Error('Unexpected Worker: ' + exhaustive); }
            }
          } });
          this.kind = kind; workers.push(this);
          this.addEventListener('error', event => startupErrors.push((event as MessageEvent).data));
        }
      });
      vi.resetModules();
      const { ensureAllStringsForTest } = await import('@/strings/test-utils');
      await ensureAllStringsForTest({ locale: 'en' });
      const { lazyStrings } = await import('@/strings');
      const { createInvestigationSessionView, recallInvestigationSession, TEST_ONLY } = await import('@/features/transformers-js/model-support-investigation/logic/investigation-session');
      TEST_ONLY.clear();
      const { configurationForPreset } = await import('@/features/transformers-js/model-support-investigation/logic/investigation-config');
      const { default: Session } = await import('./ModelSupportInvestigationSession.vue');
      const view = createInvestigationSessionView({ initialSnapshot: { view: 'setup', batchId: 'full-collection', targets: models.map(model => model.modelId), configuration: configurationForPreset({ preset }) } });
      wrapper = mount(Session, { props: { modelId: '', sessionView: view } });
      await wrapper.vm.$nextTick();
      await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
      const results = () => {
        if (startupErrors.length > 0) throw startupErrors[0];
        const snapshot = recallInvestigationSession({ seededTarget: first.modelId });
        if (snapshot?.view !== 'results') throw new Error('Missing retained Full results: ' + JSON.stringify({ startupStages, operation: wrapper?.find('[data-testid="model-support-current-operation"]').text(), workers: workers.map(worker => ({ kind: worker.kind, terminated: worker.terminated, sent: worker.hostMessages.length, received: worker.workerMessages.length })) }));
        return snapshot;
      };
      await vi.waitFor(() => expect(results().executions.every(item => item.status !== 'running' && item.status !== 'pending')).toBe(true), { timeout: 60_000 });
      const snapshot = results();
      expect(snapshot.executions.map(item => item.status), JSON.stringify({ failures: snapshot.executions.map(item => item.error), unknownHttp: http.unknown, steps: snapshot.runs.map(([, run]) => run.steps.filter(step => step.status === 'failed')) })).toEqual([expectedFirst.status, 'passed']);
      expect(workers.filter(worker => worker.kind === 'planning' || worker.kind === 'production').map(worker => worker.kind)).toEqual(['planning', 'production', 'planning', 'production']);
      expect(workers.filter(worker => worker.kind === 'fresh-metadata')).toHaveLength(preset === 'full' ? 2 : 0);
      expect(workers.filter(worker => worker.kind === 'request-observer')).toHaveLength(preset === 'full' ? 6 : 0);
      expect(workers.every(worker => worker.terminated)).toBe(true);
      expect(new Set(workerRuntimes.map(item => item.runtime)).size).toBe(workerRuntimes.length);
      expect(new Set(workerRuntimes.map(item => item.runtime.Tensor)).size).toBe(workerRuntimes.length);
      expect(workerRuntimes.filter(item => item.kind === 'production')).toHaveLength(2);
      expect(workers.filter(worker => worker.kind === 'production').map(worker => worker.hostMessages.filter(message => productionLoadEnvelope.safeParse(message).success).length)).toEqual([1, 1]);
      expect(workerRuntimes.filter(item => item.kind === 'production').map(item => item.inferenceCalls)).toEqual([expectedFirst.nativeCalls, 13]);
      expect(inferenceCalls).toBe(expectedFirst.nativeCalls + 13);
      expect(snapshot.nativeEvidence.map(([, sidecar]) => sidecar.summary.recording)).toEqual([expectedFirst.recording, 'recorded']);
      for (const [, run] of snapshot.runs) {
        expect.soft(run.steps.filter(step => step.status === 'running'), `Terminal steps for ${run.modelId}`).toEqual([]);
        await wrapper.get(`[data-testid="model-support-target-${run.modelId}"]`).trigger('click');
        for (const step of run.steps) {
          const row = wrapper.get(`[data-testid="model-support-step-${step.id}"]`);
          expect.soft(row.text(), `Terminal UI step ${run.modelId}/${step.id}`).not.toContain(lazyStrings.ModelSupportInvestigationModal__running());
          if (step.detail !== undefined) expect(row.text()).toContain(step.detail);
        }
        expect(run.productionProviderCapture?.requests).toHaveLength(13);
        const expected = run.modelId === first.modelId ? expectedFirst : { fulfilled: 13, rejected: 0, notStarted: 0 };
        const requests = run.productionProviderInvestigation?.requests;
        expect(requests?.filter(request => request.outcome === 'fulfilled')).toHaveLength(expected.fulfilled);
        expect(requests?.filter(request => request.outcome === 'rejected')).toHaveLength(expected.rejected);
        expect(requests?.filter(request => request.status === 'not-started')).toHaveLength(expected.notStarted);
        const sidecar = snapshot.nativeEvidence.find(([target]) => target === run.modelId)?.[1];
        expect(sidecar).toBeDefined();
        const nativeIndex = nativeLoadIndexSchema.parse(JSON.parse(sidecar!.json));
        expect(nativeIndex.runId).toBe(run.runId);
        expect(nativeIndex.epochs).toHaveLength(1);
        const epoch = nativeIndex.epochs[0]!;
        const observation = epoch.collection.result.loadObservation;
        expect(epoch.workerEpoch).toBe(1);
        expect(observation.owner).toEqual({ runId: run.runId, workerEpoch: 1 });
        expect(observation.loadOrdinal).toBe(1);
        const missingCache = firstTarget === 'missing-cache' && run.modelId === first.modelId;
        if (missingCache) {
          expect(epoch.collection.result.status).toBe('not-started');
          expect(observation.outcome).toEqual({ status: 'failed' });
        } else {
          expect(epoch.collection.result.status).toBe('captured');
          if (observation.outcome.status !== 'accepted') throw new Error('Expected the actual successful offline Load receipt');
          const model = models.find(model => model.modelId === run.modelId)!;
          const receipt = observation.outcome.receipt;
          expect(receipt).toMatchObject({
            modelId: model.modelId, loaderRevisionOption: { status: 'provided', value: model.revision },
            cacheLookup: { source: 'read-only-opfs-scoped-match', revision: model.revision },
            candidate: { device: 'webgpu', dtype: 'q4f16' },
            autoClass: 'AutoModelForCausalLM', processor: 'qwen3_5-processor',
            completion: 'model-session-and-tokenizer-processor-ready', resourceHealth: 'healthy-after-close',
            accessBoundary: 'production-offline-read-only',
            limitations: { wholeFileProvenance: 'not-verified', allPlannedBodiesConsumed: 'not-certified' },
          });
          // Seeded vision artifacts are not proof that the selected CausalLM
          // class planned or loaded a vision encoder. Match that class's plan.
          expect(receipt.plannedRequiredPaths.filter(path => path.startsWith('onnx/')).sort()).toEqual([
            'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
            'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data', ...model.extraShards,
          ].sort());
          expect(receipt.cacheLookup.hitPaths).toEqual(expect.arrayContaining(receipt.plannedRequiredPaths));
        }
        if (preset === 'full') {
          expect(run.repository?.resolvedRevision).toBe(firstTarget === 'different-revision' && run.modelId === first.modelId
            ? 'a'.repeat(40) : models.find(model => model.modelId === run.modelId)!.revision);
          expect(run.freshMetadata?.status).toBe('prepared');
          expect.soft(run.steps.find(step => step.id === 'download-evidence')?.status).toBe('passed');
          expect.soft(run.steps.find(step => step.id === 'download-evidence')?.detail).not.toContain('acceptance is pending');
          expect(run.downloadEvidence?.mode).toBe('runtime-complete');
          const completion = run.downloadEvidence?.runtimeCompletion;
          expect(completion?.source).toBe('ordinary-provider-load');
          expect(completion?.status).toBe(missingCache ? 'failed' : 'accepted');
          expect(completion?.receipt).toEqual(observation.outcome.status === 'accepted' ? observation.outcome.receipt : undefined);
          expect(completion?.cacheReuse).toBeUndefined();
          expect(completion?.preparation).toBeUndefined();
          expect(completion?.cacheAfter).toBeUndefined();
          expect(run.downloadEvidence?.modelArtifactObservationError).toBeUndefined();
          expect(run.downloadEvidence?.modelArtifactObservations).toHaveLength(3);
          for (const observation of run.downloadEvidence!.modelArtifactObservations) {
            expect(observation.status, observation.error?.message).toBe('observed');
            expect(observation.paths.length).toBeGreaterThan(0);
            expect(observation.requests.length).toBeGreaterThan(0);
          }
        }
      }
      const exported: Blob[] = [];
      const collectionWorkerCount = workers.length;
      vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
        exported.push(blob as Blob); return 'blob:full-export';
      });
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
      vi.useFakeTimers({ toFake: ['Date'] });
      for (let ordinal = 1; ordinal <= 2; ordinal++) {
        vi.setSystemTime(new Date(`2026-09-${ordinal === 1 ? '10' : '11'}T12:00:00.000Z`));
        await wrapper.get('[data-testid="model-support-investigation-download"]').trigger('click');
        await vi.waitFor(() => expect(exported, wrapper?.find('[data-testid="model-support-current-operation"]').text()).toHaveLength(ordinal), { timeout: 30_000 });
      }
      vi.useRealTimers();
      const archives = await Promise.all(exported.map(async blob => JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()), { checkCRC32: true })));
      const paths = Object.keys(archives[0]!.files).filter(path => !archives[0]!.files[path]!.dir).sort();
      expect(Object.keys(archives[1]!.files).filter(path => !archives[1]!.files[path]!.dir).sort()).toEqual(paths);
      // A new export has a new batch timestamp; every captured model dossier,
      // including Provider/native JSON and binaries, remains byte-identical.
      for (const path of paths.filter(path => path.startsWith('models/'))) {
        const firstBytes = await archives[0]!.file(path)!.async('uint8array');
        const secondBytes = await archives[1]!.file(path)!.async('uint8array');
        // Exact native byte comparison avoids walking millions of tensor byte
        // indices through assertion-library object equality.
        expect(Buffer.from(secondBytes).equals(Buffer.from(firstBytes)), path).toBe(true);
      }
      const indexSchema = z.object({ generatedAt: z.string(), batchId: z.string(), targets: z.array(z.object({ runId: z.string(), status: z.enum(['passed', 'failed']) }).passthrough()) }).passthrough();
      const indexes = await Promise.all(archives.map(async archive => indexSchema.parse(JSON.parse(await archive.file('batch.json')!.async('string')))));
      const runStepsSchema = z.object({ runId: z.string(), steps: z.array(z.object({
        id: z.string(), status: z.enum(['not-run', 'running', 'passed', 'failed', 'blocked', 'skipped']), detail: z.string().optional(),
      })) });
      for (const archive of archives) {
        for (const path of paths.filter(path => path.endsWith('/run.json'))) {
          const archived = runStepsSchema.parse(JSON.parse(await archive.file(path)!.async('string')));
          const retained = snapshot.runs.find(([, run]) => run.runId === archived.runId)?.[1];
          expect(retained).toBeDefined();
          // Export itself advances from not-run to passed in the new snapshot;
          // collection steps must remain exactly the retained UI/run evidence.
          expect(archived.steps.filter(step => step.id !== 'evidence-export')).toEqual(retained!.steps.filter(step => step.id !== 'evidence-export'));
          expect(archived.steps.find(step => step.id === 'evidence-export')?.status).toBe('passed');
          expect.soft(archived.steps.filter(step => step.status === 'running'), `Terminal ZIP steps: ${path}`).toEqual([]);
          if (preset === 'full') {
            const acceptancePath = path.slice(0, -'run.json'.length) + 'download-lane/cache-acceptance.json';
            const acceptance = archivedAcceptanceSchema.parse(JSON.parse(await archive.file(acceptancePath)!.async('string')));
            const completion = retained!.downloadEvidence!.runtimeCompletion!;
            expect(acceptance).toMatchObject({
              status: completion.status, source: 'ordinary-provider-load', repositoryResolvedRevision: retained!.repository!.resolvedRevision,
              cacheRevision: completion.cacheRevision, loaderRevisionOption: completion.loaderRevisionOption, receipt: completion.receipt ?? null,
            });
            const firstRun = retained!.modelId === first.modelId;
            expect(acceptance.revisionIdentity).toBe(firstRun && firstTarget === 'missing-cache' ? null
              : firstRun && firstTarget === 'different-revision' ? 'unverified' : 'exact-resolved-revision');
            const readinessPath = path.slice(0, -'run.json'.length) + 'download-lane/test-readiness.json';
            const readiness = z.object({ domains: z.array(z.object({ domain: z.string(), status: z.string() })) })
              .parse(JSON.parse(await archive.file(readinessPath)!.async('string')));
            expect(readiness.domains.find(domain => domain.domain === 'runtime-acceptance')?.status).toBe(firstRun && firstTarget === 'missing-cache' ? 'insufficient'
              : firstRun && firstTarget === 'different-revision' ? 'partial' : 'implementation-ready');
          }
        }
      }
      expect(indexes.map(index => index.generatedAt.slice(0, 10))).toEqual(['2026-09-10', '2026-09-11']);
      expect(indexes[1]!.targets).toEqual(indexes[0]!.targets);
      expect(indexes[0]!.targets.map(target => target.status)).toEqual([expectedFirst.status, 'passed']);
      expect(indexes[0]!.targets.map(target => target.runId)).toEqual(snapshot.runs.map(([, run]) => run.runId));
      expect(workers.slice(collectionWorkerCount).map(worker => worker.kind)).toEqual(['evidence', 'evidence']);
      expect(workers.every(worker => worker.terminated)).toBe(true);
      expect(workers.filter(worker => worker.kind === 'production').map(worker => worker.hostMessages.filter(message => productionLoadEnvelope.safeParse(message).success).length)).toEqual([1, 1]);
      expect(inferenceCalls).toBe(expectedFirst.nativeCalls + 13);
      expect(paths.filter(path => path.endsWith('generation-native/capture.json'))).toHaveLength(2);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(http.unknown).toEqual([]);
      expect(http.requests.some(request => request.url.startsWith('https://huggingface.co/'))).toBe(preset === 'full');
      expect(fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      wrapper?.unmount();
      for (const worker of workers) worker.terminate();
      await harness.close();
    }
  }, 120_000);
});
