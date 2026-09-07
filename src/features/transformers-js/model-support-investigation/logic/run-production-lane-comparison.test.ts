import { describe, expect, it, vi } from "vitest";
import { runProductionLaneComparison } from "@/features/transformers-js/model-support-investigation/logic/run-production-lane-comparison";
import type { ModelSupportInvestigationRun } from "@/features/transformers-js/model-support-investigation/types";
import type { TransformersJsProductionInvestigationObservation } from "@/features/transformers-js/types";

const baseRun = {
  scope: "partial-runtime-repository-cache-declarations-template-model-files-load",
  status: "passed",
  completedAt: "before",
  currentOperation: "reference complete",
  error: undefined,
  steps: [
    { id: "runtime-assets", status: "passed", detail: "runtime passed" },
    { id: "lane-comparison", status: "not-run", detail: undefined },
  ],
  repository: { normalizedModelId: "org/model", resolvedRevision: "a".repeat(40) },
  templateBehavior: {
    cases: [{
      caseId: "user-generation",
      status: "passed",
      messages: [{ role: "user", content: "hello" }],
    }],
  },
  loadAttempts: [{
    attemptId: "attempt-1",
    candidateId: "webgpu-q4",
    device: "webgpu",
    dtype: "q4",
    status: "passed",
    inputTokenIds: [1, 2],
    generatedTokenIds: [3],
  }],
  productionLane: { status: "not-run", observation: undefined, partialObservation: undefined, error: undefined },
  laneComparison: undefined,
} as ModelSupportInvestigationRun;

