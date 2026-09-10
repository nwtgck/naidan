import { Blob as NodeBlob } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { URL as NodeUrl } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import JSZip from 'jszip';
import { z } from 'zod';
import * as transport from '@/utils/worker-transport';
import type { WorkerServerApi } from '@/utils/worker-transport';
import { ProductionReplayTestWorker } from '@/features/transformers-js/production-replay-test-transport';
import { createMemoryFiles } from '@/features/transformers-js/download-verification/fixtures/raw-download-replay/memory-files';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { lazyStrings } from '@/strings';
import type { IModelSupportInvestigationWorker } from '@/features/transformers-js/model-support-investigation/types';
import { createModelSupportInvestigationEvidenceWorker } from '@/features/transformers-js/model-support-investigation/evidence-worker/impl';
import { configurationForPreset } from '@/features/transformers-js/model-support-investigation/logic/investigation-config';
import { createInvestigationSessionView, recallInvestigationSession, TEST_ONLY as sessions } from '@/features/transformers-js/model-support-investigation/logic/investigation-session';
import Session from './ModelSupportInvestigationSession.vue';
import { DOWNLOAD_INVESTIGATION_COLLECTION_BUDGET_MS } from '@/features/transformers-js/model-support-investigation/logic/investigation-batch-budget';

const observed = vi.hoisted(() => ({
  planningApi: undefined as WorkerServerApi<IModelSupportInvestigationWorker> | undefined,
  runtimeFetch: vi.fn<typeof fetch>(async () => {
    throw new Error('Unprovided fixture HTTP request');
  }),
}));

// Only supplies the browser Worker-global endpoint. Actual Comlink schemas,
// callback ports, entry, preflight, host, Session and batch runner remain real.
vi.mock('@/utils/worker-transport', async importOriginal => {
  const original = await importOriginal<typeof transport>();
  return { ...original, exposeWorkerRemote: ({ api, endpoint }: {
    api: WorkerServerApi<IModelSupportInvestigationWorker>;
    endpoint: Parameters<typeof transport.exposeWorkerRemote>[0]['endpoint'];
  }) => {
    if (endpoint === undefined) observed.planningApi = api;
    else original.exposeWorkerRemote({ api, endpoint });
  } };
});
// Deliberate preflight failure: this suite proves startup/failure ownership,
// never successful runtime initialization or a complete Full generation run.
vi.mock('@/features/transformers-js/runtime/configure-hosted-runtime', () => ({
  isModelWeightFileName: ({ fileName }: { fileName: string }) => /\.(?:onnx|data)$/iu.test(fileName) || fileName.includes('_data'),
  configureHostedTransformersRuntime: () => ({
    assets: { variant: 'asyncify', baseUrl: 'https://fixture.invalid/', mjsUrl: 'https://fixture.invalid/ort.mjs', wasmUrl: 'https://fixture.invalid/ort.wasm', physicalWasmUrl: 'https://fixture.invalid/ort.wasm.gz', wasmTransport: 'gzip-worker-decompression' },
    runtimeFetch: observed.runtimeFetch,
  }),
}));
vi.mock('@huggingface/transformers', () => {
  const model = { supports: () => true, from_pretrained: () => {
    throw new Error('Unexpected heavyweight inference');
  } };
  return {
    AutoModel: model, AutoModelForAudioTextToText: model, AutoModelForCausalLM: model,
    AutoModelForImageTextToText: model, AutoModelForSeq2SeqLM: model,
    AutoModelForSpeechSeq2Seq: model, AutoModelForVision2Seq: model, AutoTokenizer: model,
    ModelRegistry: {}, PretrainedConfig: class {}, Tensor: class {}, TextStreamer: class {},
    LogitsProcessor: class {}, LogitsProcessorList: class {}, env: { backends: { onnx: { wasm: {} } } },
  };
});
vi.mock('onnxruntime-web', () => ({ InferenceSession: { create: () => {
  throw new Error('Unexpected native inference');
} }, Tensor: class {} }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: vi.fn() }) }));

