import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProductionRuntimeStartupFixture, installProductionRuntimeStartupPlatform } from '@/features/transformers-js/runtime/fixtures/production-runtime-startup-fixture';
import { PRODUCTION_WORKER_READY } from '@/features/transformers-js/worker/production-worker-startup';
import { configurationForPreset, createDefaultInvestigationConfiguration } from '@/features/transformers-js/model-support-investigation/logic/investigation-config';
import type { RuntimeAcceptanceProgressCallback } from '@/features/transformers-js/download-verification/logic/runtime-acceptance-progress';
import { runInvestigationTargetsSequentially } from '@/features/transformers-js/model-support-investigation/logic/run-investigation-targets-sequentially';
import { createMemoryFiles } from '@/features/transformers-js/replay-models/support/download-memory-files';
import type {
  IModelSupportInvestigationWorker,
  ModelSupportInvestigationLoadAttempt,
  ModelSupportInvestigationLoadAttemptCheckpoint,
  ModelSupportInvestigationPlanningWorkerRun,
  ModelSupportInvestigationRun,
} from "@/features/transformers-js/model-support-investigation/types";
import { toPlanningWorkerRun } from "@/features/transformers-js/model-support-investigation/logic/planning-worker-run";
import { FRESH_METADATA_TIMEOUT_MS, type FreshMetadataResult, type FreshMetadataSummary, type FreshMetadataWorker } from '@/features/transformers-js/model-support-investigation/fresh-metadata-worker/types';
import type { WorkerServerApi } from '@/utils/worker-transport';
import type {
  ITransformersJsWorker,
} from "@/features/transformers-js/types";

const mocks = vi.hoisted(() => ({
  releaseProxy: Symbol("releaseProxy"),
  proxy: vi.fn((value: unknown) => value),
  wrap: vi.fn(),
  workerInstances: [] as Array<{ terminate: ReturnType<typeof vi.fn>, dispatchEvent: EventTarget['dispatchEvent'], startup: ReturnType<typeof createProductionRuntimeStartupFixture> }>,
  productionAutoReady: true,
  runProductionScenario: vi.fn(),
  completeRuntimeEvidence: vi.fn(),
}));

vi.mock("comlink", () => ({
  releaseProxy: mocks.releaseProxy,
  proxy: mocks.proxy,
  wrap: mocks.wrap,
}));

vi.mock("@/features/transformers-js/download-verification/logic/complete-download-verification-runtime-evidence", () => ({
  completeDownloadVerificationRuntimeEvidence: mocks.completeRuntimeEvidence,
}));


class MockWorker extends EventTarget {
  private active = true;
  readonly startup = createProductionRuntimeStartupFixture({ emitFromWorker: ({ message }) => this.dispatchEvent(new MessageEvent('message', { data: message })) });
  readonly postMessage = vi.fn((message: unknown) => this.startup.acceptHostMessage({ message }));
  terminate = vi.fn(() => {
    this.active = false;
  });

  constructor(url: URL) {
    super();
    mocks.workerInstances.push(this);
    if (url.pathname.endsWith('/worker/bootstrap.ts') && mocks.productionAutoReady) {
      queueMicrotask(() => {
        if (this.active) this.startup.start();
      });
    }
  }
}

vi.stubGlobal("Worker", MockWorker);
let readonlyFiles: ReturnType<typeof createMemoryFiles>;