const productionObservation: TransformersJsProductionInvestigationObservation = {
  modelId: "org/model",
  resolvedRevision: "a".repeat(40),
  candidate: { device: "webgpu", dtype: "q4" },
  route: {
    autoClass: "AutoModelForCausalLM",
    processor: "tokenizer",
    strategy: "standard",
    modelType: "example",
  },
  isEncoderDecoder: false,
  firstTurn: {
    status: "passed",
    turn: {
      messages: [{ role: "user", content: "hello" }],
      inputKeys: ["input_ids"],
      inputTensors: [],
      inputTokenIds: [1, 2],
      fullConversationInput: { status: "unavailable", reason: "test fixture does not observe reconstructed full conversation input" },
      cacheDecision: { status: "unavailable", reason: "test fixture does not observe cache decision" },
      pastKeyValuesProvided: false,
      inputPastKeyValuesSummary: { kind: "nullish", valueType: "undefined", constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
      outputPastKeyValuesSummary: { kind: "object", valueType: "object", constructorName: "Object", ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
      generatedSequenceTokenIds: [1, 2, 4],
      generatedTokenIds: [4],
      generatedText: "answer",
      streamChunks: ["answer"],
      toolCalls: [],
      effectiveGenerationConfig: { maxNewTokens: 16, temperature: 0, topP: 1, doSample: false },
    },
  },
  continuity: {
    status: "failed",
    assistantMessage: { role: "assistant", content: "answer" },
    followUpMessage: { role: "user", content: "Continue." },
    error: { name: "FixtureError", message: "not exercised" },
  },
  toolResultContinuation: { status: "not-run", reason: "not requested" },
  reasoning: { status: "unavailable", reason: "not a Qwen3.5 Production strategy" },
  multimodal: { status: "unavailable", strategy: "standard", reason: "standard Production strategy has no image processor" },
};

describe("runProductionLaneComparison", () => {
  it("still probes Production when Runtime Integrity Preflight failed", async () => {
    const run = structuredClone(baseRun);
    run.steps = run.steps.map(step => (
      step.id === "runtime-assets" ? { ...step, status: "failed", detail: "runtime failed" } : step
    ));
    run.status = "failed";
    run.error = "runtime failed";
    const runProductionScenario = vi.fn(async () => productionObservation);
    const result = await runProductionLaneComparison({
      run,
      runProductionScenario,
      onEvent: vi.fn(),
      now: () => "after",
    });

    expect(runProductionScenario).toHaveBeenCalledOnce();
    expect(result.steps.find(step => step.id === "runtime-assets")?.status).toBe("failed");
    expect(result.steps.find(step => step.id === "lane-comparison")?.status).toBe("passed");
    expect(result.productionLane.status).toBe("passed");
    expect(result.status).toBe("failed");
    expect(result.error).toBe("runtime failed");
  });

  it("reports the exact missing prerequisites when Production Lane has no candidate", async () => {
    const run = structuredClone(baseRun);
    run.templateBehavior = undefined;
    run.loadAttempts = [];
    const result = await runProductionLaneComparison({
      run,
      runProductionScenario: vi.fn(),
      onEvent: vi.fn(),
      now: () => "after",
    });

    expect(result.steps.find(step => step.id === "lane-comparison")?.detail).toContain("eligible Production Lane candidate");
    expect(result.steps.find(step => step.id === "lane-comparison")?.detail).not.toContain("resolved repository revision");
  });

  it("collects Production evidence even when Reference generation failed", async () => {
    const run = structuredClone(baseRun);
    run.status = "failed";
    run.loadAttempts[0]!.status = "failed";
    run.loadAttempts[0]!.failureStage = "first-generation";
    run.loadAttempts[0]!.loadedModel = { modelType: "example" } as never;
    const runProductionScenario = vi.fn().mockResolvedValue(productionObservation);

    const result = await runProductionLaneComparison({
      run,
      runProductionScenario,
      onEvent: vi.fn(),
      now: () => "after",
    });

    expect(result.status).toBe("failed");
    expect(result.productionLane.status).toBe("passed");
    expect(result.laneComparison).toBeUndefined();
    expect(runProductionScenario).toHaveBeenCalledOnce();
    expect(result.currentOperation).toContain("Production Lane evidence collected");
  });
  it("compares observed Reference and Production inputs even when the earlier template probe was marked failed", async () => {
    const run = structuredClone(baseRun);
    const userGenerationCase = run.templateBehavior?.cases.find(item => item.caseId === "user-generation");
    if (userGenerationCase === undefined) throw new Error("Expected a user-generation template fixture");
    userGenerationCase.status = "failed";
    userGenerationCase.inputIds = undefined;
    userGenerationCase.failureStage = "tokenize";
    userGenerationCase.error = {
      name: "Error",
      message: "earlier tokenizer probe failed",
      stack: undefined,
    };

    const result = await runProductionLaneComparison({
      run,
      runProductionScenario: vi.fn().mockResolvedValue(productionObservation),
      onEvent: vi.fn(),
      now: () => "after",
    });

    expect(result.productionLane.status).toBe("passed");
    expect(result.laneComparison).toMatchObject({
      exactInputMatch: true,
      referenceInputTokenIds: [1, 2],
      productionInputTokenIds: [1, 2],
    });
  });

  it("does not compare plain-text Reference input against Production chat input", async () => {
    const run = structuredClone(baseRun);
    run.loadAttempts[0]!.selectedInputStrategy = "fixed-plain-text-tokenizer-tensor-dict";
    run.loadAttempts[0]!.inputTokenIds = [99];

    const result = await runProductionLaneComparison({
      run,
      runProductionScenario: vi.fn().mockResolvedValue(productionObservation),
      onEvent: vi.fn(),
      now: () => "after",
    });

    expect(result.productionLane.status).toBe("passed");
    expect(result.laneComparison).toBeUndefined();
    expect(result.currentOperation).toContain("Reference comparison unavailable");
  });

  it("records a passed Production Lane and exact token comparison", async () => {
    const onEvent = vi.fn();
    const runProductionScenario = vi.fn().mockResolvedValue(productionObservation);
    const result = await runProductionLaneComparison({
      run: structuredClone(baseRun),
      runProductionScenario,
      onEvent,
      now: () => "after",
    });
    expect(result.productionLane.status).toBe("passed");
    expect(runProductionScenario).toHaveBeenCalledWith({
      scenario: expect.objectContaining({
        toolResultContinuation: undefined,
        multimodalFixture: expect.objectContaining({
          fixtureId: "single-transparent-pixel-png-v1",
          mimeType: "image/png",
          byteLength: 68,
          maxNewTokens: 1,
        }),
      }),
      onObservationCheckpoint: expect.any(Function),
    });
    expect(result.laneComparison).toMatchObject({ exactInputMatch: true });
    expect(result.steps.find(step => step.id === "lane-comparison")).toMatchObject({ status: "passed" });
    expect(onEvent).toHaveBeenLastCalledWith({ event: expect.objectContaining({ stepId: "lane-comparison", status: "passed" }) });
  });

  it("keeps a first-turn Production failure as partial observation and skips only the lane comparison", async () => {
    const observation = structuredClone(productionObservation);
    observation.firstTurn = {
      status: "failed",
      error: { name: "FixtureFirstTurnError", message: "first turn failed" },
    };
    observation.continuity = { status: "not-run", reason: "First Production turn failed" };
    observation.reasoning = {
      status: "observed",
      source: "existing-production-strategy",
      strategy: "qwen3_5",
      disabledEffort: "none",
      enabledEffort: "high",
      disabledTurn: { inputTokenIds: [7, 0] } as never,
      enabledTurn: { inputTokenIds: [7, 1] } as never,
      inputTokenExactMatch: false,
      firstInputMismatchIndex: 1,
    };

    const result = await runProductionLaneComparison({
      run: structuredClone(baseRun),
      runProductionScenario: vi.fn().mockResolvedValue(observation),
      onEvent: vi.fn(),
      now: () => "after",
    });

    expect(result.productionLane).toMatchObject({
      status: "passed",
      observation: {
        firstTurn: { status: "failed", error: { message: "first turn failed" } },
        continuity: { status: "not-run" },
        reasoning: { status: "observed" },
      },
    });
    expect(result.laneComparison).toBeUndefined();
    expect(result.currentOperation).toContain("partial evidence after first-turn failure");
    expect(result.steps.find(step => step.id === "lane-comparison")?.detail).toContain("independent Production probes continued");
  });

  it("keeps Reference evidence and records a Production Lane error", async () => {
    const result = await runProductionLaneComparison({
      run: structuredClone(baseRun),
      runProductionScenario: vi.fn().mockRejectedValue(new Error("production failed")),
      onEvent: vi.fn(),
      now: () => "after",
    });
    expect(result.productionLane).toMatchObject({ status: "failed", error: { message: "production failed" } });
    expect(result.loadAttempts).toHaveLength(1);
    expect(result.laneComparison).toBeUndefined();
  });
  it("passes recognized Reference parser roundtrip evidence into Production continuation", async () => {
    const run = structuredClone(baseRun);
    run.loadAttempts[0]!.toolProtocolProbe = {
      status: "observed",
      forced: true,
      source: "chat-template-render",
      generationCaseId: "tools-generation",
      assistantToolCallCaseId: "assistant-tool-call-history",
      toolResultContinuationCaseId: "tool-result-continuation",
      inputTokenIds: [1],
      forcedTokenIds: [2],
      generatedTokenIds: [2],
      generatedText: "tool call",
      exactMatch: true,
      firstMismatchIndex: undefined,
      termination: "complete-forced-sequence",
      parserObservation: {
        status: "observed",
        strategy: "standard",
        parserKind: "standard-tool-call-stream-parser",
        inputMode: "production-text-streamer-reconstruction",
        inputChunks: ["tool call"],
        visibleText: "",
        callBoundaryCount: undefined,
        toolCalls: [{ name: "lookup_weather", arguments: '{"city":"Tokyo"}' }],
        recognized: true,
      },
      toolResultTemplateRoundTrip: {
        status: "observed",
        source: "recognized-production-parser-and-chat-template",
        parserStrategy: "standard",
        toolCall: { name: "lookup_weather", arguments: '{"city":"Tokyo"}' },
        toolResultContent: '{"temperatureC":20,"condition":"clear"}',
        selectedTemplate: "template",
        renderedText: "rendered",
        inputTokenIds: [50, 51, 52],
      },
    };
    const runProductionScenario = vi.fn().mockResolvedValue(productionObservation);

    await runProductionLaneComparison({
      run,
      runProductionScenario,
      onEvent: vi.fn(),
      now: () => "after",
    });

    expect(runProductionScenario).toHaveBeenCalledWith({
      scenario: expect.objectContaining({
        toolResultContinuation: {
          toolCall: { name: "lookup_weather", arguments: '{"city":"Tokyo"}' },
          toolResultContent: '{"temperatureC":20,"condition":"clear"}',
          expectedInputTokenIds: [50, 51, 52],
          maxNewTokens: 16,
        },
      }),
      onObservationCheckpoint: expect.any(Function),
    });
  });

});