const workers: InvestigationTestWorker[] = [];
const preflightOriginFailure = 'ONNX Runtime assets are not configured for the Naidan origin';
const userInterruptionMessage = 'Model Support Investigation was stopped by the user';
const batchOutcomeSchema = z.object({
  targetCount: z.number(), packagedModelCount: z.number(),
  targets: z.array(z.object({
    target: z.string(), status: z.enum(['pending', 'running', 'passed', 'failed', 'skipped', 'interrupted']),
    runId: z.string().optional(), error: z.string().optional(), evidencePath: z.string().optional(),
  })),
});
const archivedRunOutcomeSchema = z.object({
  runId: z.string(), modelId: z.string(), status: z.enum(['passed', 'failed']), error: z.string().optional(),
});
const archivedRecoveryOutcomeSchema = z.object({
  status: z.enum(['running', 'completed', 'interrupted']),
  interruption: z.object({ error: z.object({ name: z.string(), message: z.string() }) }).optional(),
});
let firstRequestIdentity: 'original' | 'foreign';
const planningRequestEnvelope = z.object({ type: z.literal('APPLY'), path: z.tuple([z.literal('runPartialInvestigation')]), argumentList: z.array(z.unknown()) }).passthrough();

class InvestigationTestWorker extends ProductionReplayTestWorker {
  readonly kind: 'planning' | 'evidence';
  // Implements the browser Worker constructor.
  constructor(url: string | URL, options: WorkerOptions | undefined) {
    const pathname = new NodeUrl(String(url)).pathname;
    const kind = pathname.endsWith('/model-support-investigation/worker/entry.ts') ? 'planning'
      : pathname.endsWith('/model-support-investigation/evidence-worker/entry.ts') ? 'evidence' : undefined;
    if (kind === undefined) throw new Error(`Unexpected Worker entry: ${pathname}`);
    expect(options?.type).toBe('module');
    super({ start: async ({ worker }) => {
      switch (kind) {
      case 'planning':
        if (observed.planningApi === undefined) throw new Error('Real planning entry was not loaded');
        transport.exposeWorkerRemote({ api: observed.planningApi, endpoint: worker.endpoint });
        break;
      case 'evidence': transport.exposeWorkerRemote({ api: createModelSupportInvestigationEvidenceWorker(), endpoint: worker.endpoint }); break;
      default: { const exhaustive: never = kind; throw new Error('Unexpected Worker kind: ' + exhaustive); }
      }
    } });
    this.kind = kind;
    workers.push(this);
  }

  // Browser Worker positional platform boundary.
  override postMessage(message: unknown, transfer: Parameters<MessagePort['postMessage']>[1]) {
    const parsed = planningRequestEnvelope.safeParse(message);
    if (firstRequestIdentity === 'foreign' && parsed.success && workers.filter(worker => worker.kind === 'planning')[0] === this) {
      // A transport fault supplies a valid but wrong identity. Every production
      // checkpoint codec and Session identity guard must still reject it.
      const argument = z.object({ type: z.literal('RAW'), value: z.object({ runId: z.string() }).passthrough() }).passthrough().parse(parsed.data.argumentList[0]);
      super.postMessage({ ...parsed.data, argumentList: [{ ...argument, value: { ...argument.value, runId: 'foreign-run' } }, ...parsed.data.argumentList.slice(1)] }, transfer);
      return;
    }
    super.postMessage(message, transfer);
  }
}

let wrapper: VueWrapper | undefined;
let files: ReturnType<typeof createMemoryFiles>;
let exported: Blob[];
let adapter: ReturnType<typeof vi.fn<() => Promise<{ features: string[]; limits: object }>>>;

beforeEach(async () => {
  sessions.clear(); workers.length = 0; firstRequestIdentity = 'original'; exported = [];
  observed.runtimeFetch.mockClear();
  files = createMemoryFiles(); files.enter({ nextPhase: 'investigation', mutationPolicy: 'read-only' });
  adapter = vi.fn(async () => ({ features: [], limits: {} }));
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('MessageChannel', MessageChannel); vi.stubGlobal('Worker', InvestigationTestWorker);
  vi.stubGlobal('self', { fetch: observed.runtimeFetch, location: new NodeUrl('https://naidan.example/investigation-worker.js') });
  vi.stubGlobal('navigator', { userAgent: 'Vitest', vendor: '', gpu: { requestAdapter: adapter }, storage: { getDirectory: async () => files.root } });
  vi.stubGlobal('fetch', observed.runtimeFetch);
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
    exported.push(blob as Blob); return 'blob:fixture-export';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  await ensureAllStringsForTest({ locale: 'en' });
  await import('@/features/transformers-js/model-support-investigation/worker/entry');
});

afterEach(async () => {
  wrapper?.unmount(); wrapper = undefined;
  await vi.waitFor(() => expect(sessions.retiringViewCount()).toBe(0));
  for (const worker of workers) worker.terminate();
  expect(files.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); sessions.clear();
  vi.useRealTimers();
});

