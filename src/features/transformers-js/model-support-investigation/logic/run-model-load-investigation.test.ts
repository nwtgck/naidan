import { describe, expect, it, vi } from "vitest";
import type {
  ModelSupportInvestigationCandidateFilePlan,
  ModelSupportInvestigationLoadAttempt,
  ModelSupportInvestigationRun,
} from "@/features/transformers-js/model-support-investigation/types";
import { runModelLoadInvestigation } from "@/features/transformers-js/model-support-investigation/logic/run-model-load-investigation";

function candidate(candidateId: "webgpu-q4f16" | "webgpu-q4" | "wasm-q4"): ModelSupportInvestigationCandidateFilePlan {
  const [device, dtype] = candidateId === "webgpu-q4f16"
    ? ["webgpu", "q4f16"] as const
    : candidateId === "webgpu-q4"
      ? ["webgpu", "q4"] as const
      : ["wasm", "q4"] as const;
  return {
    candidateId,
    device,
    dtype,
    registryStatus: "planned",
    registryError: undefined,
    registryReturnedFileCount: 0,
    duplicatePaths: [],
    files: [],
    requiredFileCount: 0,
    optionalFileCount: 0,
    missingRequiredFileCount: 0,
    zeroByteRequiredFileCount: 0,
    missingOptionalFileCount: 0,
    cacheObservedRequiredFileCount: 0,
    cacheCompleteMarkerRequiredFileCount: 0,
    eligibility: "eligible",
    ineligibleReasons: [],
  };
}

function run({ supportedClass = true, candidates = [candidate("webgpu-q4f16"), candidate("webgpu-q4"), candidate("wasm-q4")] }: {
  supportedClass?: boolean,
  candidates?: ModelSupportInvestigationCandidateFilePlan[],
} = {}): ModelSupportInvestigationRun {
  return {
    schemaVersion: 1,
    runId: "run-fixture",
    modelId: "org/model",
    scope: "partial-runtime-repository-cache-declarations-template-model-files",
    startedAt: "before",
    completedAt: "before",
    status: "passed",
    currentOperation: "before",
    steps: [{ id: "loading-investigation", status: "not-run", detail: undefined }],
    runtimeAssets: undefined,
    repository: {
      requestedModelId: "org/model",
      normalizedModelId: "org/model",
      requestedRevision: "main",
      resolvedRevision: "a".repeat(40),
      apiUrl: "https://huggingface.co/api/models/org/model/revision/main?blobs=true",
      responseUrl: "https://huggingface.co/api/models/org/model/revision/main?blobs=true",
      fileCount: 0,
      files: [],
      pipelineTag: "text-generation",
      libraryName: "transformers",
      metadata: {},
    },
    cache: undefined,
    declarations: {
      normalizedModelId: "org/model",
      resolvedRevision: "a".repeat(40),
      files: [],
      config: { model_type: "llama" },
      modelType: "llama",
      architectures: [],
      autoMap: undefined,
      transformersJsConfig: undefined,
      classCapabilities: [{
        autoClass: "AutoModelForCausalLM",
        supports: supportedClass,
        notEvaluatedReason: undefined,
      }],
    },
    templateBehavior: {
      normalizedModelId: "org/model",
      resolvedRevision: "a".repeat(40),
      tokenizerClass: "FixtureTokenizer",
      declaredChatTemplate: undefined,
      cases: [],
      toolTemplateProvenance: undefined,
    },
    modelFilePlan: {
      normalizedModelId: "org/model",
      resolvedRevision: "a".repeat(40),
      modelType: "llama",
      registrySource: "ModelRegistry.get_model_files",
      cacheRevisionProvenance: "not-observed",
      cacheRevisionProvenanceReason: "Fixture cache was not observed",
      candidates,
    },
    loadAttempts: [],
    productionLane: { status: "not-run", observation: undefined, error: undefined },
    laneComparison: undefined,
    error: undefined,
  };

}