afterEach(() => {
  for (const worker of mocks.workerInstances) worker.dispatchEvent(new Event('error'));
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(readonlyFiles.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
});

function partialRun(): ModelSupportInvestigationRun {
  return {
    schemaVersion: 1,
    runId: "run-1",
    modelId: "org/model",
    scope: "partial-runtime-repository-cache-declarations-template-model-files",
    startedAt: "2026-08-06T00:00:00.000Z",
    completedAt: "2026-08-06T00:00:01.000Z",
    status: "passed",
    currentOperation: "Model file plan collected",
    steps: [
      { id: "runtime-assets", status: "passed", detail: "Runtime integrity passed" },
      { id: "loading-investigation", status: "not-run", detail: undefined },
      { id: "lane-comparison", status: "not-run", detail: undefined },
    ],
    runtimeAssets: undefined,
    repository: {
      normalizedModelId: "org/model",
      resolvedRevision: "a".repeat(40),
      pipelineTag: "text-generation",
    },
    runtimeTarget: {
      normalizedModelId: "org/model",
      evidenceRevision: "a".repeat(40),
      loaderRevisionOption: null,
      source: "repository",
      revisionIdentity: "exact-resolved-revision",
      pipelineTag: "text-generation",
    },
    downloadEvidence: undefined,
    cache: undefined,
    declarations: {
      classCapabilities: [{
        autoClass: "AutoModelForCausalLM",
        supports: true,
        notEvaluatedReason: undefined,
      }],
    },
    templateBehavior: {
      cases: [{
        caseId: "user-generation",
        status: "passed",
        messages: [{ role: "user", content: "hello" }],
      }],
    },
    modelFilePlan: {
      candidates: [{
        candidateId: "webgpu-q4f16",
        device: "webgpu",
        dtype: "q4f16",
        eligibility: "eligible",
      }, {
        candidateId: "webgpu-q4",
        device: "webgpu",
        dtype: "q4",
        eligibility: "eligible",
      }, {
        candidateId: "wasm-q4",
        device: "wasm",
        dtype: "q4",
        eligibility: "eligible",
      }],
    },
    loadAttempts: [],
    productionLane: { status: "not-run", observation: undefined, partialObservation: undefined, error: undefined },
    laneComparison: undefined,
    error: undefined,
  } as unknown as ModelSupportInvestigationRun;
}

function planningRun(): ModelSupportInvestigationPlanningWorkerRun {
  return toPlanningWorkerRun({ run: partialRun() });
}

function localPlanningRun({ complete }: { complete: boolean }): ModelSupportInvestigationPlanningWorkerRun {
  const revision = "b".repeat(40);
  const run = partialRun();
  run.repository = undefined;
  run.runtimeTarget = {
    normalizedModelId: "org/model",
    evidenceRevision: revision,
    loaderRevisionOption: revision,
    source: "local-cache",
    revisionIdentity: "local-immutable-revision",
    pipelineTag: undefined,
  };
  run.downloadEvidence = undefined;
  run.steps = [
    { id: "repository-information", status: "skipped", detail: "Skipped because external network access is disabled by investigation policy" },
    { id: "download-evidence", status: "skipped", detail: "Skipped because external network access is disabled by investigation policy" },
    ...run.steps,
  ];
  run.modelFilePlan = {
    normalizedModelId: "org/model",
    resolvedRevision: revision,
    modelType: "llama",
    registrySource: "ModelRegistry.get_model_files",
    cacheRevisionProvenance: "not-observed",
    cacheRevisionProvenanceReason: "Remote repository evidence was intentionally skipped",
    candidates: [{
      candidateId: "webgpu-q4",
      device: "webgpu",
      dtype: "q4",
      eligibility: complete ? "eligible" : "ineligible",
      eligibilityReason: complete ? "All required files are complete in local cache" : "Required local model artifact is missing",
      registryStatus: "passed",
      requiredFiles: [],
      missingRequiredFiles: complete ? [] : ["onnx/model_q4.onnx_data"],
    } as never],
  };
  return toPlanningWorkerRun({ run });
}

function partialRunWithProbeDownloadEvidence({ exactRevision = "a".repeat(40) }: { exactRevision?: string } = {}): ModelSupportInvestigationPlanningWorkerRun {
  const planning = partialRun();
  planning.repository = {
    ...planning.repository!,
    requestedModelId: "org/model",
    requestedRevision: "main",
    resolvedRevision: exactRevision,
  } as never;
  planning.runtimeTarget = {
    normalizedModelId: "org/model",
    evidenceRevision: exactRevision,
    loaderRevisionOption: null,
    source: "repository",
    revisionIdentity: "exact-resolved-revision",
    pipelineTag: "text-generation",
  };
  planning.steps = [
    ...planning.steps,
    { id: "download-evidence", status: "passed", detail: "Probe-only Download Evidence collected" },
    { id: "template-behavior", status: "blocked", detail: "Deferred until runtime completion" },
  ];
  planning.downloadEvidence = {
    schemaVersion: 1,
    runId: planning.runId,
    mode: "probe-only",
    run: {
      modelId: "org/model",
      normalizedModelId: "org/model",
      requestedRevision: "main",
      resolvedRevision: exactRevision,
      repositoryFileCount: 0,
      repositoryFiles: [],
      transportObservations: [],
      skippedModelArtifactCount: 0,
      bytesConsumed: 0,
      maximumBytes: 1024,
      startedAt: planning.startedAt,
      finishedAt: planning.completedAt,
    },
    modelArtifactObservations: [{
      modelId: 'org/model', revision: exactRevision, autoClass: 'AutoModelForCausalLM',
      candidate: { device: 'webgpu', dtype: 'q4f16' }, status: 'observed',
      observationMethod: 'held-model-artifact-fetch-quiescence', quiescenceMs: 1, timeoutMs: 100,
      paths: ['onnx/model_q4f16.onnx'], requests: [], error: undefined,
    }],
    modelArtifactObservationError: undefined,
    cacheBefore: undefined,
    cacheInspectionError: undefined,
  };
  return toPlanningWorkerRun({ run: planning });
}

function attempt({ candidateId, status }: {
  candidateId: "webgpu-q4f16" | "webgpu-q4",
  status: "passed" | "failed",
}): ModelSupportInvestigationLoadAttempt {
  return {
    attemptId: `attempt-${candidateId}`,
    candidateId,
    device: "webgpu",
    dtype: candidateId === "webgpu-q4f16" ? "q4f16" : "q4",
    autoClass: "AutoModelForCausalLM",
    resolvedRevision: "a".repeat(40),
    startedAt: "start",
    completedAt: "end",
    status,
    failureStage: status === "passed" ? undefined : "model-load",
    events: [],
    inputStrategyAttempts: [],
    selectedInputStrategy: undefined,
    inputTokenCount: status === "passed" ? 2 : undefined,
    inputTokenIds: status === "passed" ? [1, 2] : [],
    inputTensors: [],
    loadedModel: undefined,
    generatedTokenIds: status === "passed" ? [42] : [],
    generatedText: status === "passed" ? "answer" : undefined,
    naturalGeneration: status === "passed" ? {
      status: "observed",
      forced: false,
      maxNewTokens: 16,
      doSample: false,
      generatedTokenIds: [43],
      generatedText: "natural",
      termination: "ended-before-limit",
    } : undefined,
    toolProtocolProbe: undefined,
    modelType: "llama",
    error: status === "passed" ? undefined : {
      name: "Error",
      message: "load failed",
      stack: undefined,
    },
  };
}


function attemptCheckpoint({ candidateId }: {
  candidateId: "webgpu-q4f16" | "webgpu-q4",
}): ModelSupportInvestigationLoadAttemptCheckpoint {
  return {
    attemptId: `attempt-${candidateId}`,
    candidateId,
    device: "webgpu",
    dtype: candidateId === "webgpu-q4f16" ? "q4f16" : "q4",
    autoClass: "AutoModelForCausalLM",
    resolvedRevision: "a".repeat(40),
    startedAt: "start",
    checkpointedAt: "checkpoint",
    status: "running",
    currentStage: "model-load",
    events: [],
    inputStrategyAttempts: [],
    activeInputStrategy: undefined,
    selectedInputStrategy: undefined,
    inputTokenCount: undefined,
    inputTokenIds: [],
    inputTensors: [],
    loadedModel: {
      modelType: "llama",
      isEncoderDecoder: false,
      sessions: [],
      sessionFileCorrelations: [],
      effectiveMinimumGenerationConfig: {
        maxNewTokens: 1,
        doSample: false,
        bosTokenId: undefined,
        eosTokenId: undefined,
        padTokenId: undefined,
        decoderStartTokenId: undefined,
      },
    },
    generatedTokenIds: [],
    generatedText: undefined,
    naturalGeneration: undefined,
    toolProtocolProbe: undefined,
    modelType: "llama",
    error: undefined,
  };
}


function ordinaryProductionRemote() {
  return {
    loadDownloadedModel: vi.fn<WorkerServerApi<ITransformersJsWorker>['loadDownloadedModel']>().mockResolvedValue({ device: 'webgpu' }),
    generateText: vi.fn<WorkerServerApi<ITransformersJsWorker>['generateText']>(async (_messages, onChunk) => {
      onChunk('production');
    }),
    takeGenerationCapture: vi.fn(async () => ({ status: 'not-started' as const })),
    interrupt: vi.fn(async () => undefined), unloadModel: vi.fn(async () => undefined), resetCache: vi.fn(async () => undefined),
    [mocks.releaseProxy]: vi.fn(async () => undefined),
  };
}

function modelLoadOnlyConfiguration() {
  const configuration = createDefaultInvestigationConfiguration();
  configuration.scope.generation = 'not-selected';
  configuration.scope.continuity = 'not-selected';
  configuration.scope['capability-probes'] = 'not-selected';
  return configuration;
}

async function startPublicProviderHost({ production, configuration, onCheckpoint, productionLaneTimeoutMs, planning }: {
  production: ReturnType<typeof ordinaryProductionRemote>;
  configuration: ReturnType<typeof createDefaultInvestigationConfiguration>;
  onCheckpoint: Parameters<ReturnType<typeof import('./client-hosted')['createModelSupportInvestigationWorkerClient']>['runPartialInvestigation']>[0]['onCheckpoint'];
  productionLaneTimeoutMs: number | undefined;
  planning: ModelSupportInvestigationPlanningWorkerRun;
}) {
  const planningRemote = remote({ runPartialInvestigation: vi.fn(async () => planning) });
  mocks.wrap.mockReturnValueOnce(planningRemote).mockReturnValueOnce(production);
  const { createModelSupportInvestigationWorkerClient } = await import('./client-hosted');
  const client = createModelSupportInvestigationWorkerClient({ productionLaneTimeoutMs });
  const operation = client.runPartialInvestigation({ modelId: 'org/model', configuration, onEvent: vi.fn(), onCheckpoint });
  return { client, operation, planningRemote };
}

function remote({
  runPartialInvestigation,
  inspectDownloadedTemplateBehavior,
  runCandidateAttempt,
}: {
  runPartialInvestigation?: IModelSupportInvestigationWorker["runPartialInvestigation"],
  inspectDownloadedTemplateBehavior?: IModelSupportInvestigationWorker["inspectDownloadedTemplateBehavior"],
  runCandidateAttempt?: IModelSupportInvestigationWorker["runCandidateAttempt"],
}): IModelSupportInvestigationWorker & { [mocks.releaseProxy]: () => Promise<void> } {
  return {
    runPartialInvestigation: runPartialInvestigation ?? vi.fn(),
    inspectDownloadedTemplateBehavior: inspectDownloadedTemplateBehavior ?? vi.fn(),
    runCandidateAttempt: runCandidateAttempt ?? vi.fn(),
    [mocks.releaseProxy]: vi.fn(async () => undefined),
  };
}

describe("createModelSupportInvestigationWorkerClient", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.wrap.mockReset();
    mocks.workerInstances.length = 0;
    mocks.productionAutoReady = true;
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "coordinator-attempt") });
    installProductionRuntimeStartupPlatform({ origin: 'http://localhost' });
    const files = createMemoryFiles();
    readonlyFiles = files;
    files.enter({ nextPhase: 'load', mutationPolicy: 'read-only' });
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => files.root } });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('Hosted investigation tests forbid external fetch');
    }));
    mocks.runProductionScenario.mockResolvedValue({
      modelId: "org/model",
      resolvedRevision: "a".repeat(40),
      candidate: { device: "webgpu", dtype: "q4" },
      route: {
        autoClass: "AutoModelForCausalLM",
        processor: "tokenizer",
        strategy: "standard",
        modelType: "llama",
      },
      isEncoderDecoder: false,
      firstTurn: {
        status: "passed",
        turn: {
          messages: [{ role: "user", content: "hello" }],
          inputKeys: ["input_ids"],
          inputTensors: [],
          inputTokenIds: [1, 2],
          pastKeyValuesProvided: false,
          inputPastKeyValuesSummary: { kind: "nullish", valueType: "undefined", constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
          outputPastKeyValuesSummary: { kind: "object", valueType: "object", constructorName: "Object", ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
          generatedSequenceTokenIds: [1, 2, 44],
          generatedTokenIds: [44],
          generatedText: "production",
          streamChunks: ["production"],
          toolCalls: [],
          effectiveGenerationConfig: { maxNewTokens: 16, temperature: 0, topP: 1, doSample: false },
        },
      },
      continuity: { status: "not-run", reason: "fixture" },
      toolResultContinuation: { status: "not-run", reason: "fixture" },
      reasoning: { status: "unavailable", reason: "not a Qwen3.5 Production strategy" },
      multimodal: { status: "unavailable", strategy: "standard", reason: "fixture" },
    });
  });

  it('connects fresh acquisition to a separately owned Worker and publishes its HTTP progress', async () => {
    const request = { modelId: 'org/model', revision: 'a'.repeat(40), maximumBytes: 1024, repositoryFiles: [{ path: 'config.json', size: 3 }] };
    const summary: FreshMetadataSummary = {
      schemaVersion: 1, modelId: request.modelId, revision: request.revision,
      source: 'fresh-network-memory', status: 'prepared', maximumBytes: 1024, receivedBytes: 3,
      requests: [{ consumer: 'runtime-preparation', path: 'config.json', request: 'full', status: 'complete', httpStatus: 200, receivedBytes: 3 }],
      preparation: { processor: 'tokenizer', resourcePlansByCandidate: { 'webgpu/q4f16': { status: 'ready', paths: ['onnx/model_q4f16.onnx'] } } },
    };
    const freshRun = vi.fn<WorkerServerApi<FreshMetadataWorker>['run']>(async (_request, onObservation) => {
      onObservation({ summary });
      // This tests the Worker ownership/transport boundary, not metadata contents.
      return { summary, files: [] };
    });
    const planning = remote({ runPartialInvestigation: vi.fn<IModelSupportInvestigationWorker['runPartialInvestigation']>(async (_request, _onEvent, _onCheckpoint, collect) => {
      const result = await collect({ request });
      return toPlanningWorkerRun({ run: { ...partialRun(), freshMetadata: result.summary } });
    }) });
    mocks.wrap.mockReturnValueOnce(planning).mockReturnValueOnce({ run: freshRun, [mocks.releaseProxy]: vi.fn() });
    const onEvent = vi.fn();
    const onCheckpoint = vi.fn();
    const { createModelSupportInvestigationWorkerClient } = await import('./client-hosted');
    const client = createModelSupportInvestigationWorkerClient();
    const result = await client.runPartialInvestigation({ modelId: 'org/model', configuration: configurationForPreset({ preset: 'download-focused' }), replayMetadataBudgetBytes: 1024, onEvent, onCheckpoint });
    expect(result.freshMetadata).toEqual(summary);
    expect(freshRun).toHaveBeenCalledWith(request, expect.any(Function));
    expect(mocks.workerInstances).toHaveLength(2);
    expect(mocks.workerInstances.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
    expect(onEvent).toHaveBeenCalledWith({ event: expect.objectContaining({ detail: expect.stringContaining('file=config.json; response=200; received=3/1024 bytes') }) });
    expect(onCheckpoint.mock.calls.some(([{ checkpoint }]) => checkpoint.run.freshMetadata?.receivedBytes === 3)).toBe(true);
    expect(mocks.completeRuntimeEvidence).not.toHaveBeenCalled();
    expect(mocks.runProductionScenario).not.toHaveBeenCalled();
  });

  it('terminates a stuck fresh metadata Worker and continues the batch without reporting acquisition success', async () => {
    vi.useFakeTimers();
    const revision = 'a'.repeat(40);
    const firstStarted = Promise.withResolvers<void>();
    const lateResult = Promise.withResolvers<FreshMetadataResult>();
    const firstSummary: FreshMetadataSummary = {
      schemaVersion: 1, modelId: 'org/first', revision, source: 'fresh-network-memory',
      status: 'running', maximumBytes: 1024, receivedBytes: 3,
      requests: [{ consumer: 'runtime-preparation', path: 'tokenizer.json', request: 'full', status: 'reading', httpStatus: 200, receivedBytes: 3 }],
    };
    const completedLateSummary: FreshMetadataSummary = {
      ...firstSummary, status: 'prepared',
      preparation: { processor: 'tokenizer', resourcePlansByCandidate: {} },
    };
    let lateObservation: Parameters<WorkerServerApi<FreshMetadataWorker>['run']>[1] | undefined;
    const firstFresh = vi.fn<WorkerServerApi<FreshMetadataWorker>['run']>((_request, onObservation) => {
      lateObservation = onObservation;
      onObservation({ summary: firstSummary });
      firstStarted.resolve();
      return lateResult.promise;
    });
    const secondFresh = vi.fn<WorkerServerApi<FreshMetadataWorker>['run']>(async request => {
      expect(mocks.workerInstances[0]?.terminate).toHaveBeenCalledOnce();
      expect(mocks.workerInstances[1]?.terminate).toHaveBeenCalledOnce();
      return { summary: { ...firstSummary, modelId: request.modelId, status: 'prepared', receivedBytes: 0, requests: [], preparation: { processor: 'tokenizer', resourcePlansByCandidate: {} } }, files: [] };
    });
    // Shared planning protocol, not shared model expectations or result selection.
    const planning = vi.fn<IModelSupportInvestigationWorker['runPartialInvestigation']>(async (request, _onEvent, _onCheckpoint, collect) => {
      const result = await collect({ request: { modelId: request.modelId, revision, maximumBytes: 1024, repositoryFiles: [] } });
      return toPlanningWorkerRun({ run: { ...partialRun(), modelId: request.modelId, freshMetadata: result.summary } });
    });
    mocks.wrap.mockReturnValueOnce(remote({ runPartialInvestigation: planning }))
      .mockReturnValueOnce({ run: firstFresh, [mocks.releaseProxy]: vi.fn() })
      .mockReturnValueOnce(remote({ runPartialInvestigation: planning }))
      .mockReturnValueOnce({ run: secondFresh, [mocks.releaseProxy]: vi.fn() });
    const { createModelSupportInvestigationWorkerClient } = await import('./client-hosted');
    const checkpoints = vi.fn();
    const clients: ReturnType<typeof createModelSupportInvestigationWorkerClient>[] = [];
    const flow = runInvestigationTargetsSequentially({
      targets: ['org/first', 'org/second'], shouldInterrupt: () => false, takeSkipRequest: () => false, onUpdate: () => undefined,
      runTarget: async ({ target }) => {
        const client = createModelSupportInvestigationWorkerClient({ planningTimeoutMs: FRESH_METADATA_TIMEOUT_MS * 2 });
        clients.push(client);
        return client.runPartialInvestigation({ modelId: target, configuration: configurationForPreset({ preset: 'download-focused' }), replayMetadataBudgetBytes: 1024, onEvent: vi.fn(), onCheckpoint: checkpoints });
      },
    });
    try {
      await firstStarted.promise;
      await vi.advanceTimersByTimeAsync(FRESH_METADATA_TIMEOUT_MS);
      const results = await flow;
      expect(results.map(result => result.target)).toEqual(['org/first', 'org/second']);
      expect(results[0]?.run?.freshMetadata).toMatchObject({ status: 'timeout', receivedBytes: 3, requests: firstSummary.requests });
      expect(results[1]?.run?.freshMetadata).toMatchObject({ modelId: 'org/second', status: 'prepared' });
      expect(firstFresh).toHaveBeenCalledOnce();
      expect(secondFresh).toHaveBeenCalledOnce();
      expect(mocks.workerInstances).toHaveLength(4);
      expect(mocks.workerInstances.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
      const checkpointCount = checkpoints.mock.calls.length;
      lateObservation!({ summary: completedLateSummary });
      lateResult.resolve({ summary: completedLateSummary, files: [] });
      await Promise.resolve();
      expect(checkpoints).toHaveBeenCalledTimes(checkpointCount);
      expect(results[0]?.run?.freshMetadata?.status).toBe('timeout');
      expect(mocks.completeRuntimeEvidence).not.toHaveBeenCalled();
      expect(mocks.runProductionScenario).not.toHaveBeenCalled();
    } finally {
      for (const client of clients) await client.dispose();
      lateResult.resolve({ summary: firstSummary, files: [] });
      await flow;
      vi.useRealTimers();
    }
  });

  it('freezes interrupted fresh acquisition and its HTTP evidence when the user stops the current model', async () => {
    const request = { modelId: 'org/model', revision: 'a'.repeat(40), maximumBytes: 1024, repositoryFiles: [] };
    const started = Promise.withResolvers<void>();
    const held = Promise.withResolvers<FreshMetadataResult>();
    const summary: FreshMetadataSummary = {
      schemaVersion: 1, modelId: request.modelId, revision: request.revision,
      source: 'fresh-network-memory', status: 'running', maximumBytes: 1024, receivedBytes: 3,
      requests: [{ consumer: 'runtime-preparation', path: 'tokenizer.json', request: 'full', status: 'reading', httpStatus: 200, receivedBytes: 3 }],
    };
    const completed: FreshMetadataSummary = { ...summary, status: 'prepared', preparation: { processor: 'tokenizer', resourcePlansByCandidate: {} } };
    let publishLate: Parameters<WorkerServerApi<FreshMetadataWorker>['run']>[1] | undefined;
    const fresh = vi.fn<WorkerServerApi<FreshMetadataWorker>['run']>((_request, onObservation) => {
      publishLate = onObservation;
      onObservation({ summary });
      started.resolve();
      return held.promise;
    });
    const planning = remote({ runPartialInvestigation: vi.fn<IModelSupportInvestigationWorker['runPartialInvestigation']>(async (_request, _onEvent, _onCheckpoint, collect) => {
      const result = await collect({ request });
      return toPlanningWorkerRun({ run: { ...partialRun(), freshMetadata: result.summary } });
    }) });
    mocks.wrap.mockReturnValueOnce(planning).mockReturnValueOnce({ run: fresh, [mocks.releaseProxy]: vi.fn() });
    const onCheckpoint = vi.fn();
    const { createModelSupportInvestigationWorkerClient } = await import('./client-hosted');
    const client = createModelSupportInvestigationWorkerClient();
    const outcome = client.runPartialInvestigation({ modelId: 'org/model', configuration: configurationForPreset({ preset: 'download-focused' }), onEvent: vi.fn(), onCheckpoint })
      .then(() => undefined, (error: unknown) => error);
    try {
      await started.promise;
      await client.interrupt();
      expect(await outcome).toMatchObject({ name: 'ModelSupportInvestigationUserInterruptedError' });
      expect(onCheckpoint).toHaveBeenLastCalledWith({ checkpoint: expect.objectContaining({
        recovery: expect.objectContaining({ status: 'interrupted' }),
        run: expect.objectContaining({ freshMetadata: expect.objectContaining({ status: 'interrupted', receivedBytes: 3, requests: summary.requests }) }),
      }) });
      expect(mocks.workerInstances).toHaveLength(2);
      expect(mocks.workerInstances.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
      const checkpointCount = onCheckpoint.mock.calls.length;
      publishLate!({ summary: completed });
      held.resolve({ summary: completed, files: [] });
      await Promise.resolve();
      expect(onCheckpoint).toHaveBeenCalledTimes(checkpointCount);
      expect(mocks.completeRuntimeEvidence).not.toHaveBeenCalled();
      expect(mocks.runProductionScenario).not.toHaveBeenCalled();
    } finally {
      held.resolve({ summary: completed, files: [] });
      await client.dispose();
      await outcome;
    }
  });

  it('rejects a fresh-acquisition request from offline planning before creating a network Worker', async () => {
    const planning = remote({ runPartialInvestigation: vi.fn<IModelSupportInvestigationWorker['runPartialInvestigation']>(async (_request, _onEvent, _onCheckpoint, collect) => {
      await expect(collect({ request: { modelId: 'org/model', revision: 'a'.repeat(40), maximumBytes: 1024, repositoryFiles: [] } })).rejects.toThrow('authority');
      return planningRun();
    }) });
    mocks.wrap.mockReturnValueOnce(planning);
    const { createModelSupportInvestigationWorkerClient } = await import('./client-hosted');
    const client = createModelSupportInvestigationWorkerClient();
    await client.runPartialInvestigation({
      modelId: 'org/model', configuration: { ...configurationForPreset({ preset: 'download-focused' }), externalNetworkPolicy: 'deny' },
      onEvent: vi.fn(), onCheckpoint: vi.fn(),
    });
    expect(mocks.workerInstances).toHaveLength(1);
    expect(mocks.completeRuntimeEvidence).not.toHaveBeenCalled();
  });

  it('does not let planning restart fresh acquisition with a refunded per-target budget', async () => {
    const request = { modelId: 'org/model', revision: 'a'.repeat(40), maximumBytes: 1024, repositoryFiles: [] };
    const freshRun = vi.fn<WorkerServerApi<FreshMetadataWorker>['run']>(async () => ({
      summary: { schemaVersion: 1, modelId: request.modelId, revision: request.revision, source: 'fresh-network-memory', status: 'failed', maximumBytes: 1024, receivedBytes: 0, requests: [] },
      files: [],
    }));
    const planning = remote({ runPartialInvestigation: vi.fn<IModelSupportInvestigationWorker['runPartialInvestigation']>(async (_request, _onEvent, _onCheckpoint, collect) => {
      await collect({ request });
      await expect(collect({ request })).rejects.toThrow('already started');
      return planningRun();
    }) });
    mocks.wrap.mockReturnValueOnce(planning).mockReturnValue({ run: freshRun, [mocks.releaseProxy]: vi.fn() });
    const { createModelSupportInvestigationWorkerClient } = await import('./client-hosted');
    const client = createModelSupportInvestigationWorkerClient();
    await client.runPartialInvestigation({ modelId: 'org/model', configuration: configurationForPreset({ preset: 'download-focused' }), onEvent: vi.fn(), onCheckpoint: vi.fn() });
    expect(freshRun).toHaveBeenCalledTimes(1);
    expect(mocks.workerInstances).toHaveLength(2);
  });

  it("terminates planning when a heavy planning boundary never completes", async () => {
    vi.useFakeTimers();
    try {
      const planningRemote = remote({
        runPartialInvestigation: vi.fn((_modelId, onEvent) => {
          onEvent({
            event: {
              stepId: "template-behavior",
              status: "running",
              detail: "Inspecting tokenizer template behavior",
            },
          });
          return new Promise<ModelSupportInvestigationPlanningWorkerRun>(() => undefined);
        }),
      });
      mocks.wrap.mockReturnValueOnce(planningRemote);
      const onEvent = vi.fn();
      const onCheckpoint = vi.fn();

      const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
      const client = createModelSupportInvestigationWorkerClient({ planningTimeoutMs: 10 });
      const operation = client.runPartialInvestigation({ modelId: "org/model", configuration: createDefaultInvestigationConfiguration(), onEvent, onCheckpoint });
      const rejection = expect(operation).rejects.toMatchObject({
        name: "PlanningTimeoutError",
        stage: "template-behavior",
      });
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      expect(mocks.workerInstances[0]?.terminate).toHaveBeenCalledTimes(1);
      expect(planningRemote[mocks.releaseProxy]).not.toHaveBeenCalled();
      expect(onEvent).toHaveBeenCalledWith({
        event: expect.objectContaining({
          stepId: "template-behavior",
          status: "failed",
          detail: "Investigation planning timed out at template-behavior",
        }),
      });
      expect(onCheckpoint).toHaveBeenLastCalledWith({
        checkpoint: expect.objectContaining({
          recovery: expect.objectContaining({ status: "interrupted" }),
        }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("interrupts a hung planning Worker immediately and freezes an interrupted checkpoint", async () => {
    type PlanningArgs = Parameters<IModelSupportInvestigationWorker["runPartialInvestigation"]>;
    let lateEvent: PlanningArgs[1] | undefined;
    const planningRemote = remote({
      runPartialInvestigation: vi.fn((_modelId, onEvent) => {
        lateEvent = onEvent;
        return new Promise<Awaited<ReturnType<IModelSupportInvestigationWorker["runPartialInvestigation"]>>>(() => undefined);
      }),
    });
    mocks.wrap.mockReturnValueOnce(planningRemote);
    const onEvent = vi.fn();
    const onCheckpoint = vi.fn();

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const operation = client.runPartialInvestigation({ modelId: "org/model", configuration: createDefaultInvestigationConfiguration(), onEvent, onCheckpoint });
    await vi.waitFor(() => {
      expect(planningRemote.runPartialInvestigation).toHaveBeenCalledTimes(1);
    });

    await client.interrupt();
    await expect(operation).rejects.toMatchObject({
      name: "ModelSupportInvestigationUserInterruptedError",
      message: "Model Support Investigation was stopped by the user",
    });
    expect(mocks.workerInstances[0]?.terminate).toHaveBeenCalledTimes(1);
    expect(planningRemote[mocks.releaseProxy]).not.toHaveBeenCalled();
    expect(onCheckpoint).toHaveBeenLastCalledWith({
      checkpoint: expect.objectContaining({
        recovery: expect.objectContaining({
          status: "interrupted",
          interruption: expect.objectContaining({
            error: expect.objectContaining({
              name: "ModelSupportInvestigationUserInterruptedError",
            }),
          }),
        }),
      }),
    });

    const checkpointCountAfterStop = onCheckpoint.mock.calls.length;
    lateEvent?.({
      event: {
        stepId: "repository-information",
        status: "running",
        detail: "late callback after stop",
      },
    });
    expect(onEvent).not.toHaveBeenCalled();
    expect(onCheckpoint).toHaveBeenCalledTimes(checkpointCountAfterStop);
  });

  it("uses a fresh Worker for planning and every attempted candidate", async () => {
    const planningRemote = remote({
      runPartialInvestigation: vi.fn(async () => planningRun()),
    });
    const firstAttemptRemote = remote({
      runCandidateAttempt: vi.fn(async () => attempt({ candidateId: "webgpu-q4f16", status: "failed" })),
    });
    const secondAttemptRemote = remote({
      runCandidateAttempt: vi.fn(async () => attempt({ candidateId: "webgpu-q4", status: "passed" })),
    });
    mocks.wrap
      .mockReturnValueOnce(planningRemote)
      .mockReturnValueOnce(firstAttemptRemote)
      .mockReturnValueOnce(secondAttemptRemote);

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const result = await client.runPartialInvestigation({ modelId: "org/model", configuration: modelLoadOnlyConfiguration(), onEvent: vi.fn(), onCheckpoint: vi.fn() });

    expect(mocks.workerInstances).toHaveLength(3);
    expect(mocks.workerInstances.every(instance => instance.terminate.mock.calls.length === 1)).toBe(true);
    expect(planningRemote.runPartialInvestigation).toHaveBeenCalledWith(
      { runId: "coordinator-attempt", modelId: "org/model", externalNetworkPolicy: "allow", executionPlan: { repositoryDownload: true, modelLoad: true, generation: false, continuity: false, capabilityProbes: false } },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(firstAttemptRemote.runCandidateAttempt).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ candidateId: "webgpu-q4f16" }),
      expect.objectContaining({ generation: false, capabilityProbes: false }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(secondAttemptRemote.runCandidateAttempt).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ candidateId: "webgpu-q4" }),
      expect.objectContaining({ generation: false, capabilityProbes: false }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(result.loadAttempts.map(item => item.candidateId)).toEqual(["webgpu-q4f16", "webgpu-q4"]);
    expect(result.steps.find(step => step.id === "loading-investigation")?.status).toBe("passed");
    expect(result.productionLane.status).toBe("not-run");
    expect(result.laneComparison).toBeUndefined();
    expect(mocks.runProductionScenario).not.toHaveBeenCalled();

    await client.dispose();
    expect(mocks.workerInstances).toHaveLength(3);
  });
  it("treats settled Worker release failures as best-effort cleanup", async () => {
    const planningRemote = remote({
      runPartialInvestigation: vi.fn(async () => planningRun()),
    });
    planningRemote[mocks.releaseProxy] = vi.fn(async () => {
      throw new Error("planning release failed");
    });
    const attemptRemote = remote({
      runCandidateAttempt: vi.fn(async () => attempt({ candidateId: "webgpu-q4", status: "passed" })),
    });
    attemptRemote[mocks.releaseProxy] = vi.fn(async () => {
      throw new Error("candidate release failed");
    });
    mocks.wrap
      .mockReturnValueOnce(planningRemote)
      .mockReturnValueOnce(attemptRemote);

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const result = await client.runPartialInvestigation({
      modelId: "org/model",
      configuration: modelLoadOnlyConfiguration(),
      onEvent: vi.fn(),
      onCheckpoint: vi.fn(),
    });

    expect(result.status).toBe("passed");
    expect(result.productionLane.status).toBe("not-run");
    expect(planningRemote[mocks.releaseProxy]).toHaveBeenCalledTimes(1);
    expect(attemptRemote[mocks.releaseProxy]).toHaveBeenCalledTimes(1);
    expect(mocks.workerInstances.every(instance => instance.terminate.mock.calls.length === 1)).toBe(true);
  });

  it('keeps replay sidecars through completed checkpoints and bounds a hung planning release', async () => {
    vi.useFakeTimers();
    try {
      const blob = new Blob(['{}']);
      const sidecars = [{ path: 'config.json', blob }];
      const planning = planningRun();
      const planningRemote = remote({ runPartialInvestigation: vi.fn(async (request, _onEvent, onRunCheckpoint) => {
        expect(request.replayMetadataBudgetBytes).toBe(123);
        onRunCheckpoint({ run: planning, replayMetadata: sidecars });
        return planning;
      }) });
      planningRemote[mocks.releaseProxy] = vi.fn(() => new Promise<void>(() => undefined));
      mocks.wrap.mockReturnValueOnce(planningRemote);
      const { createModelSupportInvestigationWorkerClient } = await import('./client-hosted');
      const client = createModelSupportInvestigationWorkerClient();
      const onCheckpoint = vi.fn();
      const pending = client.runPartialInvestigation({ modelId: 'org/model', configuration: configurationForPreset({ preset: 'download-focused' }), replayMetadataBudgetBytes: 123, onEvent: vi.fn(), onCheckpoint });
      await vi.advanceTimersByTimeAsync(251);
      await pending;
      const finalCheckpoint = onCheckpoint.mock.calls.at(-1)![0].checkpoint;
      expect(finalCheckpoint.recovery.status).toBe('completed');
      expect(finalCheckpoint.replayMetadata).toEqual(sidecars);
      expect(finalCheckpoint.run).not.toHaveProperty('blob');
      expect(mocks.workerInstances[0]!.terminate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps completed replay sidecars after interrupt and rejects late Worker checkpoints', async () => {
    const sidecars = [{ path: 'config.json', blob: new Blob(['{}']) }];
    let lateCheckpoint: Parameters<IModelSupportInvestigationWorker['runPartialInvestigation']>[2] | undefined;
    const planningRemote = remote({ runPartialInvestigation: vi.fn(async (_request, _event, onRunCheckpoint) => {
      lateCheckpoint = onRunCheckpoint;
      onRunCheckpoint({ run: planningRun(), replayMetadata: sidecars });
      return await new Promise<ModelSupportInvestigationPlanningWorkerRun>(() => undefined);
    }) });
    mocks.wrap.mockReturnValueOnce(planningRemote);
    const { createModelSupportInvestigationWorkerClient } = await import('./client-hosted');
    const client = createModelSupportInvestigationWorkerClient();
    const onCheckpoint = vi.fn();
    const pending = client.runPartialInvestigation({ modelId: 'org/model', configuration: configurationForPreset({ preset: 'download-focused' }), onEvent: vi.fn(), onCheckpoint });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'ModelSupportInvestigationUserInterruptedError' });
    await client.interrupt();
    await rejected;
    const count = onCheckpoint.mock.calls.length;
    lateCheckpoint?.({ run: planningRun(), replayMetadata: [] });
    expect(onCheckpoint).toHaveBeenCalledTimes(count);
    expect(onCheckpoint.mock.calls.at(-1)![0].checkpoint.replayMetadata).toEqual(sidecars);
  });

  it("runs a complete local cache through the ordinary Provider without a second Reference or download lane", async () => {
    const production = ordinaryProductionRemote();
    const configuration = createDefaultInvestigationConfiguration();
    configuration.externalNetworkPolicy = 'deny';
    const { client, operation, planningRemote } = await startPublicProviderHost({
      production, configuration, planning: localPlanningRun({ complete: true }), onCheckpoint: vi.fn(), productionLaneTimeoutMs: undefined,
    });
    const result = await operation;
    expect(planningRemote.runPartialInvestigation).toHaveBeenCalledWith(
      { runId: 'coordinator-attempt', modelId: 'org/model', externalNetworkPolicy: 'deny', executionPlan: { repositoryDownload: true, modelLoad: true, generation: true, continuity: true, capabilityProbes: true } },
      expect.any(Function), expect.any(Function), expect.any(Function),
    );
    expect(production.loadDownloadedModel).toHaveBeenCalledExactlyOnceWith('org/model', { kind: 'discover-cached' }, expect.any(Function), { runId: 'run-1', workerEpoch: 1 });
    expect(production.generateText).toHaveBeenCalledTimes(13);
    expect(mocks.completeRuntimeEvidence).not.toHaveBeenCalled();
    expect(planningRemote.runCandidateAttempt).not.toHaveBeenCalled();
    expect(mocks.runProductionScenario).not.toHaveBeenCalled();
    expect(result.runtimeTarget?.evidenceRevision).toBe('b'.repeat(40));
    expect(result.productionProviderCapture?.run.status).toBe('completed');
    expect(result.productionLane.status).toBe('not-run');
    expect(result.steps.find(step => step.id === 'lane-comparison')?.status).toBe('skipped');
    await client.dispose();
  });

  it('returns the internally sealed checkpoint when a Provider completion retains an unclosed planning step', async () => {
    const planning = localPlanningRun({ complete: true });
    planning.steps = planning.steps.map(step => step.id === 'runtime-assets' ? { ...step, status: 'running', detail: 'Synthetic unclosed owner' } : step);
    const onCheckpoint = vi.fn();
    const { client, operation } = await startPublicProviderHost({ production: ordinaryProductionRemote(), configuration: createDefaultInvestigationConfiguration(),
      planning, onCheckpoint, productionLaneTimeoutMs: undefined });
    const result = await operation;
    const final = onCheckpoint.mock.calls.at(-1)![0].checkpoint;
    expect(result).toEqual(final.run);
    expect(result.status).toBe('failed');
    expect(final.recovery.status).toBe('interrupted');
    expect(final.recovery.interruption.error.name).toBe('InvestigationTerminalInvariantError');
    expect(result.error).not.toContain('stopped by the user');
    expect(result.productionProviderCapture?.run.status).toBe('completed');
    // This transport fixture intentionally has no native records. Preserve its
    // measured collection failure, rather than replacing it with the guard cause.
    expect(result.steps.find(step => step.id === 'loading-investigation')).toMatchObject({ status: 'failed', detail: expect.stringMatching(/^Public Provider collection ended;/u) });
    await client.dispose();
  });

  it("keeps download-focused investigation probe-only and never starts Model Load", async () => {
    const planning = partialRunWithProbeDownloadEvidence();
    const planningRemote = remote({
      runPartialInvestigation: vi.fn(async () => planning),
    });
    mocks.wrap.mockReturnValueOnce(planningRemote);

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const result = await client.runPartialInvestigation({
      modelId: "org/model",
      configuration: configurationForPreset({ preset: "download-focused" }),
      onEvent: vi.fn(),
      onCheckpoint: vi.fn(),
    });

    expect(planningRemote.runPartialInvestigation).toHaveBeenCalledWith(
      { runId: "coordinator-attempt", modelId: "org/model", externalNetworkPolicy: "allow", executionPlan: { repositoryDownload: true, modelLoad: false, generation: false, continuity: false, capabilityProbes: false } },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(mocks.completeRuntimeEvidence).not.toHaveBeenCalled();
    expect(mocks.runProductionScenario).not.toHaveBeenCalled();
    expect(mocks.workerInstances).toHaveLength(1);
    expect(result.loadAttempts).toEqual([]);
    expect(result.steps.find(step => step.id === "download-evidence")).toMatchObject({
      status: "passed",
      detail: expect.stringContaining("bounded probe collection ended"),
    });
    expect(result.steps.find(step => step.id === "loading-investigation")?.status).toBe("skipped");
    expect(result.steps.find(step => step.id === "lane-comparison")?.status).toBe("skipped");
    expect(result.productionLane.status).toBe("not-run");
  });

  it("does not inspect tokenizer/template after remote runtime acceptance when Model Load is selected without Generation", async () => {
    const exactRevision = "a".repeat(40);
    const planning = partialRunWithProbeDownloadEvidence({ exactRevision });
    planning.modelFilePlan = partialRun().modelFilePlan as never;
    planning.templateBehavior = undefined;
    planning.steps = planning.steps.map(step => (
      step.id === "template-behavior"
        ? { ...step, status: "skipped", detail: "Skipped because Generation is not selected by investigation scope" }
        : step
    ));
    mocks.completeRuntimeEvidence.mockResolvedValue({
      ...planning.downloadEvidence!,
      mode: "runtime-complete",
      runtimeCompletion: {
        schemaVersion: 1,
        status: "accepted",
        source: "production-download-preparation",
        repositoryResolvedRevision: exactRevision,
        cacheRevision: exactRevision,
        loaderRevisionOption: exactRevision,
        selectedCandidate: { device: "webgpu", dtype: "q4" },
        cacheReuse: undefined,
        preparation: undefined,
        cacheAfter: undefined,
        cacheInspectionError: undefined,
        error: undefined,
      },
    });

    const planningRemote = remote({ runPartialInvestigation: vi.fn(async () => planning) });
    const attemptRemote = remote({
      runCandidateAttempt: vi.fn(async () => ({
        ...attempt({ candidateId: "webgpu-q4", status: "passed" }),
        resolvedRevision: exactRevision,
        loaderRevisionOption: exactRevision,
        generatedTokenIds: [],
        generatedText: undefined,
        naturalGeneration: undefined,
      })),
    });
    mocks.wrap
      .mockReturnValueOnce(planningRemote)
      .mockReturnValueOnce(attemptRemote);

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const configuration = createDefaultInvestigationConfiguration();
    configuration.scope = {
      "repository-download": "selected",
      "model-load": "selected",
      generation: "not-selected",
      continuity: "not-selected",
      "capability-probes": "not-selected",
    };

    const result = await client.runPartialInvestigation({
      modelId: "org/model",
      configuration,
      onEvent: vi.fn(),
      onCheckpoint: vi.fn(),
    });

    expect(mocks.completeRuntimeEvidence).toHaveBeenCalledOnce();
    expect(mocks.workerInstances).toHaveLength(2);
    expect(attemptRemote.inspectDownloadedTemplateBehavior).not.toHaveBeenCalled();
    expect(attemptRemote.runCandidateAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ loaderRevisionOption: exactRevision }),
      expect.any(Object),
      undefined,
      expect.objectContaining({ candidateId: "webgpu-q4" }),
      { generation: false, capabilityProbes: false },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(mocks.runProductionScenario).not.toHaveBeenCalled();
    expect(result.steps.find(step => step.id === "template-behavior")?.status).toBe("skipped");
    expect(result.steps.find(step => step.id === "loading-investigation")?.status).toBe("passed");
  });

  it("runs cache-only Model Load without generation when only Model Load is selected", async () => {
    const planning = localPlanningRun({ complete: true });
    const planningRemote = remote({
      runPartialInvestigation: vi.fn(async () => planning),
    });
    const attemptRemote = remote({
      runCandidateAttempt: vi.fn(async () => ({
        ...attempt({ candidateId: "webgpu-q4", status: "passed" }),
        resolvedRevision: "b".repeat(40),
        loaderRevisionOption: "b".repeat(40),
        generatedTokenIds: [],
        generatedText: undefined,
        naturalGeneration: undefined,
      })),
    });
    mocks.wrap
      .mockReturnValueOnce(planningRemote)
      .mockReturnValueOnce(attemptRemote);

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const configuration = createDefaultInvestigationConfiguration();
    configuration.externalNetworkPolicy = "deny";
    configuration.scope = {
      "repository-download": "not-selected",
      "model-load": "selected",
      generation: "not-selected",
      continuity: "not-selected",
      "capability-probes": "not-selected",
    };
    const result = await client.runPartialInvestigation({
      modelId: "org/model",
      configuration,
      onEvent: vi.fn(),
      onCheckpoint: vi.fn(),
    });

    expect(planningRemote.runPartialInvestigation).toHaveBeenCalledWith(
      { runId: "coordinator-attempt", modelId: "org/model", externalNetworkPolicy: "deny", executionPlan: { repositoryDownload: false, modelLoad: true, generation: false, continuity: false, capabilityProbes: false } },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(mocks.completeRuntimeEvidence).not.toHaveBeenCalled();
    expect(attemptRemote.runCandidateAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ source: "local-cache" }),
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ candidateId: "webgpu-q4" }),
      { generation: false, capabilityProbes: false },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(mocks.runProductionScenario).not.toHaveBeenCalled();
    expect(result.steps.find(step => step.id === "loading-investigation")?.status).toBe("passed");
    expect(result.steps.find(step => step.id === "lane-comparison")?.status).toBe("skipped");
    expect(result.productionLane.status).toBe("not-run");
  });

  it("runs generation while disabling Production continuity and capability probes when they are not selected", async () => {
    const production = ordinaryProductionRemote();
    const configuration = createDefaultInvestigationConfiguration();
    configuration.externalNetworkPolicy = 'deny';
    configuration.scope = { 'repository-download': 'not-selected', 'model-load': 'not-selected', generation: 'selected', continuity: 'not-selected', 'capability-probes': 'not-selected' };
    const { client, operation, planningRemote } = await startPublicProviderHost({
      production, configuration, planning: localPlanningRun({ complete: true }), onCheckpoint: vi.fn(), productionLaneTimeoutMs: undefined,
    });
    const result = await operation;
    expect(planningRemote.runPartialInvestigation).toHaveBeenCalledWith(
      { runId: 'coordinator-attempt', modelId: 'org/model', externalNetworkPolicy: 'deny', executionPlan: { repositoryDownload: false, modelLoad: true, generation: true, continuity: false, capabilityProbes: false } },
      expect.any(Function), expect.any(Function), expect.any(Function),
    );
    expect(production.loadDownloadedModel).toHaveBeenCalledOnce();
    expect(production.generateText).toHaveBeenCalledTimes(3);
    expect(result.productionProviderCapture?.plan).toBe('generation-v2');
    expect(result.productionProviderInvestigation?.requests.filter(request => request.notStartedReason === 'scope-not-selected')).toHaveLength(10);
    expect(result.currentOperation).toContain('0 unexecuted');
    expect(result.requestedConfiguration).toEqual(configuration);
    expect(planningRemote.runCandidateAttempt).not.toHaveBeenCalled();
    expect(mocks.runProductionScenario).not.toHaveBeenCalled();
    await client.dispose();
  });

  it.each([
    {
      label: "Continuity only",
      selectedScope: "continuity" as const,
      expectedContinuity: true,
      expectedCapabilityProbes: false,
    },
    {
      label: "Capability probes only",
      selectedScope: "capability-probes" as const,
      expectedContinuity: false,
      expectedCapabilityProbes: true,
    },
  ])("runs required Model Load and Generation for $label", async ({
    selectedScope,
    expectedContinuity,
    expectedCapabilityProbes,
  }) => {
    const production = ordinaryProductionRemote();
    const configuration = createDefaultInvestigationConfiguration();
    configuration.externalNetworkPolicy = 'deny';
    configuration.scope = {
      'repository-download': 'not-selected', 'model-load': 'not-selected', generation: 'not-selected',
      continuity: selectedScope === 'continuity' ? 'selected' : 'not-selected',
      'capability-probes': selectedScope === 'capability-probes' ? 'selected' : 'not-selected',
    };
    const { client, operation } = await startPublicProviderHost({
      production, configuration, planning: localPlanningRun({ complete: true }), onCheckpoint: vi.fn(), productionLaneTimeoutMs: undefined,
    });
    const result = await operation;
    expect(production.loadDownloadedModel).toHaveBeenCalledOnce();
    expect(production.generateText).toHaveBeenCalledTimes(expectedContinuity ? 5 : 11);
    expect(result.productionProviderCapture?.plan).toBe(expectedContinuity ? 'generation-continuity-v2' : 'generation-capabilities-v2');
    expect(result.executionPlan).toEqual({
      repositoryDownload: false, modelLoad: true, generation: true,
      continuity: expectedContinuity, capabilityProbes: expectedCapabilityProbes,
    });
    expect(mocks.runProductionScenario).not.toHaveBeenCalled();
    await client.dispose();
  });

  it("blocks Model Load and Production for an incomplete local cache without external network or model download preparation", async () => {
    const planning = localPlanningRun({ complete: false });
    const planningRemote = remote({
      runPartialInvestigation: vi.fn(async () => planning),
    });
    mocks.wrap.mockReturnValueOnce(planningRemote);

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const configuration = modelLoadOnlyConfiguration();
    configuration.externalNetworkPolicy = "deny";
    const result = await client.runPartialInvestigation({
      modelId: "org/model",
      configuration,
      onEvent: vi.fn(),
      onCheckpoint: vi.fn(),
    });

    expect(planningRemote.runPartialInvestigation).toHaveBeenCalledWith(
      { runId: "coordinator-attempt", modelId: "org/model", externalNetworkPolicy: "deny", executionPlan: { repositoryDownload: true, modelLoad: true, generation: false, continuity: false, capabilityProbes: false } },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(mocks.completeRuntimeEvidence).not.toHaveBeenCalled();
    expect(mocks.runProductionScenario).not.toHaveBeenCalled();
    expect(mocks.workerInstances).toHaveLength(1);
    expect(result.loadAttempts).toEqual([]);
    expect(result.steps.find(step => step.id === "repository-information")?.status).toBe("skipped");
    expect(result.steps.find(step => step.id === "download-evidence")?.status).toBe("skipped");
    expect(result.steps.find(step => step.id === "loading-investigation")?.status).toBe("blocked");
    expect(result.steps.find(step => step.id === "lane-comparison")?.status).toBe("skipped");
    expect(result.productionLane.status).toBe("not-run");
    expect(result.error).toBeUndefined();
  });

  it("keeps a failed public request and continues independent inputs on the same ready model without another Load", async () => {
    const production = ordinaryProductionRemote();
    production.generateText.mockRejectedValueOnce(new Error('Synthetic request failure'));
    const { client, operation } = await startPublicProviderHost({
      production, configuration: createDefaultInvestigationConfiguration(), planning: planningRun(), onCheckpoint: vi.fn(), productionLaneTimeoutMs: undefined,
    });
    const result = await operation;
    expect(production.loadDownloadedModel).toHaveBeenCalledOnce();
    expect(production.generateText).toHaveBeenCalledTimes(12);
    expect(result.productionProviderCapture?.requests[0]?.trace.settled?.outcome.status).toBe('rejected');
    expect(result.productionProviderInvestigation?.requests.filter(request => request.notStartedReason === 'first-settlement-unavailable')).toHaveLength(1);
    expect(result.productionProviderInvestigation?.requests.filter(request => request.outcome === 'fulfilled')).toHaveLength(11);
    expect(result.status).toBe('failed');
    expect(mocks.runProductionScenario).not.toHaveBeenCalled();
    await client.dispose();
  });

  it("preserves public Load rejection without restarting a model or attempting a second host candidate", async () => {
    const production = ordinaryProductionRemote();
    production.loadDownloadedModel.mockRejectedValue(new Error('Synthetic model load failure'));
    const { client, operation } = await startPublicProviderHost({
      production, configuration: createDefaultInvestigationConfiguration(), planning: planningRun(), onCheckpoint: vi.fn(), productionLaneTimeoutMs: undefined,
    });
    const result = await operation;
    expect(production.loadDownloadedModel).toHaveBeenCalledOnce();
    expect(production.generateText).not.toHaveBeenCalled();
    expect(result.productionProviderCapture?.requests[0]?.trace.settled?.outcome.status).toBe('rejected');
    expect(result.productionProviderCapture?.requests.slice(1).every(request => request.status === 'not-started')).toBe(true);
    expect(result.loadAttempts).toEqual([]);
    expect(result.status).toBe('failed');
    expect(mocks.runProductionScenario).not.toHaveBeenCalled();
    await client.dispose();
  });

  it("ignores late Comlink callbacks after planning and public generation have completed", async () => {
    type PlanningArgs = Parameters<IModelSupportInvestigationWorker['runPartialInvestigation']>;
    let latePlanningEvent: PlanningArgs[1] | undefined;
    let latePlanningCheckpoint: PlanningArgs[2] | undefined;
    let lateChunk: Parameters<WorkerServerApi<ITransformersJsWorker>['generateText']>[1] | undefined;
    const planning = remote({ runPartialInvestigation: vi.fn(async (_request, event, checkpoint) => {
      latePlanningEvent = event; latePlanningCheckpoint = checkpoint; return planningRun();
    }) });
    const production = ordinaryProductionRemote();
    production.generateText.mockImplementation(async (_messages, onChunk) => {
      lateChunk = onChunk; onChunk('production');
    });
    mocks.wrap.mockReturnValueOnce(planning).mockReturnValueOnce(production);
    const { createModelSupportInvestigationWorkerClient } = await import('./client-hosted');
    const client = createModelSupportInvestigationWorkerClient();
    const onEvent = vi.fn(); const onCheckpoint = vi.fn();
    await client.runPartialInvestigation({ modelId: 'org/model', configuration: createDefaultInvestigationConfiguration(), onEvent, onCheckpoint });
    const events = onEvent.mock.calls.length; const checkpoints = onCheckpoint.mock.calls.length;
    latePlanningEvent?.({ event: { stepId: 'repository-information', status: 'running', detail: 'stale planning' } });
    latePlanningCheckpoint?.({ run: planningRun() });
    lateChunk?.('stale generation');
    expect(onEvent).toHaveBeenCalledTimes(events);
    expect(onCheckpoint).toHaveBeenCalledTimes(checkpoints);
    expect(onCheckpoint.mock.calls.at(-1)?.[0].checkpoint.recovery.status).toBe('completed');
    expect(JSON.stringify(onCheckpoint.mock.calls.at(-1)?.[0])).not.toContain('stale generation');
    await client.dispose();
  });

  it('ignores completed Load-only candidate callbacks without overwriting the parent checkpoint', async () => {
    type CandidateArgs = Parameters<IModelSupportInvestigationWorker['runCandidateAttempt']>;
    let lateEvent: CandidateArgs[6] | undefined;
    let lateCheckpoint: CandidateArgs[7] | undefined;
    const planning = remote({ runPartialInvestigation: vi.fn(async () => planningRun()) });
    const candidate = remote({ runCandidateAttempt: vi.fn(async (_target, _declarations, _template, _candidate, _options, _event, event, checkpoint) => {
      lateEvent = event;
      lateCheckpoint = checkpoint;
      return attempt({ candidateId: 'webgpu-q4f16', status: 'passed' });
    }) });
    mocks.wrap.mockReturnValueOnce(planning).mockReturnValueOnce(candidate);
    const { createModelSupportInvestigationWorkerClient } = await import('./client-hosted');
    const client = createModelSupportInvestigationWorkerClient();
    const onCheckpoint = vi.fn(); const onEvent = vi.fn();
    const result = await client.runPartialInvestigation({ modelId: 'org/model', configuration: modelLoadOnlyConfiguration(), onCheckpoint, onEvent });
    const checkpoints = onCheckpoint.mock.calls.length; const events = onEvent.mock.calls.length;
    lateEvent?.({ event: { stage: 'model-load', status: 'running', detail: 'stale candidate', at: '2026-08-31T00:00:00.000Z' } });
    lateCheckpoint?.({ attempt: attemptCheckpoint({ candidateId: 'webgpu-q4f16' }) });
    expect(onCheckpoint).toHaveBeenCalledTimes(checkpoints);
    expect(onEvent).toHaveBeenCalledTimes(events);
    expect(result.loadAttempts[0]?.status).toBe('passed');
    expect(onCheckpoint.mock.calls.at(-1)?.[0].checkpoint.recovery.status).toBe('completed');
    await client.dispose();
  });

  it.each(['ready', 'failed', 'disposed'] as const)('waits for Production startup and handles %s before public Load or generation', async startupOutcome => {
    mocks.productionAutoReady = false;
    const production = ordinaryProductionRemote();
    const onCheckpoint = vi.fn();
    const { client, operation } = await startPublicProviderHost({
      production, configuration: createDefaultInvestigationConfiguration(), planning: planningRun(), onCheckpoint, productionLaneTimeoutMs: undefined,
    });
    const outcome = operation.then(run => ({ run, error: undefined }), error => ({ run: undefined, error }));
    try {
      await vi.waitFor(() => expect(mocks.workerInstances).toHaveLength(2));
      expect(production.loadDownloadedModel).not.toHaveBeenCalled();
      expect(production.generateText).not.toHaveBeenCalled();
      const worker = mocks.workerInstances[1]!;
      switch (startupOutcome) {
      case 'ready':
        worker.startup.start();
        await worker.startup.ready;
        expect((await outcome).run?.productionProviderCapture?.run.status).toBe('completed');
        expect(production.loadDownloadedModel).toHaveBeenCalledOnce();
        expect(production.generateText).toHaveBeenCalledTimes(13);
        break;
      case 'failed':
        // The ordinary service eagerly replaces a failed client. Its idle replacement
        // must complete the real startup handshake before collection can inspect it.
        mocks.productionAutoReady = true;
        worker.dispatchEvent(new MessageEvent('message', { data: { ...PRODUCTION_WORKER_READY, status: 'failed', message: 'Fixture entry evaluation failed' } }));
        expect((await outcome).run?.productionProviderInvestigation?.requests[0]?.outcome).toBe('rejected');
        expect(production.loadDownloadedModel).not.toHaveBeenCalled();
        expect(production.generateText).not.toHaveBeenCalled();
        break;
      case 'disposed':
        await client.dispose();
        expect((await outcome).error).toMatchObject({ name: 'ModelSupportInvestigationUserInterruptedError' });
        expect(production.loadDownloadedModel).not.toHaveBeenCalled();
        expect(production.generateText).not.toHaveBeenCalled();
        break;
      default: {
        const exhaustive: never = startupOutcome;
        throw new Error(`Unhandled startup outcome: ${exhaustive}`);
      }
      }
      const checkpoints = onCheckpoint.mock.calls.length;
      worker.dispatchEvent(new MessageEvent('message', { data: worker.startup.readyMessage }));
      await Promise.resolve();
      expect(onCheckpoint).toHaveBeenCalledTimes(checkpoints);
      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally {
      await client.dispose(); await outcome;
    }
  });

  it("does not misclassify a Production worker-start timeout as a candidate load failure", async () => {
    vi.useFakeTimers();
    mocks.productionAutoReady = false;
    const production = ordinaryProductionRemote();
    const { client, operation } = await startPublicProviderHost({
      production, configuration: createDefaultInvestigationConfiguration(), planning: planningRun(), onCheckpoint: vi.fn(), productionLaneTimeoutMs: 10,
    });
    try {
      await vi.waitFor(() => expect(mocks.workerInstances).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(10);
      const result = await operation;
      expect(result.productionProviderInvestigation?.stopReason).toBe('run-deadline');
      expect(result.productionProviderCapture?.requests[0]?.status).toBe('awaiting-settlement');
      expect(result.loadAttempts).toEqual([]);
      expect(result.productionLane.partialObservation).toBeUndefined();
      expect(production.loadDownloadedModel).not.toHaveBeenCalled();
      expect(production.generateText).not.toHaveBeenCalled();
      expect(mocks.workerInstances[1]?.terminate).toHaveBeenCalledOnce();
    } finally {
      await client.dispose(); vi.useRealTimers();
    }
  });

  it("terminates a timed-out Production Worker without waiting for Comlink disposal", async () => {
    vi.useFakeTimers();
    const production = ordinaryProductionRemote();
    const entered = Promise.withResolvers<void>();
    production.generateText.mockImplementation(() => {
      entered.resolve(); return new Promise(() => undefined);
    });
    const { client, operation } = await startPublicProviderHost({
      production, configuration: createDefaultInvestigationConfiguration(), planning: planningRun(), onCheckpoint: vi.fn(), productionLaneTimeoutMs: 10,
    });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(10);
      const result = await operation;
      expect(result.productionProviderInvestigation?.stopReason).toBe('run-deadline');
      expect(result.productionProviderCapture?.requests[0]?.status).toBe('awaiting-settlement');
      expect(mocks.workerInstances[1]?.terminate).toHaveBeenCalledOnce();
      expect(production[mocks.releaseProxy]).not.toHaveBeenCalled();
      expect(production.takeGenerationCapture).not.toHaveBeenCalled();
    } finally {
      await client.dispose(); vi.useRealTimers();
    }
  });

  it("terminates an active Production Worker when the investigation client is disposed", async () => {
    const production = ordinaryProductionRemote();
    const entered = Promise.withResolvers<void>();
    production.generateText.mockImplementation(() => {
      entered.resolve(); return new Promise(() => undefined);
    });
    const onCheckpoint = vi.fn();
    const { client, operation } = await startPublicProviderHost({
      production, configuration: createDefaultInvestigationConfiguration(), planning: planningRun(), onCheckpoint, productionLaneTimeoutMs: undefined,
    });
    const outcome = operation.catch(error => error);
    await entered.promise;
    const checkpoints = onCheckpoint.mock.calls.length;
    await client.dispose();
    expect(await outcome).toMatchObject({ name: 'ModelSupportInvestigationUserInterruptedError' });
    expect(onCheckpoint).toHaveBeenCalledTimes(checkpoints);
    expect(mocks.workerInstances[1]?.terminate).toHaveBeenCalledOnce();
    expect(production[mocks.releaseProxy]).not.toHaveBeenCalled();
    expect(production.takeGenerationCapture).not.toHaveBeenCalled();
  });

  it("interrupts a hung Production Worker without waiting for its remote Promise", async () => {
    const production = ordinaryProductionRemote();
    const entered = Promise.withResolvers<void>();
    production.generateText.mockImplementation(() => {
      entered.resolve(); return new Promise(() => undefined);
    });
    const onCheckpoint = vi.fn();
    const { client, operation } = await startPublicProviderHost({
      production, configuration: createDefaultInvestigationConfiguration(), planning: planningRun(), onCheckpoint, productionLaneTimeoutMs: undefined,
    });
    const outcome = operation.catch(error => error);
    await entered.promise;
    await client.interrupt();
    expect(await outcome).toMatchObject({ name: 'ModelSupportInvestigationUserInterruptedError' });
    expect(mocks.workerInstances[1]?.terminate).toHaveBeenCalledOnce();
    expect(production[mocks.releaseProxy]).not.toHaveBeenCalled();
    expect(onCheckpoint).toHaveBeenLastCalledWith({ checkpoint: expect.objectContaining({
      recovery: expect.objectContaining({ status: 'interrupted' }),
      run: expect.objectContaining({ productionProviderCapture: expect.objectContaining({ requests: expect.arrayContaining([expect.objectContaining({ status: 'awaiting-settlement' })]) }) }),
    }) });
    await client.waitForEvidenceRelease();
  });

  it("preserves public Load progress at interruption without accepting late progress or fabricating candidate telemetry", async () => {
    const production = ordinaryProductionRemote();
    const entered = Promise.withResolvers<void>();
    let lateProgress: Parameters<WorkerServerApi<ITransformersJsWorker>['loadDownloadedModel']>[2] | undefined;
    production.loadDownloadedModel.mockImplementation((_model, _revision, progress) => {
      lateProgress = progress;
      progress({ status: 'progress', file: 'model.onnx', loaded: 42, total: 100 });
      entered.resolve(); return new Promise(() => undefined);
    });
    const onCheckpoint = vi.fn();
    const { client, operation } = await startPublicProviderHost({
      production, configuration: createDefaultInvestigationConfiguration(), planning: planningRun(), onCheckpoint, productionLaneTimeoutMs: undefined,
    });
    const outcome = operation.catch(error => error);
    await entered.promise;
    await client.interrupt();
    expect(await outcome).toMatchObject({ name: 'ModelSupportInvestigationUserInterruptedError' });
    const checkpoint = onCheckpoint.mock.calls.at(-1)![0].checkpoint;
    expect(checkpoint.run.productionProviderInvestigation.providerProgress.loadStatus).toBe('loading');
    expect(checkpoint.run.productionProviderCapture.requests[0].status).toBe('awaiting-settlement');
    expect(checkpoint.run.productionLane.partialObservation).toBeUndefined();
    const checkpoints = onCheckpoint.mock.calls.length;
    lateProgress?.({ status: 'ready' });
    expect(onCheckpoint).toHaveBeenCalledTimes(checkpoints);
    expect(checkpoint.run.productionProviderInvestigation.providerProgress.loadStatus).toBe('loading');
    expect(production.generateText).not.toHaveBeenCalled();
  });

  it("does not invent candidate or tokenizer subphase evidence from ordinary public Load progress", async () => {
    const production = ordinaryProductionRemote();
    const entered = Promise.withResolvers<void>();
    production.loadDownloadedModel.mockImplementation((_model, _revision, progress) => {
      progress({ status: 'initiate', file: 'tokenizer.json' });
      entered.resolve(); return new Promise(() => undefined);
    });
    const onCheckpoint = vi.fn();
    const { client, operation } = await startPublicProviderHost({
      production, configuration: createDefaultInvestigationConfiguration(), planning: planningRun(), onCheckpoint, productionLaneTimeoutMs: undefined,
    });
    const outcome = operation.catch(error => error);
    await entered.promise;
    await client.interrupt();
    expect(await outcome).toMatchObject({ name: 'ModelSupportInvestigationUserInterruptedError' });
    const checkpoint = onCheckpoint.mock.calls.at(-1)![0].checkpoint;
    expect(checkpoint.run.productionProviderInvestigation.providerProgress.loadStatus).toBe('loading');
    expect(checkpoint.run.loadAttempts).toEqual([]);
    expect(checkpoint.run.productionLane.partialObservation).toBeUndefined();
    expect(production.generateText).not.toHaveBeenCalled();
    expect(mocks.workerInstances[1]?.terminate).toHaveBeenCalledOnce();
  });

  it("terminates a timed-out candidate Worker and continues with the next eligible candidate", async () => {
    vi.useFakeTimers();
    try {
      const planningRemote = remote({
        runPartialInvestigation: vi.fn(async () => planningRun()),
      });
      const timedOutAttemptRemote = remote({
        runCandidateAttempt: vi.fn((_runtimeTarget, _declarations, _templateBehavior, _candidate, _executionOptions, _onEvent, onAttemptEvent) => {
          onAttemptEvent({
            event: {
              stage: "model-load",
              status: "running",
              detail: "webgpu-q4f16: model-load",
              at: "2026-08-06T00:00:02.000Z",
            },
          });
          return new Promise<ModelSupportInvestigationLoadAttempt>(() => undefined);
        }),
      });
      const successfulAttemptRemote = remote({
        runCandidateAttempt: vi.fn(async () => attempt({ candidateId: "webgpu-q4", status: "passed" })),
      });
      mocks.wrap
        .mockReturnValueOnce(planningRemote)
        .mockReturnValueOnce(timedOutAttemptRemote)
        .mockReturnValueOnce(successfulAttemptRemote);

      const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
      const client = createModelSupportInvestigationWorkerClient({ candidateAttemptTimeoutMs: 10 });
      const operation = client.runPartialInvestigation({ modelId: "org/model", configuration: modelLoadOnlyConfiguration(), onEvent: vi.fn(), onCheckpoint: vi.fn() });
      await vi.advanceTimersByTimeAsync(10);
      const result = await operation;

      expect(result.loadAttempts).toHaveLength(2);
      expect(result.loadAttempts[0]).toMatchObject({
        candidateId: "webgpu-q4f16",
        status: "failed",
        failureStage: "model-load",
        error: {
          name: "CandidateAttemptTimeoutError",
        },
      });
      expect(result.loadAttempts[0]?.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: "model-load", status: "running" }),
        expect.objectContaining({ stage: "model-load", status: "failed" }),
      ]));
      expect(result.loadAttempts[1]?.status).toBe("passed");
      expect(mocks.workerInstances).toHaveLength(3);
      expect(mocks.workerInstances[1]?.terminate).toHaveBeenCalledTimes(1);
      expect(timedOutAttemptRemote[mocks.releaseProxy]).not.toHaveBeenCalled();
      expect(successfulAttemptRemote[mocks.releaseProxy]).toHaveBeenCalledTimes(1);

      await client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes an interrupted parent checkpoint when the planning Worker exits abruptly", async () => {
    const planningRemote = remote({
      runPartialInvestigation: vi.fn((_modelId, onEvent) => {
        onEvent({
          event: {
            stepId: "repository-information",
            status: "running",
            detail: "Resolving repository",
          },
        });
        return Promise.reject(new Error("planning Worker exited"));
      }),
    });
    mocks.wrap.mockReturnValueOnce(planningRemote);
    const onCheckpoint = vi.fn();

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    await expect(client.runPartialInvestigation({
      modelId: "org/model",
      configuration: createDefaultInvestigationConfiguration(),
      onEvent: vi.fn(),
      onCheckpoint,
    })).rejects.toThrow("planning Worker exited");

    const lastCheckpoint = onCheckpoint.mock.calls.at(-1)?.[0].checkpoint;
    expect(lastCheckpoint).toMatchObject({
      recovery: {
        status: "interrupted",
        lastEvent: {
          stepId: "repository-information",
          detail: "Resolving repository",
        },
        interruption: {
          error: { name: "Error", message: "planning Worker exited" },
        },
      },
      run: {
        status: "failed",
        currentOperation: expect.stringContaining("after repository-information: Resolving repository"),
      },
    });
    expect(planningRemote[mocks.releaseProxy]).toHaveBeenCalledTimes(1);
  });


  it('does not start redundant accepted-cache template work before continuing to the next target', async () => {
    const planning = partialRunWithProbeDownloadEvidence({ exactRevision: 'b'.repeat(40) });
    const planningRemote = remote({ runPartialInvestigation: vi.fn(async () => planning),
      inspectDownloadedTemplateBehavior: vi.fn(() => new Promise<NonNullable<ModelSupportInvestigationRun['templateBehavior']>>(() => undefined)) });
    const production = ordinaryProductionRemote();
    mocks.wrap.mockReturnValueOnce(planningRemote).mockReturnValueOnce(production);
    const { createModelSupportInvestigationWorkerClient } = await import('./client-hosted');
    const client = createModelSupportInvestigationWorkerClient();
    const visited: string[] = [];
    const executions = await runInvestigationTargetsSequentially({
      targets: ['org/model', 'org/next'], shouldInterrupt: () => false,
      takeSkipRequest: () => false, onUpdate: () => undefined,
      runTarget: async ({ target }) => {
        visited.push(target);
        if (target === 'org/model') return client.runPartialInvestigation({
          modelId: target, configuration: createDefaultInvestigationConfiguration(), onEvent: vi.fn(), onCheckpoint: vi.fn(),
        });
        expect(mocks.workerInstances[1]?.terminate).toHaveBeenCalledOnce();
        return { ...partialRun(), modelId: target };
      },
    });
    expect(visited).toEqual(['org/model', 'org/next']);
    expect(executions).toHaveLength(2);
    expect(production.generateText).toHaveBeenCalledTimes(13);
    expect(planningRemote.inspectDownloadedTemplateBehavior).not.toHaveBeenCalled();
    expect(mocks.completeRuntimeEvidence).not.toHaveBeenCalled();
    expect(mocks.runProductionScenario).not.toHaveBeenCalled();
    expect(mocks.wrap).toHaveBeenCalledTimes(2);
    await client.dispose();
  });

  it("retains the planning revision without overriding ordinary Provider Load resolution or refreshing runtime lanes", async () => {
    const exactRevision = 'b'.repeat(40);
    const planning = partialRunWithProbeDownloadEvidence({ exactRevision });
    const production = ordinaryProductionRemote();
    const { client, operation, planningRemote } = await startPublicProviderHost({
      production, configuration: createDefaultInvestigationConfiguration(), planning, onCheckpoint: vi.fn(), productionLaneTimeoutMs: undefined,
    });
    const result = await operation;
    expect(result.repository?.resolvedRevision).toBe(exactRevision);
    expect(result.downloadEvidence).toEqual({ ...planning.downloadEvidence, mode: 'runtime-complete', runtimeCompletion: {
      schemaVersion: 1, source: 'ordinary-provider-load', status: 'exhausted', repositoryResolvedRevision: exactRevision,
      cacheRevision: null, loaderRevisionOption: null, selectedCandidate: undefined,
      cacheReuse: undefined, preparation: undefined, cacheAfter: undefined, cacheInspectionError: undefined,
      error: { name: 'ProductionLoadReceiptUnavailable', message: 'Ordinary Provider Load status=ready; receipt=not-observed. No independent acceptance Load was run.' },
    } });
    // Planning provenance is evidence, not authority to silently change the
    // ordinary Provider's requested Load revision or preferred candidate.
    expect(production.loadDownloadedModel).toHaveBeenCalledExactlyOnceWith('org/model', { kind: 'discover-cached' }, expect.any(Function), { runId: 'run-1', workerEpoch: 1 });
    expect(production.generateText).toHaveBeenCalledTimes(13);
    expect(planningRemote.inspectDownloadedTemplateBehavior).not.toHaveBeenCalled();
    expect(planningRemote.runCandidateAttempt).not.toHaveBeenCalled();
    expect(mocks.completeRuntimeEvidence).not.toHaveBeenCalled();
    expect(mocks.runProductionScenario).not.toHaveBeenCalled();
    expect(result.productionLane.status).toBe('not-run');
    expect(result.laneComparison).toBeUndefined();
    await client.dispose();
  });

  it("disallows legacy main reuse when bounded provenance already mismatched that namespace", async () => {
    const exactRevision = "e".repeat(40);
    const planning = partialRunWithProbeDownloadEvidence({ exactRevision });
    planning.cache = {
      provenance: {
        files: [{ cacheRevision: "main", status: "mismatched" }],
      },
    } as never;
    mocks.completeRuntimeEvidence.mockResolvedValue({
      ...planning.downloadEvidence!,
      mode: "runtime-complete" as const,
      runtimeCompletion: {
        schemaVersion: 1 as const,
        status: "failed" as const,
        source: "cache-reuse-failed" as const,
        repositoryResolvedRevision: exactRevision,
        cacheRevision: null,
        loaderRevisionOption: null,
        selectedCandidate: undefined,
        cacheReuse: undefined,
        preparation: undefined,
        cacheAfter: undefined,
        cacheInspectionError: undefined,
        error: { name: "FixtureStop", message: "stop after checking policy" },
      },
    });
    const planningRemote = remote({ runPartialInvestigation: vi.fn(async () => planning) });
    mocks.wrap.mockReturnValueOnce(planningRemote);

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    await client.runPartialInvestigation({ modelId: "org/model", configuration: modelLoadOnlyConfiguration(), onEvent: vi.fn(), onCheckpoint: vi.fn() });

    expect(mocks.completeRuntimeEvidence).toHaveBeenCalledWith(expect.objectContaining({
      evidence: planning.downloadEvidence,
      allowLegacyMainReuse: false,
    }));
  });

  it("stops downstream runtime lanes when runtime-complete preparation fails", async () => {
    const exactRevision = "c".repeat(40);
    const planning = partialRunWithProbeDownloadEvidence({ exactRevision });
    mocks.completeRuntimeEvidence.mockResolvedValue({
      ...planning.downloadEvidence!,
      mode: "runtime-complete" as const,
      runtimeCompletion: {
        schemaVersion: 1 as const,
        status: "failed" as const,
        source: "cache-reuse-failed" as const,
        repositoryResolvedRevision: exactRevision,
        cacheRevision: null,
        loaderRevisionOption: null,
        selectedCandidate: undefined,
        cacheReuse: undefined,
        preparation: undefined,
        cacheAfter: undefined,
        cacheInspectionError: undefined,
        error: { name: "RuntimeRejected", message: "runtime cache rejected" },
      },
    });
    const planningRemote = remote({ runPartialInvestigation: vi.fn(async () => planning) });
    mocks.wrap.mockReturnValueOnce(planningRemote);

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const result = await client.runPartialInvestigation({ modelId: "org/model", configuration: modelLoadOnlyConfiguration(), onEvent: vi.fn(), onCheckpoint: vi.fn() });

    expect(result.downloadEvidence?.runtimeCompletion).toMatchObject({
      status: "failed",
      error: { name: "RuntimeRejected", message: "runtime cache rejected" },
    });
    expect(result.steps.find(step => step.id === "download-evidence")).toMatchObject({ status: "failed" });
    expect(result.steps.find(step => step.id === "loading-investigation")).toMatchObject({ status: "blocked" });
    expect(result.steps.find(step => step.id === "lane-comparison")).toMatchObject({ status: "skipped" });
    expect(result.loadAttempts).toEqual([]);
    expect(mocks.runProductionScenario).not.toHaveBeenCalled();
    expect(mocks.wrap).toHaveBeenCalledTimes(1);
  });

  it("records an incomplete local cache as an expected block without downloading or failing the investigation", async () => {
    const exactRevision = "c".repeat(40);
    const planning = partialRunWithProbeDownloadEvidence({ exactRevision });
    mocks.completeRuntimeEvidence.mockResolvedValue({
      ...planning.downloadEvidence!,
      mode: "runtime-complete" as const,
      runtimeCompletion: {
        schemaVersion: 1 as const,
        status: "exhausted" as const,
        source: "cache-only-unavailable" as const,
        repositoryResolvedRevision: exactRevision,
        cacheRevision: null,
        loaderRevisionOption: null,
        selectedCandidate: undefined,
        cacheReuse: undefined,
        preparation: undefined,
        cacheAfter: undefined,
        cacheInspectionError: undefined,
        error: {
          name: "ModelSupportInvestigationLocalCacheIncomplete",
          message: "No complete local Production candidate is available; investigation does not download model artifacts",
        },
      },
    });
    const planningRemote = remote({ runPartialInvestigation: vi.fn(async () => planning) });
    mocks.wrap.mockReturnValueOnce(planningRemote);

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const result = await client.runPartialInvestigation({ modelId: "org/model", configuration: modelLoadOnlyConfiguration(), onEvent: vi.fn(), onCheckpoint: vi.fn() });

    expect(result.downloadEvidence?.runtimeCompletion).toMatchObject({
      status: "exhausted",
      source: "cache-only-unavailable",
    });
    expect(result.steps.find(step => step.id === "download-evidence")).toMatchObject({ status: "passed" });
    expect(result.steps.find(step => step.id === "loading-investigation")).toMatchObject({ status: "blocked" });
    expect(result.steps.find(step => step.id === "lane-comparison")).toMatchObject({ status: "skipped" });
    expect(result.loadAttempts).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(mocks.runProductionScenario).not.toHaveBeenCalled();
    expect(mocks.wrap).toHaveBeenCalledTimes(1);
  });

  it("bounds cache acceptance separately from later model-load budgets and retains a timeout checkpoint", async () => {
    const planning = partialRunWithProbeDownloadEvidence({ exactRevision: "d".repeat(40) });
    const sidecars = [{ path: 'config.json', blob: new Blob(['{}']) }];
    mocks.wrap.mockReturnValueOnce(remote({ runPartialInvestigation: vi.fn(async (_request, _event, checkpoint) => {
      checkpoint({ run: planning, replayMetadata: sidecars });
      return planning;
    }) }));
    let runtimeSignal: AbortSignal | undefined;
    let lateProgress: RuntimeAcceptanceProgressCallback | undefined;
    mocks.completeRuntimeEvidence.mockImplementation(({ signal, onProgress }: { signal?: AbortSignal; onProgress?: RuntimeAcceptanceProgressCallback }) => {
      runtimeSignal = signal;
      lateProgress = onProgress;
      const identity = { phase: 'runtime' as const, revision: 'd'.repeat(40), candidate: { device: 'webgpu' as const, dtype: 'q4' as const } };
      onProgress?.({ progress: { ...identity, info: { status: 'cache-acceptance-model-session' } } });
      // This raw byte event is deliberately throttled. A terminal checkpoint
      // must flush it rather than report the earlier zero-byte stage event.
      onProgress?.({ progress: { ...identity, info: { status: 'progress', file: 'model_q4.onnx', loaded: 42, total: 100 } } });
      return new Promise(() => undefined);
    });
    const onCheckpoint = vi.fn();
    const onEvent = vi.fn();
    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient({ cacheAcceptanceTimeoutMs: 25 });
    const result = await client.runPartialInvestigation({
      modelId: "org/model", configuration: modelLoadOnlyConfiguration(), onEvent, onCheckpoint,
    }).catch(error => error);
    expect(result).toMatchObject({ name: 'CacheAcceptanceTimeoutError' });
    expect(runtimeSignal?.aborted).toBe(true);
    expect(runtimeSignal?.reason).toBe(result);
    expect(onCheckpoint).toHaveBeenLastCalledWith({ checkpoint: expect.objectContaining({
      recovery: expect.objectContaining({ status: 'interrupted' }),
      run: expect.objectContaining({ downloadEvidence: planning.downloadEvidence }),
      replayMetadata: sidecars,
    }) });
    const finalCheckpoint = onCheckpoint.mock.calls.at(-1)![0].checkpoint;
    const event = onEvent.mock.calls.at(-1)![0].event;
    expect(event).toMatchObject({
      detail: expect.stringContaining('cache-acceptance-model-session'),
      progress: { candidateId: 'webgpu-q4', currentFile: 'model_q4.onnx', fileLoaded: 42, fileTotal: 100, lastForwardProgressAt: expect.any(String) },
    });
    expect(finalCheckpoint.recovery.events.at(-1)).toMatchObject(event);
    const deliveredEvents = onEvent.mock.calls.length;
    const deliveredCheckpoints = onCheckpoint.mock.calls.length;
    lateProgress?.({ progress: { phase: 'runtime', revision: undefined, candidate: undefined, info: { status: 'ready' } } });
    expect(onEvent).toHaveBeenCalledTimes(deliveredEvents);
    expect(onCheckpoint).toHaveBeenCalledTimes(deliveredCheckpoints);
    expect(mocks.runProductionScenario).not.toHaveBeenCalled();
  });

  it('disposes cache acceptance through its abort owner and rejects late callbacks without a prior interrupt', async () => {
    const planning = partialRunWithProbeDownloadEvidence({ exactRevision: 'd'.repeat(40) });
    const sidecars = [{ path: 'config.json', blob: new Blob(['{}']) }];
    mocks.wrap.mockReturnValueOnce(remote({ runPartialInvestigation: vi.fn(async (_request, _event, checkpoint) => {
      checkpoint({ run: planning, replayMetadata: sidecars });
      return planning;
    }) }));
    let runtimeSignal: AbortSignal | undefined;
    let lateProgress: RuntimeAcceptanceProgressCallback | undefined;
    mocks.completeRuntimeEvidence.mockImplementation(({ signal, onProgress }: { signal?: AbortSignal; onProgress?: RuntimeAcceptanceProgressCallback }) => {
      runtimeSignal = signal;
      lateProgress = onProgress;
      onProgress?.({ progress: { phase: 'runtime', revision: 'd'.repeat(40), candidate: undefined, info: { status: 'cache-acceptance-model-session' } } });
      return new Promise(() => undefined);
    });
    const onEvent = vi.fn();
    const onCheckpoint = vi.fn();
    const { createModelSupportInvestigationWorkerClient } = await import('./client-hosted');
    const client = createModelSupportInvestigationWorkerClient();
    const outcome = client.runPartialInvestigation({ modelId: 'org/model', configuration: modelLoadOnlyConfiguration(), onEvent, onCheckpoint }).catch(error => error);
    try {
      await vi.waitFor(() => expect(mocks.completeRuntimeEvidence).toHaveBeenCalledOnce());
      await client.dispose();
      expect(runtimeSignal?.aborted).toBe(true);
      expect(await outcome).toMatchObject({ name: 'ModelSupportInvestigationUserInterruptedError' });
      expect(onCheckpoint).toHaveBeenLastCalledWith({ checkpoint: expect.objectContaining({
        recovery: expect.objectContaining({ status: 'interrupted' }), replayMetadata: sidecars,
      }) });
      const events = onEvent.mock.calls.length;
      const checkpoints = onCheckpoint.mock.calls.length;
      lateProgress?.({ progress: { phase: 'runtime', revision: 'd'.repeat(40), candidate: undefined, info: { status: 'ready' } } });
      await client.dispose();
      expect(onEvent).toHaveBeenCalledTimes(events);
      expect(onCheckpoint).toHaveBeenCalledTimes(checkpoints);
      expect(mocks.runProductionScenario).not.toHaveBeenCalled();
    } finally {
      // Also close the pre-fix failing test's deliberately held operation.
      await client.interrupt();
      await outcome;
    }
  });

  it("aborts runtime-complete preparation and freezes an interrupted checkpoint when stopped", async () => {
    const planning = partialRunWithProbeDownloadEvidence({ exactRevision: "d".repeat(40) });
    const planningRemote = remote({ runPartialInvestigation: vi.fn(async () => planning) });
    mocks.wrap.mockReturnValueOnce(planningRemote);
    let runtimeSignal: AbortSignal | undefined;
    mocks.completeRuntimeEvidence.mockImplementation(({ signal }: { signal?: AbortSignal }) => {
      runtimeSignal = signal;
      return new Promise(() => undefined);
    });
    const onCheckpoint = vi.fn();

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const operation = client.runPartialInvestigation({ modelId: "org/model", configuration: modelLoadOnlyConfiguration(), onEvent: vi.fn(), onCheckpoint });
    await vi.waitFor(() => expect(mocks.completeRuntimeEvidence).toHaveBeenCalledTimes(1));

    await client.interrupt();
    await expect(operation).rejects.toMatchObject({ name: "ModelSupportInvestigationUserInterruptedError" });
    expect(runtimeSignal?.aborted).toBe(true);
    expect(onCheckpoint).toHaveBeenLastCalledWith({
      checkpoint: expect.objectContaining({
        recovery: expect.objectContaining({ status: "interrupted" }),
      }),
    });
    expect(mocks.runProductionScenario).not.toHaveBeenCalled();
  });

});