async function startBatch() {
  const configuration = configurationForPreset({ preset: 'download-focused' });
  configuration.externalNetworkPolicy = 'deny';
  const targets = ['fixture/first', 'fixture/second'];
  const view = createInvestigationSessionView({ initialSnapshot: { view: 'setup', batchId: 'public-startup-control', targets, configuration } });
  wrapper = mount(Session, { props: { modelId: '', sessionView: view } });
  await wrapper.vm.$nextTick();
  await wrapper.get('[data-testid="model-support-investigation-start"]').trigger('click');
  return wrapper;
}

function retainedResults() {
  const snapshot = recallInvestigationSession({ seededTarget: 'fixture/first' });
  if (snapshot?.view !== 'results') throw new Error('Expected retained batch results');
  return snapshot;
}

async function finishBatch() {
  await vi.waitFor(() => expect(retainedResults().executions.every(item => item.status !== 'running' && item.status !== 'pending')).toBe(true));
  return retainedResults();
}

async function exportBatch() {
  if (wrapper === undefined) throw new Error('Missing mounted Session');
  const retained = retainedResults();
  for (const [, run] of retained.runs) {
    expect.soft(run.steps.filter(step => step.status === 'running'), `Terminal steps for ${run.modelId}`).toEqual([]);
    await wrapper.get(`[data-testid="model-support-target-${run.modelId}"]`).trigger('click');
    for (const step of run.steps) {
      const row = wrapper.get(`[data-testid="model-support-step-${step.id}"]`);
      expect.soft(row.text(), `Terminal UI step ${run.modelId}/${step.id}`).not.toContain(lazyStrings.ModelSupportInvestigationModal__running());
      if (step.detail !== undefined) expect(row.text()).toContain(step.detail);
    }
  }
  await wrapper.get('[data-testid="model-support-investigation-download"]').trigger('click');
  await vi.waitFor(() => expect(exported).toHaveLength(1));
  const zip = await JSZip.loadAsync(new Uint8Array(await exported[0]!.arrayBuffer()));
  const schema = z.object({ runId: z.string(), steps: z.array(z.object({
    id: z.string(), status: z.enum(['not-run', 'running', 'passed', 'failed', 'blocked', 'skipped']), detail: z.string().optional(),
  })) });
  for (const path of Object.keys(zip.files).filter(path => path.endsWith('/run.json'))) {
    const archived = await readArchivedJson({ zip, path, schema });
    const run = retained.runs.find(([, candidate]) => candidate.runId === archived.runId)?.[1];
    expect(run).toBeDefined();
    // Creating this snapshot legitimately completes only the export step.
    expect(archived.steps.filter(step => step.id !== 'evidence-export')).toEqual(run!.steps.filter(step => step.id !== 'evidence-export'));
    expect(archived.steps.find(step => step.id === 'evidence-export')?.status).toBe('passed');
    expect.soft(archived.steps.filter(step => step.status === 'running'), `Terminal ZIP steps: ${path}`).toEqual([]);
  }
  return zip;
}

async function readArchivedJson<Schema extends z.ZodType>({ zip, path, schema }: {
  zip: JSZip, path: string, schema: Schema,
}): Promise<z.output<Schema>> {
  const file = zip.file(path);
  if (file === null) throw new Error(`Missing archived outcome: ${path}`);
  const value: unknown = JSON.parse(await file.async('string'));
  return schema.parse(value);
}

async function readArchivedTarget({ zip, target }: {
  zip: JSZip, target: z.infer<typeof batchOutcomeSchema>['targets'][number],
}) {
  if (target.evidencePath === undefined) throw new Error(`Missing target dossier: ${target.target}`);
  const run = await readArchivedJson({ zip, path: `${target.evidencePath}run.json`, schema: archivedRunOutcomeSchema });
  const recovery = await readArchivedJson({ zip, path: `${target.evidencePath}recovery/checkpoint.json`, schema: archivedRecoveryOutcomeSchema });
  expect(run.runId).toBe(target.runId);
  expect(run.modelId).toBe(target.target);
  return { run, recovery };
}

function firstPlanningIdentity() {
  // This is the host identity already published before the actual planning RPC.
  // Retained Session snapshots are only committed after the target settles.
  const first = workers.find(worker => worker.kind === 'planning');
  const request = first?.hostMessages.map(message => planningRequestEnvelope.safeParse(message)).find(result => result.success);
  if (request?.success !== true) throw new Error('Missing actual first-target planning RPC');
  const argument = z.object({ type: z.literal('RAW'), value: z.object({ runId: z.string(), modelId: z.string() }) }).parse(request.data.argumentList[0]);
  expect(argument.value.modelId).toBe('fixture/first');
  return argument.value;
}