function attempt({ candidatePlan, status }: {
  candidatePlan: ModelSupportInvestigationCandidateFilePlan,
  status: "passed" | "failed",
}): ModelSupportInvestigationLoadAttempt {
  return {
    attemptId: `attempt-${candidatePlan.candidateId}`,
    candidateId: candidatePlan.candidateId,
    device: candidatePlan.device,
    dtype: candidatePlan.dtype,
    autoClass: "AutoModelForCausalLM",
    resolvedRevision: "a".repeat(40),
    startedAt: "before",
    completedAt: "after",
    status,
    failureStage: status === "passed" ? undefined : "model-load",
    events: [],
    inputTokenCount: undefined,
    inputTokenIds: [],
    inputTensors: [],
    loadedModel: undefined,
    generatedTokenIds: status === "passed" ? [42] : [],
    generatedText: status === "passed" ? "answer" : undefined,
    naturalGeneration: undefined,
    toolProtocolProbe: undefined,
    modelType: "llama",
    error: undefined,
  };
}

describe("runModelLoadInvestigation", () => {
  it("uses a fresh attempt callback for each candidate and stops after success", async () => {
    const runAttempt = vi.fn(async ({ candidate: candidatePlan }: { candidate: ModelSupportInvestigationCandidateFilePlan }) => (
      attempt({ candidatePlan, status: candidatePlan.candidateId === "webgpu-q4" ? "passed" : "failed" })
    ));
    const result = await runModelLoadInvestigation({
      partialRun: run(),
      runAttempt,
      onEvent: vi.fn(),
      now: () => "after",
      createAttemptId: () => "unexpected",
    });

    expect(runAttempt.mock.calls.map(call => call[0].candidate.candidateId)).toEqual([
      "webgpu-q4f16",
      "webgpu-q4",
    ]);
    expect(result.loadAttempts).toHaveLength(2);
    expect(result.steps.find(step => step.id === "loading-investigation")?.status).toBe("passed");
    expect(result.currentOperation).toBe("Minimum real-model generation evidence collected");
  });

  it("blocks without invoking a Worker when no generative class is supported", async () => {
    const runAttempt = vi.fn();
    const result = await runModelLoadInvestigation({
      partialRun: run({ supportedClass: false }),
      runAttempt,
      onEvent: vi.fn(),
      now: () => "after",
      createAttemptId: () => "unexpected",
    });

    expect(runAttempt).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.steps.find(step => step.id === "loading-investigation")?.status).toBe("blocked");
  });

  it("records an unexpected fresh Worker failure and continues to the next candidate", async () => {
    const plans = [candidate("webgpu-q4f16"), candidate("webgpu-q4")];
    const runAttempt = vi.fn()
      .mockRejectedValueOnce(new Error("Worker import failed"))
      .mockResolvedValueOnce(attempt({ candidatePlan: plans[1]!, status: "passed" }));
    const result = await runModelLoadInvestigation({
      partialRun: run({ candidates: plans }),
      runAttempt,
      onEvent: vi.fn(),
      now: () => "after",
      createAttemptId: () => "coordinator-attempt",
    });

    expect(result.loadAttempts[0]).toMatchObject({
      attemptId: "coordinator-attempt",
      candidateId: "webgpu-q4f16",
      failureStage: "worker-start",
      error: { message: "Worker import failed" },
    });
    expect(result.loadAttempts[1]?.status).toBe("passed");
  });

  it("still investigates model loading when template evidence is unavailable", async () => {
    const partialRun = run();
    partialRun.templateBehavior = undefined;
    const loadedAttempt = {
      ...attempt({ candidatePlan: partialRun.modelFilePlan!.candidates[0]!, status: "failed" }),
      failureStage: "input-build" as const,
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
      error: { name: "TemplateInputUnavailableError", message: "missing template input", stack: undefined },
    };
    const runAttempt = vi.fn().mockResolvedValue(loadedAttempt);

    const result = await runModelLoadInvestigation({
      partialRun,
      runAttempt,
      onEvent: vi.fn(),
      now: () => "after",
      createAttemptId: () => "unexpected",
    });

    expect(runAttempt).toHaveBeenCalledOnce();
    expect(result.loadAttempts).toHaveLength(1);
    expect(result.loadAttempts[0]?.loadedModel).toBeDefined();
    expect(result.currentOperation).toBe("Model load attempts completed without a successful minimum generation");
    expect(result.steps.find(step => step.id === "loading-investigation")?.detail)
      .toContain("loaded successfully, but deterministic generation input was unavailable");
  });
});
