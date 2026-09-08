import { beforeEach, describe, expect, it, vi } from "vitest";
import { configurationForPreset, createDefaultInvestigationConfiguration } from '@/features/transformers-js/model-support-investigation/logic/investigation-config';
import type {
  IModelSupportInvestigationWorker,
  ModelSupportInvestigationLoadAttempt,
  ModelSupportInvestigationLoadAttemptCheckpoint,
  ModelSupportInvestigationPlanningWorkerRun,
  ModelSupportInvestigationRun,
} from "@/features/transformers-js/model-support-investigation/types";
import { toPlanningWorkerRun } from "@/features/transformers-js/model-support-investigation/logic/planning-worker-run";
import type {
  ITransformersJsWorker,
  TransformersJsModelLoadProgressObservation,
  TransformersJsProductionInvestigationCandidate,
  TransformersJsProductionInvestigationPartialObservation,
} from "@/features/transformers-js/types";

const mocks = vi.hoisted(() => ({
  releaseProxy: Symbol("releaseProxy"),
  proxy: vi.fn((value: unknown) => value),
  wrap: vi.fn(),
  workerInstances: [] as Array<{ terminate: ReturnType<typeof vi.fn> }>,
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


class MockWorker {
  terminate = vi.fn();

  constructor() {
    mocks.workerInstances.push(this);
  }
}

vi.stubGlobal("Worker", MockWorker);

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
    modelArtifactObservations: [],
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


function productionLoadProgress({
  candidateId = "production-webgpu-q4f16",
  eventCount = 100_000,
  publishedSampleCount = 2,
}: {
  candidateId?: string,
  eventCount?: number,
  publishedSampleCount?: number,
} = {}): TransformersJsModelLoadProgressObservation {
  return {
    kind: "model-load",
    artifactSource: "downloaded-model-cache",
    candidateId,
    sourceStatus: "progress",
    currentFile: "onnx/model_q4f16.onnx_data",
    fileLoaded: 64 * 1024 * 1024,
    fileTotal: 256 * 1024 * 1024,
    fileProgress: 25,
    aggregateLoaded: 64 * 1024 * 1024,
    aggregateTotal: 256 * 1024 * 1024,
    aggregateProgress: 25,
    eventCount,
    progressEventCount: eventCount,
    progressTotalEventCount: eventCount,
    forwardProgressCount: eventCount,
    repeatedWithoutForwardProgressCount: 0,
    publishedSampleCount,
    firstActivityAt: "2026-08-06T00:00:02.000Z",
    lastActivityAt: "2026-08-06T00:00:08.000Z",
    lastForwardProgressAt: "2026-08-06T00:00:08.000Z",
  };
}

function productionRemote() {
  return {
    runModelSupportInvestigationScenario: mocks.runProductionScenario,
    [mocks.releaseProxy]: vi.fn(async () => undefined),
  };
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
    mocks.workerInstances.length = 0;
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "coordinator-attempt") });
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
    const production = productionRemote();
    mocks.wrap
      .mockReturnValueOnce(planningRemote)
      .mockReturnValueOnce(firstAttemptRemote)
      .mockReturnValueOnce(secondAttemptRemote)
      .mockReturnValueOnce(production);

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const result = await client.runPartialInvestigation({ modelId: "org/model", configuration: createDefaultInvestigationConfiguration(), onEvent: vi.fn(), onCheckpoint: vi.fn() });

    expect(mocks.workerInstances).toHaveLength(4);
    expect(mocks.workerInstances.every(instance => instance.terminate.mock.calls.length === 1)).toBe(true);
    expect(planningRemote.runPartialInvestigation).toHaveBeenCalledWith(
      { modelId: "org/model", externalNetworkPolicy: "allow", executionPlan: { repositoryDownload: true, modelLoad: true, generation: true, continuity: true, capabilityProbes: true } },
      expect.any(Function),
      expect.any(Function),
    );
    expect(firstAttemptRemote.runCandidateAttempt).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ candidateId: "webgpu-q4f16" }),
      expect.objectContaining({ generation: true, capabilityProbes: true }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(secondAttemptRemote.runCandidateAttempt).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ candidateId: "webgpu-q4" }),
      expect.objectContaining({ generation: true, capabilityProbes: true }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(result.loadAttempts.map(item => item.candidateId)).toEqual(["webgpu-q4f16", "webgpu-q4"]);
    expect(result.steps.find(step => step.id === "loading-investigation")?.status).toBe("passed");
    expect(result.productionLane.status).toBe("passed");
    expect(result.laneComparison).toMatchObject({ exactInputMatch: true });
    expect(mocks.runProductionScenario).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedRevision: "a".repeat(40),
        loadRevision: undefined,
        candidates: [
          { device: "webgpu", dtype: "q4" },
        ],
        messages: [{ role: "user", content: "hello" }],
      }),
      expect.any(Function),
      expect.any(Function),
    );
    expect(mocks.workerInstances[2]?.terminate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runProductionScenario.mock.invocationCallOrder[0]!,
    );
    expect(production[mocks.releaseProxy]).toHaveBeenCalledTimes(1);

    await client.dispose();
    expect(mocks.workerInstances).toHaveLength(4);
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
    const production = productionRemote();
    production[mocks.releaseProxy] = vi.fn(async () => {
      throw new Error("production release failed");
    });
    mocks.wrap
      .mockReturnValueOnce(planningRemote)
      .mockReturnValueOnce(attemptRemote)
      .mockReturnValueOnce(production);

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const result = await client.runPartialInvestigation({
      modelId: "org/model",
      configuration: createDefaultInvestigationConfiguration(),
      onEvent: vi.fn(),
      onCheckpoint: vi.fn(),
    });

    expect(result.status).toBe("passed");
    expect(result.productionLane.status).toBe("passed");
    expect(planningRemote[mocks.releaseProxy]).toHaveBeenCalledTimes(1);
    expect(production[mocks.releaseProxy]).toHaveBeenCalledTimes(1);
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

  it("runs a complete local cache through Reference and Production with external network denied and no runtime download preparation", async () => {
    const planning = localPlanningRun({ complete: true });
    const planningRemote = remote({
      runPartialInvestigation: vi.fn(async () => planning),
    });
    const attemptRemote = remote({
      runCandidateAttempt: vi.fn(async () => ({
        ...attempt({ candidateId: "webgpu-q4", status: "passed" }),
        resolvedRevision: "b".repeat(40),
        loaderRevisionOption: "b".repeat(40),
      })),
    });
    const production = productionRemote();
    mocks.wrap
      .mockReturnValueOnce(planningRemote)
      .mockReturnValueOnce(attemptRemote)
      .mockReturnValueOnce(production);

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const configuration = createDefaultInvestigationConfiguration();
    configuration.externalNetworkPolicy = "deny";
    const result = await client.runPartialInvestigation({
      modelId: "org/model",
      configuration,
      onEvent: vi.fn(),
      onCheckpoint: vi.fn(),
    });

    expect(planningRemote.runPartialInvestigation).toHaveBeenCalledWith(
      { modelId: "org/model", externalNetworkPolicy: "deny", executionPlan: { repositoryDownload: true, modelLoad: true, generation: true, continuity: true, capabilityProbes: true } },
      expect.any(Function),
      expect.any(Function),
    );
    expect(mocks.completeRuntimeEvidence).not.toHaveBeenCalled();
    expect(attemptRemote.runCandidateAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "local-cache",
        evidenceRevision: "b".repeat(40),
        loaderRevisionOption: "b".repeat(40),
      }),
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ candidateId: "webgpu-q4" }),
      expect.objectContaining({ generation: true, capabilityProbes: true }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(mocks.runProductionScenario).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "org/model",
        resolvedRevision: "b".repeat(40),
        loadRevision: "b".repeat(40),
        candidates: [{ device: "webgpu", dtype: "q4" }],
      }),
      expect.any(Function),
      expect.any(Function),
    );
    expect(result.steps.find(step => step.id === "repository-information")?.status).toBe("skipped");
    expect(result.steps.find(step => step.id === "download-evidence")?.status).toBe("skipped");
    expect(result.steps.find(step => step.id === "loading-investigation")?.status).toBe("passed");
    expect(result.steps.find(step => step.id === "lane-comparison")?.status).toBe("passed");
    expect(result.productionLane.status).toBe("passed");
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
      { modelId: "org/model", externalNetworkPolicy: "allow", executionPlan: { repositoryDownload: true, modelLoad: false, generation: false, continuity: false, capabilityProbes: false } },
      expect.any(Function),
      expect.any(Function),
    );
    expect(mocks.completeRuntimeEvidence).not.toHaveBeenCalled();
    expect(mocks.runProductionScenario).not.toHaveBeenCalled();
    expect(mocks.workerInstances).toHaveLength(1);
    expect(result.loadAttempts).toEqual([]);
    expect(result.steps.find(step => step.id === "download-evidence")).toMatchObject({
      status: "passed",
      detail: expect.stringContaining("Probe-only Download Evidence"),
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
      { modelId: "org/model", externalNetworkPolicy: "deny", executionPlan: { repositoryDownload: false, modelLoad: true, generation: false, continuity: false, capabilityProbes: false } },
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
    const planning = localPlanningRun({ complete: true });
    const planningRemote = remote({
      runPartialInvestigation: vi.fn(async () => planning),
    });
    const attemptRemote = remote({
      runCandidateAttempt: vi.fn(async () => ({
        ...attempt({ candidateId: "webgpu-q4", status: "passed" }),
        resolvedRevision: "b".repeat(40),
        loaderRevisionOption: "b".repeat(40),
      })),
    });
    const production = productionRemote();
    mocks.wrap
      .mockReturnValueOnce(planningRemote)
      .mockReturnValueOnce(attemptRemote)
      .mockReturnValueOnce(production);

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const configuration = createDefaultInvestigationConfiguration();
    configuration.externalNetworkPolicy = "deny";
    configuration.scope = {
      "repository-download": "not-selected",
      "model-load": "not-selected",
      generation: "selected",
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
      { modelId: "org/model", externalNetworkPolicy: "deny", executionPlan: { repositoryDownload: false, modelLoad: true, generation: true, continuity: false, capabilityProbes: false } },
      expect.any(Function),
      expect.any(Function),
    );
    expect(attemptRemote.runCandidateAttempt).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ candidateId: "webgpu-q4" }),
      { generation: true, capabilityProbes: false },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(mocks.runProductionScenario).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "org/model",
        runContinuity: false,
        runCapabilityProbes: false,
      }),
      expect.any(Function),
      expect.any(Function),
    );
    expect(result.steps.find(step => step.id === "loading-investigation")?.status).toBe("passed");
    expect(result.steps.find(step => step.id === "lane-comparison")?.status).toBe("passed");
    expect(result.productionLane.status).toBe("passed");
    expect(result.requestedConfiguration).toEqual(configuration);
    expect(result.executionPlan).toEqual({
      repositoryDownload: false,
      modelLoad: true,
      generation: true,
      continuity: false,
      capabilityProbes: false,
    });
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
    const planning = localPlanningRun({ complete: true });
    const planningRemote = remote({
      runPartialInvestigation: vi.fn(async () => planning),
    });
    const attemptRemote = remote({
      runCandidateAttempt: vi.fn(async () => ({
        ...attempt({ candidateId: "webgpu-q4", status: "passed" }),
        resolvedRevision: "b".repeat(40),
        loaderRevisionOption: "b".repeat(40),
      })),
    });
    const production = productionRemote();
    mocks.wrap
      .mockReturnValueOnce(planningRemote)
      .mockReturnValueOnce(attemptRemote)
      .mockReturnValueOnce(production);

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const configuration = createDefaultInvestigationConfiguration();
    configuration.externalNetworkPolicy = "deny";
    configuration.scope = {
      "repository-download": "not-selected",
      "model-load": "not-selected",
      generation: "not-selected",
      continuity: selectedScope === "continuity" ? "selected" : "not-selected",
      "capability-probes": selectedScope === "capability-probes" ? "selected" : "not-selected",
    };

    const result = await client.runPartialInvestigation({
      modelId: "org/model",
      configuration,
      onEvent: vi.fn(),
      onCheckpoint: vi.fn(),
    });

    expect(attemptRemote.runCandidateAttempt).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ candidateId: "webgpu-q4" }),
      { generation: true, capabilityProbes: expectedCapabilityProbes },
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(mocks.runProductionScenario).toHaveBeenCalledWith(
      expect.objectContaining({
        runContinuity: expectedContinuity,
        runCapabilityProbes: expectedCapabilityProbes,
      }),
      expect.any(Function),
      expect.any(Function),
    );
    expect(result.executionPlan).toEqual({
      repositoryDownload: false,
      modelLoad: true,
      generation: true,
      continuity: expectedContinuity,
      capabilityProbes: expectedCapabilityProbes,
    });
  });

  it("blocks Model Load and Production for an incomplete local cache without external network or model download preparation", async () => {
    const planning = localPlanningRun({ complete: false });
    const planningRemote = remote({
      runPartialInvestigation: vi.fn(async () => planning),
    });
    mocks.wrap.mockReturnValueOnce(planningRemote);

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const configuration = createDefaultInvestigationConfiguration();
    configuration.externalNetworkPolicy = "deny";
    const result = await client.runPartialInvestigation({
      modelId: "org/model",
      configuration,
      onEvent: vi.fn(),
      onCheckpoint: vi.fn(),
    });

    expect(planningRemote.runPartialInvestigation).toHaveBeenCalledWith(
      { modelId: "org/model", externalNetworkPolicy: "deny", executionPlan: { repositoryDownload: true, modelLoad: true, generation: true, continuity: true, capabilityProbes: true } },
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
    expect(result.steps.find(step => step.id === "lane-comparison")?.status).toBe("blocked");
    expect(result.productionLane.status).toBe("not-run");
    expect(result.error).toBeUndefined();
  });

  it("retries a failed Production load candidate in a fresh Worker and preserves both load attempts", async () => {
    const planningRemote = remote({
      runPartialInvestigation: vi.fn(async () => planningRun()),
    });
    const successfulAttemptRemote = remote({
      runCandidateAttempt: vi.fn(async () => attempt({ candidateId: "webgpu-q4f16", status: "passed" })),
    });
    const firstProduction = productionRemote();
    const secondProduction = productionRemote();
    const defaultObservation = await mocks.runProductionScenario();
    mocks.runProductionScenario.mockReset();
    mocks.wrap
      .mockReturnValueOnce(planningRemote)
      .mockReturnValueOnce(successfulAttemptRemote)
      .mockReturnValueOnce(firstProduction)
      .mockReturnValueOnce(secondProduction);
    mocks.runProductionScenario
      .mockImplementationOnce(async (scenario, _progressCallback, observationCheckpointCallback) => {
        const failedAttempt = {
          candidate: structuredClone(scenario.candidates[0]),
          status: "failed" as const,
          error: { name: "Error", message: "q4f16 production load failed", stack: "load-stack" },
        };
        observationCheckpointCallback({
          observation: {
            modelId: scenario.modelId,
            resolvedRevision: scenario.resolvedRevision,
            candidate: undefined,
            loadAttempts: [failedAttempt],
            route: undefined,
            isEncoderDecoder: undefined,
            firstTurn: undefined,
            continuity: undefined,
            toolResultContinuation: undefined,
            reasoning: undefined,
            multimodal: undefined,
          },
        });
        throw new Error("q4f16 production load failed");
      })
      .mockImplementationOnce(async (scenario) => ({
        ...defaultObservation,
        candidate: structuredClone(scenario.candidates[0]),
        loadAttempts: [{
          candidate: structuredClone(scenario.candidates[0]),
          status: "passed" as const,
          error: undefined,
        }],
      }));
    const onCheckpoint = vi.fn();

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const result = await client.runPartialInvestigation({ modelId: "org/model", configuration: createDefaultInvestigationConfiguration(), onEvent: vi.fn(), onCheckpoint });

    expect(mocks.runProductionScenario).toHaveBeenCalledTimes(2);
    expect(mocks.runProductionScenario.mock.calls[0]?.[0].candidates).toEqual([
      { device: "webgpu", dtype: "q4f16" },
    ]);
    expect(mocks.runProductionScenario.mock.calls[1]?.[0].candidates).toEqual([
      { device: "webgpu", dtype: "q4" },
    ]);
    expect(mocks.workerInstances).toHaveLength(4);
    expect(mocks.workerInstances[2]?.terminate).toHaveBeenCalledTimes(1);
    expect(mocks.workerInstances[3]?.terminate).toHaveBeenCalledTimes(1);
    expect(result.productionLane.status).toBe("passed");
    expect(result.productionLane.observation?.loadAttempts).toEqual([
      {
        candidate: { device: "webgpu", dtype: "q4f16" },
        status: "failed",
        error: { name: "Error", message: "q4f16 production load failed", stack: "load-stack" },
      },
      {
        candidate: { device: "webgpu", dtype: "q4" },
        status: "passed",
        error: undefined,
      },
    ]);
    expect(onCheckpoint).toHaveBeenCalledWith({
      checkpoint: expect.objectContaining({
        run: expect.objectContaining({
          productionLane: expect.objectContaining({
            status: "running",
            partialObservation: expect.objectContaining({
              loadAttempts: [expect.objectContaining({
                candidate: { device: "webgpu", dtype: "q4f16" },
                status: "failed",
              })],
            }),
          }),
        }),
      }),
    });

    await client.dispose();
  });

  it("uses a fresh Production Worker for every failed load candidate and preserves all failures", async () => {
    const planningRemote = remote({
      runPartialInvestigation: vi.fn(async () => planningRun()),
    });
    const successfulAttemptRemote = remote({
      runCandidateAttempt: vi.fn(async () => attempt({ candidateId: "webgpu-q4f16", status: "passed" })),
    });
    const firstProduction = productionRemote();
    const secondProduction = productionRemote();
    const thirdProduction = productionRemote();
    mocks.wrap
      .mockReturnValueOnce(planningRemote)
      .mockReturnValueOnce(successfulAttemptRemote)
      .mockReturnValueOnce(firstProduction)
      .mockReturnValueOnce(secondProduction)
      .mockReturnValueOnce(thirdProduction);
    mocks.runProductionScenario.mockImplementation(async (scenario, _progressCallback, observationCheckpointCallback) => {
      const candidate: TransformersJsProductionInvestigationCandidate = structuredClone(scenario.candidates[0]);
      const message = `${candidate.device}/${candidate.dtype} production load failed`;
      observationCheckpointCallback({
        observation: {
          modelId: scenario.modelId,
          resolvedRevision: scenario.resolvedRevision,
          candidate: undefined,
          loadAttempts: [{
            candidate,
            status: "failed",
            error: { name: "Error", message, stack: `${candidate.device}-${candidate.dtype}-stack` },
          }],
          route: undefined,
          isEncoderDecoder: undefined,
          firstTurn: undefined,
          continuity: undefined,
          toolResultContinuation: undefined,
          reasoning: undefined,
          multimodal: undefined,
        },
      });
      throw new Error(message);
    });

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const result = await client.runPartialInvestigation({ modelId: "org/model", configuration: createDefaultInvestigationConfiguration(), onEvent: vi.fn(), onCheckpoint: vi.fn() });

    expect(mocks.runProductionScenario).toHaveBeenCalledTimes(3);
    expect(mocks.runProductionScenario.mock.calls.map(call => call[0].candidates)).toEqual([
      [{ device: "webgpu", dtype: "q4f16" }],
      [{ device: "webgpu", dtype: "q4" }],
      [{ device: "wasm", dtype: "q4" }],
    ]);
    expect(mocks.workerInstances).toHaveLength(5);
    expect(mocks.workerInstances.slice(2).every(instance => instance.terminate.mock.calls.length === 1)).toBe(true);
    expect(result.productionLane.status).toBe("failed");
    expect(result.productionLane.partialObservation?.loadAttempts).toEqual([
      expect.objectContaining({ candidate: { device: "webgpu", dtype: "q4f16" }, status: "failed" }),
      expect.objectContaining({ candidate: { device: "webgpu", dtype: "q4" }, status: "failed" }),
      expect.objectContaining({ candidate: { device: "wasm", dtype: "q4" }, status: "failed" }),
    ]);

    await client.dispose();
  });

  it("ignores late Comlink callbacks after each remote phase has completed", async () => {
    type PlanningArgs = Parameters<IModelSupportInvestigationWorker["runPartialInvestigation"]>;
    type CandidateArgs = Parameters<IModelSupportInvestigationWorker["runCandidateAttempt"]>;
    type ProductionArgs = Parameters<ITransformersJsWorker["runModelSupportInvestigationScenario"]>;
    let latePlanningEvent: PlanningArgs[1] | undefined;
    let latePlanningCheckpoint: PlanningArgs[2] | undefined;
    let lateCandidateEvent: CandidateArgs[6] | undefined;
    let lateCandidateCheckpoint: CandidateArgs[7] | undefined;
    let lateProductionProgress: ProductionArgs[1] | undefined;
    let lateProductionCheckpoint: ProductionArgs[2] | undefined;

    const planningRemote = remote({
      runPartialInvestigation: vi.fn(async (_modelId, onEvent, onRunCheckpoint) => {
        latePlanningEvent = onEvent;
        latePlanningCheckpoint = onRunCheckpoint;
        return planningRun();
      }),
    });
    const successfulAttemptRemote = remote({
      runCandidateAttempt: vi.fn(async (_runtimeTarget, _declarations, _templateBehavior, _candidate, _executionOptions, _onEvent, onAttemptEvent, onAttemptCheckpoint) => {
        lateCandidateEvent = onAttemptEvent;
        lateCandidateCheckpoint = onAttemptCheckpoint;
        return attempt({ candidateId: "webgpu-q4f16", status: "passed" });
      }),
    });
    const production = productionRemote();
    const productionObservation = await mocks.runProductionScenario();
    mocks.runProductionScenario.mockClear();
    mocks.runProductionScenario.mockImplementation(async (_scenario, progressCallback, observationCheckpointCallback) => {
      lateProductionProgress = progressCallback;
      lateProductionCheckpoint = observationCheckpointCallback;
      return productionObservation;
    });
    mocks.wrap
      .mockReturnValueOnce(planningRemote)
      .mockReturnValueOnce(successfulAttemptRemote)
      .mockReturnValueOnce(production);
    const onEvent = vi.fn();
    const onCheckpoint = vi.fn();

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const result = await client.runPartialInvestigation({ modelId: "org/model", configuration: createDefaultInvestigationConfiguration(), onEvent, onCheckpoint });
    expect(result.productionLane.status).toBe("passed");
    const eventCount = onEvent.mock.calls.length;
    const checkpointCount = onCheckpoint.mock.calls.length;

    latePlanningEvent?.({
      event: { stepId: "repository-information", status: "running", detail: "stale planning event" },
    });
    latePlanningCheckpoint?.({
      run: { ...planningRun(), currentOperation: "stale planning checkpoint" },
    });
    lateCandidateEvent?.({
      event: {
        stage: "model-load",
        status: "running",
        detail: "stale candidate event",
        at: "2026-08-31T00:00:00.000Z",
      },
    });
    lateCandidateCheckpoint?.({ attempt: attemptCheckpoint({ candidateId: "webgpu-q4f16" }) });
    lateProductionProgress?.({ event: { kind: "stage", status: "model-support-production-first-turn" } });
    lateProductionCheckpoint?.({
      observation: productionObservation as TransformersJsProductionInvestigationPartialObservation,
    });

    expect(onEvent).toHaveBeenCalledTimes(eventCount);
    expect(onCheckpoint).toHaveBeenCalledTimes(checkpointCount);
    expect(onCheckpoint.mock.calls.at(-1)?.[0].checkpoint.recovery.status).toBe("completed");
    await client.dispose();
  });

  it("does not misclassify a Production worker-start timeout as a candidate load failure", async () => {
    vi.useFakeTimers();
    try {
      const planningRemote = remote({
        runPartialInvestigation: vi.fn(async () => planningRun()),
      });
      const successfulAttemptRemote = remote({
        runCandidateAttempt: vi.fn(async () => attempt({ candidateId: "webgpu-q4f16", status: "passed" })),
      });
      const production = productionRemote();
      mocks.wrap
        .mockReturnValueOnce(planningRemote)
        .mockReturnValueOnce(successfulAttemptRemote)
        .mockReturnValueOnce(production);
      mocks.runProductionScenario.mockImplementation(() => new Promise(() => undefined));

      const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
      const client = createModelSupportInvestigationWorkerClient({ productionLaneTimeoutMs: 10 });
      const operation = client.runPartialInvestigation({ modelId: "org/model", configuration: createDefaultInvestigationConfiguration(), onEvent: vi.fn(), onCheckpoint: vi.fn() });
      await vi.advanceTimersByTimeAsync(10);
      const result = await operation;

      expect(mocks.runProductionScenario).toHaveBeenCalledTimes(1);
      expect(result.productionLane).toMatchObject({
        status: "failed",
        error: {
          name: "ProductionLaneTimeoutError",
          message: expect.stringContaining("worker-start"),
        },
      });
      expect(result.productionLane.partialObservation).toBeUndefined();
      expect(mocks.workerInstances).toHaveLength(3);
      expect(mocks.workerInstances[2]?.terminate).toHaveBeenCalledTimes(1);

      await client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates a timed-out Production Worker without waiting for Comlink disposal", async () => {
    vi.useFakeTimers();
    try {
      const planningRemote = remote({
        runPartialInvestigation: vi.fn(async () => planningRun()),
      });
      const successfulAttemptRemote = remote({
        runCandidateAttempt: vi.fn(async () => attempt({ candidateId: "webgpu-q4f16", status: "passed" })),
      });
      const production = productionRemote();
      mocks.wrap
        .mockReturnValueOnce(planningRemote)
        .mockReturnValueOnce(successfulAttemptRemote)
        .mockReturnValueOnce(production);
      mocks.runProductionScenario.mockImplementation((_scenario, progressCallback) => {
        progressCallback({ event: { kind: "stage", status: "model-support-production-tool-result-continuation" } });
        return new Promise(() => undefined);
      });
      const onEvent = vi.fn();

      const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
      const client = createModelSupportInvestigationWorkerClient({ productionLaneTimeoutMs: 10 });
      const operation = client.runPartialInvestigation({ modelId: "org/model", configuration: createDefaultInvestigationConfiguration(), onEvent, onCheckpoint: vi.fn() });
      await vi.advanceTimersByTimeAsync(10);
      const result = await operation;

      expect(result.productionLane).toMatchObject({
        status: "failed",
        error: {
          name: "ProductionLaneTimeoutError",
          message: expect.stringContaining("tool-result-continuation"),
        },
      });
      expect(mocks.workerInstances[2]?.terminate).toHaveBeenCalledTimes(1);
      expect(production[mocks.releaseProxy]).not.toHaveBeenCalled();
      expect(onEvent).toHaveBeenCalledWith({
        event: expect.objectContaining({
          stepId: "lane-comparison",
          detail: "Production Lane webgpu/q4f16 timed out at tool-result-continuation",
        }),
      });

      await client.dispose();
      expect(mocks.workerInstances[2]?.terminate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates an active Production Worker when the investigation client is disposed", async () => {
    const planningRemote = remote({
      runPartialInvestigation: vi.fn(async () => planningRun()),
    });
    const successfulAttemptRemote = remote({
      runCandidateAttempt: vi.fn(async () => attempt({ candidateId: "webgpu-q4f16", status: "passed" })),
    });
    const production = productionRemote();
    mocks.wrap
      .mockReturnValueOnce(planningRemote)
      .mockReturnValueOnce(successfulAttemptRemote)
      .mockReturnValueOnce(production);
    mocks.runProductionScenario.mockImplementation(
      () => new Promise(() => undefined),
    );

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    void client.runPartialInvestigation({ modelId: "org/model", configuration: createDefaultInvestigationConfiguration(), onEvent: vi.fn(), onCheckpoint: vi.fn() });
    await vi.waitFor(() => {
      expect(mocks.runProductionScenario).toHaveBeenCalledTimes(1);
    });

    await client.dispose();

    expect(mocks.workerInstances[2]?.terminate).toHaveBeenCalledTimes(1);
    expect(production[mocks.releaseProxy]).not.toHaveBeenCalled();
  });

  it("interrupts a hung Production Worker without waiting for its remote Promise", async () => {
    const planningRemote = remote({
      runPartialInvestigation: vi.fn(async () => planningRun()),
    });
    const successfulAttemptRemote = remote({
      runCandidateAttempt: vi.fn(async () => attempt({ candidateId: "webgpu-q4f16", status: "passed" })),
    });
    const production = productionRemote();
    mocks.wrap
      .mockReturnValueOnce(planningRemote)
      .mockReturnValueOnce(successfulAttemptRemote)
      .mockReturnValueOnce(production);
    mocks.runProductionScenario.mockImplementation(() => new Promise(() => undefined));
    const onCheckpoint = vi.fn();

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const operation = client.runPartialInvestigation({ modelId: "org/model", configuration: createDefaultInvestigationConfiguration(), onEvent: vi.fn(), onCheckpoint });
    await vi.waitFor(() => {
      expect(mocks.runProductionScenario).toHaveBeenCalledTimes(1);
    });

    await client.interrupt();
    await expect(operation).rejects.toMatchObject({ name: "ModelSupportInvestigationUserInterruptedError" });
    expect(mocks.workerInstances[2]?.terminate).toHaveBeenCalledTimes(1);
    expect(production[mocks.releaseProxy]).not.toHaveBeenCalled();
    expect(onCheckpoint).toHaveBeenLastCalledWith({
      checkpoint: expect.objectContaining({
        recovery: expect.objectContaining({ status: "interrupted" }),
      }),
    });
  });

  it("preserves active Production load telemetry when interrupted and ignores late callbacks", async () => {
    const planningRemote = remote({
      runPartialInvestigation: vi.fn(async () => planningRun()),
    });
    const successfulAttemptRemote = remote({
      runCandidateAttempt: vi.fn(async () => attempt({ candidateId: "webgpu-q4f16", status: "passed" })),
    });
    const production = productionRemote();
    mocks.wrap
      .mockReturnValueOnce(planningRemote)
      .mockReturnValueOnce(successfulAttemptRemote)
      .mockReturnValueOnce(production);

    type ProductionArgs = Parameters<ITransformersJsWorker["runModelSupportInvestigationScenario"]>;
    let lateProgress: ProductionArgs[1] | undefined;
    let lateCheckpoint: ProductionArgs[2] | undefined;
    const boundedProgress = productionLoadProgress();
    mocks.runProductionScenario.mockImplementation((_scenario, progressCallback, observationCheckpointCallback) => {
      lateProgress = progressCallback;
      lateCheckpoint = observationCheckpointCallback;
      progressCallback({ event: { kind: "model-load", progress: boundedProgress } });
      observationCheckpointCallback({
        observation: {
          modelId: "org/model",
          resolvedRevision: "a".repeat(40),
          loaderRevisionOption: null,
          runtimeLoadDurationMs: undefined,
          candidate: undefined,
          loadAttempts: [],
          activeLoadAttempt: {
            candidate: { device: "webgpu", dtype: "q4f16" },
            status: "running",
            modelLoadDurationMs: 6_000,
            modelLoadProgress: boundedProgress,
          },
          route: undefined,
          isEncoderDecoder: undefined,
          firstTurn: undefined,
          continuity: undefined,
          toolResultContinuation: undefined,
          reasoning: undefined,
          multimodal: undefined,
        },
      });
      return new Promise(() => undefined);
    });
    const onCheckpoint = vi.fn();

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const operation = client.runPartialInvestigation({ modelId: "org/model", configuration: createDefaultInvestigationConfiguration(), onEvent: vi.fn(), onCheckpoint });
    await vi.waitFor(() => {
      expect(mocks.runProductionScenario).toHaveBeenCalledTimes(1);
      expect(onCheckpoint.mock.calls.some(([value]) => (
        value.checkpoint.run.productionLane.partialObservation?.activeLoadAttempt?.modelLoadProgress?.eventCount === 100_000
      ))).toBe(true);
    });

    await client.interrupt();
    await expect(operation).rejects.toMatchObject({ name: "ModelSupportInvestigationUserInterruptedError" });
    expect(mocks.workerInstances[2]?.terminate).toHaveBeenCalledTimes(1);
    const interruptedCheckpoint = onCheckpoint.mock.calls.at(-1)?.[0]?.checkpoint;
    expect(interruptedCheckpoint).toMatchObject({
      recovery: { status: "interrupted" },
      run: {
        productionLane: {
          status: "running",
          partialObservation: {
            activeLoadAttempt: {
              candidate: { device: "webgpu", dtype: "q4f16" },
              status: "running",
              modelLoadDurationMs: 6_000,
              modelLoadProgress: { eventCount: 100_000, publishedSampleCount: 2 },
            },
          },
        },
      },
    });

    const checkpointCountAfterInterrupt = onCheckpoint.mock.calls.length;
    lateProgress?.({
      event: {
        kind: "model-load",
        progress: productionLoadProgress({ eventCount: 999_999, publishedSampleCount: 999 }),
      },
    });
    lateCheckpoint?.({
      observation: {
        ...(interruptedCheckpoint?.run.productionLane.partialObservation ?? {}),
        activeLoadAttempt: {
          candidate: { device: "webgpu", dtype: "q4f16" },
          status: "running",
          modelLoadProgress: productionLoadProgress({ eventCount: 999_999, publishedSampleCount: 999 }),
        },
      } as TransformersJsProductionInvestigationPartialObservation,
    });
    expect(onCheckpoint).toHaveBeenCalledTimes(checkpointCountAfterInterrupt);
    expect(onCheckpoint.mock.calls.at(-1)?.[0]?.checkpoint.run.productionLane.partialObservation?.activeLoadAttempt?.modelLoadProgress).toMatchObject({
      eventCount: 100_000,
      publishedSampleCount: 2,
    });
  });

  it("does not misclassify tokenizer runtime preparation as an active Production model load when interrupted", async () => {
    const planningRemote = remote({
      runPartialInvestigation: vi.fn(async () => planningRun()),
    });
    const successfulAttemptRemote = remote({
      runCandidateAttempt: vi.fn(async () => attempt({ candidateId: "webgpu-q4f16", status: "passed" })),
    });
    const production = productionRemote();
    mocks.wrap
      .mockReturnValueOnce(planningRemote)
      .mockReturnValueOnce(successfulAttemptRemote)
      .mockReturnValueOnce(production);

    const candidateProgress = productionLoadProgress();
    const tokenizerProgress = productionLoadProgress({ eventCount: 3, publishedSampleCount: 1 });
    mocks.runProductionScenario.mockImplementation((_scenario, progressCallback, observationCheckpointCallback) => {
      progressCallback({ event: { kind: "stage", status: "model-support-production-model-load" } });
      progressCallback({ event: { kind: "model-load", progress: candidateProgress } });
      observationCheckpointCallback({
        observation: {
          modelId: "org/model",
          resolvedRevision: "a".repeat(40),
          loaderRevisionOption: null,
          runtimeLoadDurationMs: undefined,
          candidate: { device: "webgpu", dtype: "q4f16" },
          loadAttempts: [{
            candidate: { device: "webgpu", dtype: "q4f16" },
            status: "passed",
            modelLoadDurationMs: 6_000,
            modelLoadProgress: candidateProgress,
            error: undefined,
          }],
          activeLoadAttempt: undefined,
          route: undefined,
          isEncoderDecoder: undefined,
          firstTurn: undefined,
          continuity: undefined,
          toolResultContinuation: undefined,
          reasoning: undefined,
          multimodal: undefined,
        },
      });
      progressCallback({ event: { kind: "stage", status: "model-support-production-runtime-preparation" } });
      progressCallback({ event: { kind: "model-load", progress: tokenizerProgress } });
      return new Promise(() => undefined);
    });
    const onCheckpoint = vi.fn();

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const operation = client.runPartialInvestigation({ modelId: "org/model", configuration: createDefaultInvestigationConfiguration(), onEvent: vi.fn(), onCheckpoint });
    await vi.waitFor(() => {
      expect(mocks.runProductionScenario).toHaveBeenCalledTimes(1);
    });

    await client.interrupt();
    await expect(operation).rejects.toMatchObject({ name: "ModelSupportInvestigationUserInterruptedError" });
    const interruptedCheckpoint = onCheckpoint.mock.calls.at(-1)?.[0]?.checkpoint;
    expect(interruptedCheckpoint).toMatchObject({
      recovery: { status: "interrupted" },
      run: {
        productionLane: {
          partialObservation: {
            loadAttempts: [{
              candidate: { device: "webgpu", dtype: "q4f16" },
              status: "passed",
              modelLoadProgress: { eventCount: 100_000, publishedSampleCount: 2 },
            }],
          },
        },
      },
    });
    expect(interruptedCheckpoint?.run.productionLane.partialObservation?.activeLoadAttempt).toBeUndefined();
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
      const production = productionRemote();
      mocks.wrap
        .mockReturnValueOnce(planningRemote)
        .mockReturnValueOnce(timedOutAttemptRemote)
        .mockReturnValueOnce(successfulAttemptRemote)
        .mockReturnValueOnce(production);

      const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
      const client = createModelSupportInvestigationWorkerClient({ candidateAttemptTimeoutMs: 10 });
      const operation = client.runPartialInvestigation({ modelId: "org/model", configuration: createDefaultInvestigationConfiguration(), onEvent: vi.fn(), onCheckpoint: vi.fn() });
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
      expect(mocks.workerInstances).toHaveLength(4);
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


  it("hands one runtime-complete exact revision and selected candidate through template, Reference, and Production lanes", async () => {
    const exactRevision = "b".repeat(40);
    const planning = partialRunWithProbeDownloadEvidence({ exactRevision });
    planning.modelFilePlan = {
      normalizedModelId: "org/model",
      resolvedRevision: exactRevision,
      modelType: "lfm2",
      registrySource: "ModelRegistry.get_model_files",
      cacheRevisionProvenance: "unknown",
      cacheRevisionProvenanceReason: "fixture",
      candidates: [{
        candidateId: "webgpu-q4f16",
        device: "webgpu",
        dtype: "q4f16",
        eligibility: "ineligible",
        files: [{
          path: "onnx/model_q4f16.onnx",
          kind: "core-onnx",
          requirement: "required",
          repositorySize: undefined,
          cacheMatches: [],
        }],
      }, {
        candidateId: "webgpu-q4",
        device: "webgpu",
        dtype: "q4",
        eligibility: "eligible",
        files: [{
          path: "onnx/model_q4.onnx",
          kind: "core-onnx",
          requirement: "required",
          repositorySize: 10,
          cacheMatches: [{
            path: `resolve/${exactRevision}/onnx/model_q4.onnx`,
            size: 10,
            hasCompletionMarker: true,
          }],
        }],
      }, {
        candidateId: "wasm-q4",
        device: "wasm",
        dtype: "q4",
        eligibility: "eligible",
        files: [{
          path: "onnx/model_q4.onnx",
          kind: "core-onnx",
          requirement: "required",
          repositorySize: 10,
          cacheMatches: [{
            path: `resolve/${exactRevision}/onnx/model_q4.onnx`,
            size: 10,
            hasCompletionMarker: true,
          }],
        }],
      }],
    } as never;
    const completedEvidence = {
      ...planning.downloadEvidence,
      mode: "runtime-complete" as const,
      runtimeCompletion: {
        schemaVersion: 1 as const,
        status: "accepted" as const,
        source: "production-download-preparation" as const,
        repositoryResolvedRevision: exactRevision,
        cacheRevision: exactRevision,
        loaderRevisionOption: exactRevision,
        selectedCandidate: { device: "webgpu" as const, dtype: "q4" as const },
        cacheReuse: undefined,
        preparation: undefined,
        cacheAfter: undefined,
        cacheInspectionError: undefined,
        error: undefined,
      },
    };
    mocks.completeRuntimeEvidence.mockResolvedValue(completedEvidence);

    const planningRemote = remote({ runPartialInvestigation: vi.fn(async () => planning) });
    const templateBehavior = planning.templateBehavior!;
    const templateRemote = remote({
      inspectDownloadedTemplateBehavior: vi.fn(async () => templateBehavior),
    });
    const referenceAttempt = attempt({ candidateId: "webgpu-q4", status: "passed" });
    referenceAttempt.loaderRevisionOption = exactRevision;
    const attemptRemote = remote({
      runCandidateAttempt: vi.fn(async () => referenceAttempt),
    });
    const production = productionRemote();
    mocks.wrap
      .mockReturnValueOnce(planningRemote)
      .mockReturnValueOnce(templateRemote)
      .mockReturnValueOnce(attemptRemote)
      .mockReturnValueOnce(production);

    const { createModelSupportInvestigationWorkerClient } = await import("./client-hosted");
    const client = createModelSupportInvestigationWorkerClient();
    const result = await client.runPartialInvestigation({ modelId: "org/model", configuration: createDefaultInvestigationConfiguration(), onEvent: vi.fn(), onCheckpoint: vi.fn() });

    expect(mocks.completeRuntimeEvidence).toHaveBeenCalledTimes(1);
    expect(mocks.completeRuntimeEvidence).toHaveBeenCalledWith(expect.objectContaining({
      reusableCandidateOrderByRevision: {
        [exactRevision]: [
          { device: "webgpu", dtype: "q4" },
          { device: "wasm", dtype: "q4" },
        ],
        main: [],
      },
    }));
    expect(mocks.completeRuntimeEvidence.mock.calls[0]?.[0]).not.toHaveProperty('candidateOrder');
    expect(mocks.completeRuntimeEvidence.mock.calls[0]?.[0]).not.toHaveProperty('requiredModelPathsByCandidate');
    expect(templateRemote.inspectDownloadedTemplateBehavior).toHaveBeenCalledWith({
      runtimeTarget: expect.objectContaining({
        normalizedModelId: "org/model",
        evidenceRevision: exactRevision,
        loaderRevisionOption: exactRevision,
      }),
    });
    expect(attemptRemote.runCandidateAttempt).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      templateBehavior,
      expect.objectContaining({ candidateId: "webgpu-q4", device: "webgpu", dtype: "q4" }),
      expect.objectContaining({ generation: true, capabilityProbes: true }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(mocks.runProductionScenario).toHaveBeenCalledWith(
      expect.objectContaining({
        loadRevision: exactRevision,
        candidates: [{ device: "webgpu", dtype: "q4" }],
      }),
      expect.any(Function),
      expect.any(Function),
    );
    expect(result.downloadEvidence?.runtimeCompletion).toMatchObject({
      status: "accepted",
      loaderRevisionOption: exactRevision,
      selectedCandidate: { device: "webgpu", dtype: "q4" },
    });
    expect(result.loadAttempts.map(item => item.candidateId)).toEqual(["webgpu-q4"]);
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
    await client.runPartialInvestigation({ modelId: "org/model", configuration: createDefaultInvestigationConfiguration(), onEvent: vi.fn(), onCheckpoint: vi.fn() });

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
    const result = await client.runPartialInvestigation({ modelId: "org/model", configuration: createDefaultInvestigationConfiguration(), onEvent: vi.fn(), onCheckpoint: vi.fn() });

    expect(result.downloadEvidence?.runtimeCompletion).toMatchObject({
      status: "failed",
      error: { name: "RuntimeRejected", message: "runtime cache rejected" },
    });
    expect(result.steps.find(step => step.id === "download-evidence")).toMatchObject({ status: "failed" });
    expect(result.steps.find(step => step.id === "loading-investigation")).toMatchObject({ status: "blocked" });
    expect(result.steps.find(step => step.id === "lane-comparison")).toMatchObject({ status: "blocked" });
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
    const result = await client.runPartialInvestigation({ modelId: "org/model", configuration: createDefaultInvestigationConfiguration(), onEvent: vi.fn(), onCheckpoint: vi.fn() });

    expect(result.downloadEvidence?.runtimeCompletion).toMatchObject({
      status: "exhausted",
      source: "cache-only-unavailable",
    });
    expect(result.steps.find(step => step.id === "download-evidence")).toMatchObject({ status: "passed" });
    expect(result.steps.find(step => step.id === "loading-investigation")).toMatchObject({ status: "blocked" });
    expect(result.steps.find(step => step.id === "lane-comparison")).toMatchObject({ status: "blocked" });
    expect(result.loadAttempts).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(mocks.runProductionScenario).not.toHaveBeenCalled();
    expect(mocks.wrap).toHaveBeenCalledTimes(1);
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
    const operation = client.runPartialInvestigation({ modelId: "org/model", configuration: createDefaultInvestigationConfiguration(), onEvent: vi.fn(), onCheckpoint });
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