describe('real Session, planning Worker communication and Evidence export', () => {
  it('keeps a target deadline distinct from user stop and rejects the timed-out Worker response', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = Promise.withResolvers<{ features: string[]; limits: object }>();
    adapter.mockImplementationOnce(() => pending.promise);
    try {
      const mounted = await startBatch();
      await vi.waitFor(() => expect(adapter).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(mounted.get('[data-testid="model-support-current-operation"]').text()).toContain('environment'));
      const accepted = firstPlanningIdentity();
      await vi.advanceTimersByTimeAsync(DOWNLOAD_INVESTIGATION_COLLECTION_BUDGET_MS / 2);
      const snapshot = await finishBatch();
      expect(snapshot.executions[0]?.error).toContain('batch time allocation');
      expect(snapshot.executions[0]?.error).not.toContain('stopped by the user');
      expect(snapshot.executions.map(item => item.status)).toEqual(['failed', 'failed']);
      expect(workers.filter(worker => worker.kind === 'planning')).toHaveLength(2);
      pending.resolve({ features: ['late-deadline-feature'], limits: {} });
      await pending.promise;
      const zip = await exportBatch();
      const batch = await readArchivedJson({ zip, path: 'batch.json', schema: batchOutcomeSchema });
      const deadlineError = snapshot.executions[0]?.error;
      expect(deadlineError).toMatch(/^Download investigation target exceeded its \d+ ms batch time allocation; partial evidence was retained$/u);
      const secondRun = new Map(snapshot.runs).get('fixture/second');
      expect(secondRun?.error).toContain(preflightOriginFailure);
      expect(secondRun?.error).not.toContain('batch time allocation');
      expect(batch.targetCount).toBe(2);
      expect(batch.packagedModelCount).toBe(2);
      expect(batch.targets.map(({ target, status, runId, error }) => ({ target, status, runId, error }))).toEqual([
        { target: 'fixture/first', status: 'failed', runId: accepted.runId, error: deadlineError },
        { target: 'fixture/second', status: 'failed', runId: secondRun?.runId, error: secondRun?.error },
      ]);
      const firstDossier = await readArchivedTarget({ zip, target: batch.targets[0]! });
      expect(firstDossier).toEqual({
        run: { runId: accepted.runId, modelId: 'fixture/first', status: 'failed', error: `${preflightOriginFailure}; Investigation interrupted: ${deadlineError}` },
        recovery: { status: 'interrupted', interruption: { error: { name: 'InvestigationTargetBudgetError', message: deadlineError } } },
      });
      const secondDossier = await readArchivedTarget({ zip, target: batch.targets[1]! });
      expect(secondDossier.run).toEqual({ runId: secondRun?.runId, modelId: 'fixture/second', status: 'failed', error: secondRun?.error });
      expect(secondDossier.recovery).toEqual({ status: 'completed' });
      expect(firstDossier.run.runId).not.toBe(secondDossier.run.runId);
      expect(JSON.stringify(retainedResults().executions)).toBe(JSON.stringify(snapshot.executions));
      expect(JSON.stringify(retainedResults())).not.toContain('late-deadline-feature');
    } finally {
      pending.resolve({ features: [], limits: {} });
    }
  });

  it('retains the actual preflight failure, starts the next target and exports both runs', async () => {
    await startBatch();
    const snapshot = await finishBatch();
    expect(snapshot.executions.map(item => item.status)).toEqual(['failed', 'failed']);
    expect(new Set(snapshot.runs.map(([, run]) => run.runId)).size).toBe(2);
    for (const [, run] of snapshot.runs) {
      expect(run.error).toContain('ONNX Runtime assets are not configured for the Naidan origin');
      expect(run.error).not.toContain('stopped by the user');
      expect(run.runtimeAssetsPartial?.stageObservations[0]?.stage).toBe('origin-validation');
    }
    expect(workers.filter(worker => worker.kind === 'planning')).toHaveLength(2);
    expect(workers.every(worker => worker.terminated)).toBe(true);
    const zip = await exportBatch();
    const summaries = await Promise.all(Object.keys(zip.files).filter(path => path.endsWith('run.json')).map(path => zip.file(path)!.async('string')));
    expect(summaries).toHaveLength(2);
    for (const [, run] of snapshot.runs) expect(summaries.some(json => json.includes(run.runId))).toBe(true);
    expect(summaries.join('')).not.toContain('stopped by the user');
  });

  it('preserves an internal identity failure and still runs the next target', async () => {
    firstRequestIdentity = 'foreign';
    await startBatch();
    const snapshot = await finishBatch();
    expect(snapshot.executions.map(item => item.status)).toEqual(['failed', 'failed']);
    expect(snapshot.executions[0]?.error).toContain('identity');
    expect(snapshot.executions[0]?.error).not.toContain('stopped by the user');
    expect(snapshot.runs[0]?.[1].runId).not.toBe('foreign-run');
    const zip = await exportBatch();
    const jsons = await Promise.all(Object.keys(zip.files).filter(path => path.endsWith('.json')).map(path => zip.file(path)!.async('string')));
    expect(jsons.join('')).toContain(snapshot.executions[0]!.error!);
    expect(jsons.join('')).not.toContain('stopped by the user');
  });

  it.each(['stop', 'skip'] as const)('honors an actual %s during a pending browser request and rejects its late completion', async action => {
    const pending = Promise.withResolvers<{ features: string[]; limits: object }>();
    adapter.mockImplementationOnce(() => pending.promise);
    try {
      const mounted = await startBatch();
      await vi.waitFor(() => expect(adapter).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(mounted.get('[data-testid="model-support-current-operation"]').text()).toContain('environment'));
      const accepted = firstPlanningIdentity();
      await mounted.get(`[data-testid="model-support-investigation-${action === 'stop' ? 'stop' : 'skip-current'}"]`).trigger('click');
      await vi.waitFor(() => expect(retainedResults().executions[0]?.status).toBe(action === 'stop' ? 'interrupted' : 'skipped'));
      if (action === 'skip') await finishBatch();
      const cutoff = retainedResults();
      expect(cutoff.executions[1]?.status).toBe(action === 'stop' ? 'pending' : 'failed');
      expect(workers.filter(worker => worker.kind === 'planning')).toHaveLength(action === 'stop' ? 1 : 2);
      expect(workers.every(worker => worker.terminated)).toBe(true);
      pending.resolve({ features: ['late-fixture-feature'], limits: {} });
      // The test platform cannot kill a JS Realm. Real termination closes every
      // MessagePort, so later completion cannot re-enter the retired Session.
      await pending.promise;
      const zip = await exportBatch();
      const batch = await readArchivedJson({ zip, path: 'batch.json', schema: batchOutcomeSchema });
      const secondRun = new Map(cutoff.runs).get('fixture/second');
      expect(batch.targetCount).toBe(2);
      expect(batch.packagedModelCount).toBe(action === 'stop' ? 1 : 2);
      expect(batch.targets.map(({ target, status, runId, error }) => ({ target, status, runId, error }))).toEqual([
        { target: 'fixture/first', status: action === 'stop' ? 'interrupted' : 'skipped', runId: accepted.runId, error: userInterruptionMessage },
        { target: 'fixture/second', status: action === 'stop' ? 'pending' : 'failed', runId: secondRun?.runId, error: secondRun?.error },
      ]);
      const firstDossier = await readArchivedTarget({ zip, target: batch.targets[0]! });
      expect(firstDossier).toEqual({
        run: { runId: accepted.runId, modelId: 'fixture/first', status: 'failed', error: `${preflightOriginFailure}; Investigation interrupted: ${userInterruptionMessage}` },
        recovery: { status: 'interrupted', interruption: { error: { name: 'ModelSupportInvestigationUserInterruptedError', message: userInterruptionMessage } } },
      });
      switch (action) {
      case 'stop':
        expect(secondRun).toBeUndefined();
        expect(batch.targets[1]?.evidencePath).toBeUndefined();
        expect(Object.keys(zip.files).filter(path => path.endsWith('/run.json'))).toHaveLength(1);
        break;
      case 'skip': {
        expect(secondRun?.error).toContain(preflightOriginFailure);
        expect(secondRun?.error).not.toContain(userInterruptionMessage);
        const secondDossier = await readArchivedTarget({ zip, target: batch.targets[1]! });
        expect(secondDossier.run).toEqual({ runId: secondRun?.runId, modelId: 'fixture/second', status: 'failed', error: secondRun?.error });
        expect(secondDossier.recovery).toEqual({ status: 'completed' });
        expect(firstDossier.run.runId).not.toBe(secondDossier.run.runId);
        break;
      }
      default: { const exhaustive: never = action; throw new Error('Unexpected user action: ' + exhaustive); }
      }
      expect(JSON.stringify(retainedResults().executions)).toBe(JSON.stringify(cutoff.executions));
      expect(JSON.stringify(retainedResults())).not.toContain('late-fixture-feature');
    } finally {
      pending.resolve({ features: [], limits: {} });
    }
  });
});
